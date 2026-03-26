import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckmarxAuth } from "../../src/api/auth.js";
import type { Config } from "../../src/config.js";
import { Logger } from "../../src/logger.js";

function makeConfig(overrides: Partial<Config["checkmarx"]> = {}): Config {
  return {
    checkmarx: {
      apiKey: "test-refresh-token",
      tenant: "test-tenant",
      baseUrl: "https://ast.checkmarx.net",
      iamUrl: "https://iam.checkmarx.net",
      ...overrides,
    },
    transport: "stdio",
    port: 3000,
  };
}

function tokenResponse(expiresIn = 300) {
  return {
    access_token: `access-token-${Date.now()}`,
    expires_in: expiresIn,
    token_type: "Bearer",
  };
}

const silentLogger = new Logger("error");

describe("CheckmarxAuth", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exchanges API key for access token", async () => {
    const expectedToken = tokenResponse();

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe(
        "https://iam.checkmarx.net/auth/realms/test-tenant/protocol/openid-connect/token",
      );
      expect(init?.method).toBe("POST");

      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("ast-app");
      expect(body.get("refresh_token")).toBe("test-refresh-token");

      return new Response(JSON.stringify(expectedToken), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);
    const token = await auth.getToken();

    expect(token).toBe(expectedToken.access_token);
  });

  it("caches token and reuses within TTL", async () => {
    let callCount = 0;
    const token = tokenResponse(300);

    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return new Response(JSON.stringify(token), { status: 200 });
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    const first = await auth.getToken();
    const second = await auth.getToken();

    expect(first).toBe(second);
    expect(callCount).toBe(1);
  });

  it("refreshes token after expiry", async () => {
    let callCount = 0;

    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return new Response(
        JSON.stringify({ access_token: `token-${callCount}`, expires_in: 1, token_type: "Bearer" }),
        { status: 200 },
      );
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    const first = await auth.getToken();
    expect(first).toBe("token-1");

    // Simulate token expiry by forcing the internal expiry time to the past
    // expires_in=1 means 1 second, minus 60s buffer = already expired
    const second = await auth.getToken();
    expect(second).toBe("token-2");
    expect(callCount).toBe(2);
  });

  it("uses regional IAM URL", async () => {
    let capturedUrl = "";

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(tokenResponse()), { status: 200 });
    }) as typeof fetch;

    const auth = new CheckmarxAuth(
      makeConfig({ iamUrl: "https://eu.iam.checkmarx.net" }),
      silentLogger,
    );
    await auth.getToken();

    expect(capturedUrl.startsWith("https://eu.iam.checkmarx.net/auth/realms/test-tenant/")).toBe(
      true,
    );
  });

  it("strips trailing slashes from IAM URL", async () => {
    let capturedUrl = "";

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(tokenResponse()), { status: 200 });
    }) as typeof fetch;

    const auth = new CheckmarxAuth(
      makeConfig({ iamUrl: "https://iam.checkmarx.net///" }),
      silentLogger,
    );
    await auth.getToken();

    expect(capturedUrl.startsWith("https://iam.checkmarx.net/auth/realms/")).toBe(true);
  });

  it("throws on HTTP 401 with error details", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Token is not active" }),
        { status: 401 },
      );
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    await expect(auth.getToken()).rejects.toThrow("Token is not active");
  });

  it("throws on HTTP 400 with guidance", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: "Invalid client credentials",
        }),
        { status: 400 },
      );
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    await expect(auth.getToken()).rejects.toThrow("Verify CHECKMARX_API_KEY");
  });

  it("throws on network failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    await expect(auth.getToken()).rejects.toThrow("Checkmarx auth request failed: fetch failed");
  });

  it("throws on non-JSON error response", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      });
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    await expect(auth.getToken()).rejects.toThrow("HTTP 500");
  });

  it("deduplicates concurrent refresh calls", async () => {
    let callCount = 0;

    globalThis.fetch = vi.fn(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return new Response(
        JSON.stringify({ access_token: "shared-token", expires_in: 300, token_type: "Bearer" }),
        { status: 200 },
      );
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    const [t1, t2, t3] = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);

    expect(t1).toBe("shared-token");
    expect(t2).toBe("shared-token");
    expect(t3).toBe("shared-token");
    expect(callCount).toBe(1);
  });

  it("throws on empty access_token in response", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ access_token: "", expires_in: 300, token_type: "Bearer" }),
        { status: 200 },
      );
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    await expect(auth.getToken()).rejects.toThrow("empty or missing access_token");
  });

  it("throws on invalid expires_in", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ access_token: "valid-token", expires_in: -1, token_type: "Bearer" }),
        { status: 200 },
      );
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    await expect(auth.getToken()).rejects.toThrow("invalid expires_in");
  });

  it("throws on malformed success JSON", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    await expect(auth.getToken()).rejects.toThrow("invalid JSON in success response");
  });

  it("includes error type in error message", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Token expired" }),
        { status: 400 },
      );
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    await expect(auth.getToken()).rejects.toThrow("invalid_grant: Token expired");
  });

  it("invalidateToken forces refresh on next getToken", async () => {
    let callCount = 0;

    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          access_token: `token-${callCount}`,
          expires_in: 300,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const auth = new CheckmarxAuth(makeConfig(), silentLogger);

    const first = await auth.getToken();
    expect(first).toBe("token-1");
    expect(callCount).toBe(1);

    auth.invalidateToken();

    const second = await auth.getToken();
    expect(second).toBe("token-2");
    expect(callCount).toBe(2);
  });
});
