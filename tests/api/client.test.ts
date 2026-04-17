import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckmarxAuth } from "../../src/api/auth.js";
import { CheckmarxClient, CheckmarxRequestError } from "../../src/api/client.js";
import type { Config } from "../../src/config.js";
import { Logger } from "../../src/logger.js";

function makeConfig(overrides: Partial<Config["checkmarx"]> = {}): Config {
  return {
    checkmarx: {
      apiKey: "test-api-key",
      tenant: "test-tenant",
      baseUrl: "https://ast.checkmarx.net",
      iamUrl: "https://iam.checkmarx.net",
      ...overrides,
    },
    transport: "stdio",
    port: 3000,
  };
}

class MockAuth {
  token = "mock-access-token";
  async getToken() {
    return this.token;
  }
  invalidateToken() {}
}

const mockProjectResponse = {
  totalCount: 2,
  filteredTotalCount: 2,
  projects: [
    {
      id: "proj-1",
      name: "my-app",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-06-01T00:00:00Z",
      groups: ["group-1"],
      tags: {},
      repoUrl: "https://github.com/org/my-app",
      mainBranch: "main",
      criticality: 3,
    },
    {
      id: "proj-2",
      name: "backend-service",
      createdAt: "2024-02-01T00:00:00Z",
      updatedAt: "2024-06-15T00:00:00Z",
      groups: [],
      tags: { env: "production" },
      criticality: 5,
    },
  ],
};

const mockScanResponse = {
  totalCount: 1,
  filteredTotalCount: 1,
  scans: [
    {
      id: "scan-1",
      status: "Completed",
      statusDetails: [{ name: "sast", status: "Completed" }],
      projectId: "proj-1",
      branch: "main",
      createdAt: "2024-06-01T00:00:00Z",
      updatedAt: "2024-06-01T00:30:00Z",
      engines: ["sast", "sca"],
      sourceType: "git",
      sourceOrigin: "GitHub",
      initiator: "user@example.com",
      tags: {},
    },
  ],
};

describe("CheckmarxClient", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockAuth: MockAuth;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockAuth = new MockAuth();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const silentLogger = new Logger("error");

  function createClient(configOverrides: Partial<Config["checkmarx"]> = {}) {
    return new CheckmarxClient(
      makeConfig(configOverrides),
      mockAuth as unknown as CheckmarxAuth,
      silentLogger,
    );
  }

  describe("request mechanics", () => {
    it("injects Authorization header", async () => {
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {})) as Record<
          string,
          string
        >;
        return new Response(JSON.stringify(mockProjectResponse), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      await client.listProjects();

      expect(capturedHeaders.Authorization).toBe("Bearer mock-access-token");
    });

    it("retries on 5xx with delay", async () => {
      let callCount = 0;

      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("Server Error", { status: 500 });
        }
        return new Response(JSON.stringify(mockProjectResponse), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      const result = await client.listProjects();

      expect(callCount).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it("retries on 429 with Retry-After header", async () => {
      let callCount = 0;

      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("Rate limited", {
            status: 429,
            headers: { "Retry-After": "1" },
          });
        }
        return new Response(JSON.stringify(mockProjectResponse), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      const result = await client.listProjects();

      expect(callCount).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it("throws CheckmarxRequestError on 4xx", async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ code: 404, message: "Project not found" }), {
          status: 404,
        });
      }) as typeof fetch;

      const client = createClient();

      try {
        await client.getProject("nonexistent");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CheckmarxRequestError);
        const reqError = error as CheckmarxRequestError;
        expect(reqError.statusCode).toBe(404);
        expect(reqError.apiError.message).toBe("Project not found");
        expect(reqError.method).toBe("GET");
      }
    });

    it("throws on persistent 5xx after retry", async () => {
      let callCount = 0;

      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response("Server Error", { status: 502 });
      }) as typeof fetch;

      const client = createClient();

      try {
        await client.listProjects();
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CheckmarxRequestError);
        expect((error as CheckmarxRequestError).statusCode).toBe(502);
        expect(callCount).toBe(2);
      }
    });

    it("throws on persistent 429 after retry", async () => {
      let callCount = 0;

      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response("Rate limited", { status: 429 });
      }) as typeof fetch;

      const client = createClient();

      try {
        await client.listProjects();
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CheckmarxRequestError);
        expect((error as CheckmarxRequestError).statusCode).toBe(429);
        expect(callCount).toBe(2);
      }
    });

    it("handles 4xx with non-JSON response body", async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response("<html>Not Found</html>", {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "text/html" },
        });
      }) as typeof fetch;

      const client = createClient();

      try {
        await client.getProject("bad-id");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CheckmarxRequestError);
        const reqError = error as CheckmarxRequestError;
        expect(reqError.statusCode).toBe(404);
        expect(reqError.apiError.message).toBe("Not Found");
      }
    });

    it("throws on network failure", async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch;

      const client = createClient();

      await expect(client.listProjects()).rejects.toThrow("Checkmarx API request failed");
    });
  });

  describe("resolveProjectId", () => {
    it("uses explicit ID when provided", () => {
      const client = createClient({ projectId: "default-proj" });
      expect(client.resolveProjectId("explicit-proj")).toBe("explicit-proj");
    });

    it("falls back to default project ID", () => {
      const client = createClient({ projectId: "default-proj" });
      expect(client.resolveProjectId()).toBe("default-proj");
    });

    it("throws when no project ID available", () => {
      const client = createClient();
      expect(() => client.resolveProjectId()).toThrow("No project ID provided");
    });
  });

  describe("healthCheck", () => {
    it("returns ok on successful API call", async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify(mockProjectResponse), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      const result = await client.healthCheck();

      expect(result.ok).toBe(true);
      expect(result.message).toBe("Connected to Checkmarx One");
    });

    it("returns not ok on API failure", async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError("Network error");
      }) as typeof fetch;

      const client = createClient();
      const result = await client.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Health check failed");
    });
  });

  describe("listProjects", () => {
    it("sends correct query parameters", async () => {
      let capturedUrl = "";

      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify(mockProjectResponse), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      await client.listProjects({ name: "my-app", limit: 5, offset: 10 });

      expect(capturedUrl).toContain("name=my-app");
      expect(capturedUrl).toContain("limit=5");
      expect(capturedUrl).toContain("offset=10");
    });

    it("uses default limit and offset", async () => {
      let capturedUrl = "";

      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify(mockProjectResponse), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      await client.listProjects();

      expect(capturedUrl).toContain("limit=10");
      expect(capturedUrl).toContain("offset=0");
    });
  });

  describe("listScans", () => {
    it("sends project-id and statuses filters", async () => {
      let capturedUrl = "";

      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify(mockScanResponse), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      await client.listScans({
        projectId: "proj-1",
        statuses: ["Completed", "Running"],
        limit: 5,
      });

      expect(capturedUrl).toContain("project-id=proj-1");
      expect(capturedUrl).toContain("statuses=Completed%2CRunning");
      expect(capturedUrl).toContain("limit=5");
    });
  });

  describe("getFindings", () => {
    it("sends scan-id and filter params", async () => {
      let capturedUrl = "";
      const emptyResults = { totalCount: 0, filteredTotalCount: 0, results: [] };

      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify(emptyResults), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      await client.getFindings({
        scanId: "scan-1",
        severity: ["HIGH", "CRITICAL"],
        type: ["sast"],
        limit: 50,
      });

      expect(capturedUrl).toContain("scan-id=scan-1");
      expect(capturedUrl).toContain("severity=HIGH%2CCRITICAL");
      expect(capturedUrl).toContain("type=sast");
      expect(capturedUrl).toContain("limit=50");
      expect(capturedUrl).toContain("sort=-severity");
    });
  });

  describe("createScanFromGit", () => {
    it("sends correct scan request body", async () => {
      let capturedBody: Record<string, unknown> = {};

      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.body) capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify(mockScanResponse.scans[0]), { status: 200 });
      }) as typeof fetch;

      const client = createClient({ projectId: "proj-1" });
      await client.createScanFromGit({
        repoUrl: "https://github.com/org/repo",
        branch: "main",
        scanTypes: ["sast", "sca"],
      });

      expect(capturedBody.type).toBe("git");
      expect(capturedBody.project).toEqual({ id: "proj-1" });
      expect(capturedBody.handler).toEqual({
        repoUrl: "https://github.com/org/repo",
        branch: "main",
      });
      expect(capturedBody.config).toEqual([
        { type: "sast", value: {} },
        { type: "sca", value: {} },
      ]);
    });
  });

  describe("buildScanConfig (via createScanFromGit)", () => {
    async function captureConfig(
      scanTypes: import("../../src/api/types.js").ScanType[] | undefined,
    ) {
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.body) capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify(mockScanResponse.scans[0]), { status: 200 });
      }) as typeof fetch;

      const client = createClient({ projectId: "proj-1" });
      await client.createScanFromGit({
        repoUrl: "https://github.com/org/repo",
        branch: "main",
        scanTypes,
      });
      return capturedBody.config;
    }

    it("defaults to sast, sca, kics when scanTypes is undefined", async () => {
      const config = await captureConfig(undefined);
      expect(config).toEqual([
        { type: "sast", value: {} },
        { type: "sca", value: {} },
        { type: "kics", value: {} },
      ]);
    });

    it("keeps sca-only request unchanged", async () => {
      const config = await captureConfig(["sca"]);
      expect(config).toEqual([{ type: "sca", value: {} }]);
    });

    it("keeps containers-only request unchanged", async () => {
      const config = await captureConfig(["containers"]);
      expect(config).toEqual([{ type: "containers", value: {} }]);
    });

    it("injects enableContainersScan=false when sca and containers co-requested", async () => {
      const config = await captureConfig(["sca", "containers"]);
      expect(config).toEqual([
        { type: "sca", value: { enableContainersScan: "false" } },
        { type: "containers", value: {} },
      ]);
    });

    it("applies sca override with sast + sca + containers", async () => {
      const config = await captureConfig(["sast", "sca", "containers"]);
      expect(config).toEqual([
        { type: "sast", value: {} },
        { type: "sca", value: { enableContainersScan: "false" } },
        { type: "containers", value: {} },
      ]);
    });
  });

  describe("getScan", () => {
    it("fetches a single scan by ID", async () => {
      let capturedUrl = "";

      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify(mockScanResponse.scans[0]), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      const scan = await client.getScan("scan-1");

      expect(capturedUrl).toContain("/api/scans/scan-1");
      expect(scan.id).toBe("scan-1");
      expect(scan.status).toBe("Completed");
    });
  });

  describe("getFindingSummary", () => {
    it("fetches summary for a scan", async () => {
      let capturedUrl = "";
      const summaryResponse = {
        scanId: "scan-1",
        totalCounter: 10,
        counters: [{ type: "sast", severity: "HIGH", counter: 5 }],
        statusCounters: [{ status: "NEW", counter: 8 }],
      };

      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify(summaryResponse), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      const summary = await client.getFindingSummary("scan-1");

      expect(capturedUrl).toContain("scan-ids=scan-1");
      expect(summary.totalCounter).toBe(10);
    });
  });

  describe("createScanFromUpload", () => {
    it("orchestrates upload then scan creation", async () => {
      const calls: { url: string; method: string; body?: string }[] = [];

      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        calls.push({ url: urlStr, method, body });

        if (urlStr.includes("/api/uploads")) {
          return new Response(JSON.stringify({ url: "https://storage.example.com/presigned" }), {
            status: 200,
          });
        }
        if (urlStr.includes("storage.example.com")) {
          return new Response(null, { status: 200 });
        }
        if (urlStr.includes("/api/scans")) {
          return new Response(JSON.stringify(mockScanResponse.scans[0]), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const client = createClient({ projectId: "proj-1" });
      const scan = await client.createScanFromUpload({
        zipBuffer: Buffer.from("fake-zip-data"),
        branch: "feature/test",
        scanTypes: ["sast"],
      });

      expect(calls).toHaveLength(3);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url).toContain("/api/uploads");
      expect(calls[1]?.method).toBe("PUT");
      expect(calls[1]?.url).toBe("https://storage.example.com/presigned");
      expect(calls[2]?.method).toBe("POST");
      expect(calls[2]?.url).toContain("/api/scans");

      const scanBody = JSON.parse(calls[2]?.body ?? "");
      expect(scanBody.type).toBe("upload");
      expect(scanBody.handler.uploadUrl).toBe("https://storage.example.com/presigned");
      expect(scanBody.handler.branch).toBe("feature/test");

      expect(scan.id).toBe("scan-1");
    });
  });

  describe("uploadZip", () => {
    it("sends PUT to presigned URL with zip buffer", async () => {
      let capturedMethod = "";
      let capturedUrl = "";

      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedMethod = init?.method ?? "GET";
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      await client.uploadZip("https://storage.example.com/upload?sig=abc", Buffer.from("zip-data"));

      expect(capturedMethod).toBe("PUT");
      expect(capturedUrl).toBe("https://storage.example.com/upload?sig=abc");
    });

    it("throws on upload failure", async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response("Forbidden", { status: 403 });
      }) as typeof fetch;

      const client = createClient();

      await expect(
        client.uploadZip("https://storage.example.com/upload", Buffer.from("zip")),
      ).rejects.toThrow("Upload failed with HTTP 403");
    });
  });
});
