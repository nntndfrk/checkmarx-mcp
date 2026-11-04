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
    scaResolver: {
      version: "2.12.23",
      image: "node:24.16.0-bookworm",
      platform: "linux/amd64",
      timeoutMs: 600_000,
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
    function finding(id: number, type: string) {
      return { id: `f-${id}`, type, severity: "HIGH" };
    }

    /** Serves `total` results in pages of `pageSize`, reading `offset` as a page index. */
    function mockResults(results: unknown[], pageSize: number) {
      const urls: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        urls.push(String(url));
        const page = Number(new URL(String(url)).searchParams.get("offset"));
        const body = {
          totalCount: results.length,
          results: results.slice(page * pageSize, (page + 1) * pageSize),
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch;
      return urls;
    }

    it("sends server-side filters and pages by page index", async () => {
      const urls = mockResults([], 10_000);

      const client = createClient();
      await client.getFindings({
        scanId: "scan-1",
        severity: ["HIGH", "CRITICAL"],
        state: ["TO_VERIFY"],
        type: ["sast"],
        limit: 50,
      });

      expect(urls).toHaveLength(1);
      const params = new URL(urls[0] ?? "").searchParams;
      expect(params.get("scan-id")).toBe("scan-1");
      expect(params.get("severity")).toBe("HIGH,CRITICAL");
      expect(params.get("state")).toBe("TO_VERIFY");
      expect(params.get("limit")).toBe("10000");
      expect(params.get("offset")).toBe("0");
      expect(params.get("sort")).toBe("-severity");
      expect(params.has("type")).toBe(false);
      expect(params.has("exclude-result-types")).toBe(false);
    });

    it("filters by type on the client and recounts totalCount", async () => {
      mockResults(
        [finding(1, "sast"), finding(2, "sca"), finding(3, "sast"), finding(4, "kics")],
        10_000,
      );

      const client = createClient();
      const result = await client.getFindings({ scanId: "scan-1", type: ["sast"] });

      expect(result.totalCount).toBe(2);
      expect(result.items.map((f) => f.id)).toEqual(["f-1", "f-3"]);
    });

    it("applies offset and limit as item positions across pages", async () => {
      const results = Array.from({ length: 10_005 }, (_, i) => finding(i, "sca"));
      const urls = mockResults(results, 10_000);

      const client = createClient();
      const result = await client.getFindings({ scanId: "scan-1", offset: 9_998, limit: 5 });

      expect(urls.map((u) => new URL(u).searchParams.get("offset"))).toEqual(["0", "1"]);
      expect(result.totalCount).toBe(10_005);
      expect(result.items.map((f) => f.id)).toEqual([
        "f-9998",
        "f-9999",
        "f-10000",
        "f-10001",
        "f-10002",
      ]);
    });

    it("excludes dev and test dependencies when asked", async () => {
      const urls = mockResults([], 10_000);

      const client = createClient();
      await client.getFindings({ scanId: "scan-1", hideDevAndTestDependencies: true });

      expect(urls[0]).toContain("exclude-result-types=DEV_AND_TEST");
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

    it("sends no sca value when sca and containers are co-requested, like cx", async () => {
      const config = await captureConfig(["sast", "sca", "containers"]);
      expect(config).toEqual([
        { type: "sast", value: {} },
        { type: "sca", value: {} },
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
    it("returns the first scansSummaries entry", async () => {
      let capturedUrl = "";
      const summaryResponse = {
        scansSummaries: [
          { scanId: "scan-1", sastCounters: { totalCounter: 5, severityCounters: [] } },
        ],
        totalCount: 1,
      };

      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify(summaryResponse), { status: 200 });
      }) as typeof fetch;

      const client = createClient();
      const summary = await client.getFindingSummary("scan-1");

      expect(capturedUrl).toContain("scan-ids=scan-1");
      expect(summary.scanId).toBe("scan-1");
      expect(summary.sastCounters?.totalCounter).toBe(5);
    });

    it("throws when the scan has no summary", async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ scansSummaries: [], totalCount: 0 }), { status: 200 }),
      ) as typeof fetch;

      const client = createClient();
      await expect(client.getFindingSummary("scan-1")).rejects.toThrow("No summary found");
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

    it("sends only the scan settings that were given", async () => {
      let scanBody: Record<string, unknown> = {};
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/uploads")) {
          return new Response(JSON.stringify({ url: "https://storage.example.com/presigned" }), {
            status: 200,
          });
        }
        if (urlStr.includes("storage.example.com")) {
          return new Response(null, { status: 200 });
        }
        if (typeof init?.body === "string") scanBody = JSON.parse(init.body);
        return new Response(JSON.stringify(mockScanResponse.scans[0]), { status: 200 });
      }) as typeof fetch;

      const client = createClient({ projectId: "proj-1" });
      await client.createScanFromUpload({
        zipBuffer: Buffer.from("fake-zip-data"),
        scanTypes: ["sast", "sca", "kics", "containers"],
        settings: {
          sastFilter: "!*.spec.ts",
          presetName: "ASA Premium",
          incremental: false,
          kicsFilter: "!charts",
        },
      });

      expect(scanBody.config).toEqual([
        {
          type: "sast",
          value: { filter: "!*.spec.ts", presetName: "ASA Premium", incremental: "false" },
        },
        { type: "sca", value: {} },
        { type: "kics", value: { filter: "!charts" } },
        { type: "containers", value: {} },
      ]);
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
