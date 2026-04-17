import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CheckmarxClient } from "../../src/api/client.js";
import { registerScanTools } from "../../src/tools/scans.js";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "scan-tool-test-"));
  await mkdir(join(testDir, "src"));
  await writeFile(join(testDir, "src", "app.ts"), "export const x = 1;");
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const mockScan = {
  id: "scan-1",
  status: "Completed" as const,
  statusDetails: [
    { name: "sast", status: "Completed" },
    { name: "sca", status: "Completed" },
  ],
  projectId: "proj-1",
  projectName: "my-app",
  branch: "main",
  createdAt: "2024-06-01T00:00:00Z",
  updatedAt: "2024-06-01T00:30:00Z",
  engines: ["sast", "sca"],
  sourceType: "git",
  sourceOrigin: "GitHub",
  initiator: "user@example.com",
  tags: {},
};

function createMockClient(overrides: Partial<CheckmarxClient> = {}): CheckmarxClient {
  return {
    listScans: async () => ({
      totalCount: 1,
      filteredTotalCount: 1,
      items: [mockScan],
    }),
    getScan: async () => mockScan,
    createScanFromGit: async () => ({
      ...mockScan,
      id: "scan-new",
      status: "Queued" as const,
    }),
    createScanFromUpload: async () => ({
      ...mockScan,
      id: "scan-upload",
      status: "Queued" as const,
    }),
    createContainerImageScan: async () => ({
      ...mockScan,
      id: "scan-image",
      status: "Queued" as const,
    }),
    resolveProjectId: (id?: string) => id ?? "default-proj-id",
    ...overrides,
  } as unknown as CheckmarxClient;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK internals for test harness
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler: (args: Record<string, unknown>) => Promise<unknown> }
  >;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.handler(args);
}

describe("Scan Tools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "1.0.0" });
  });

  describe("list_scans", () => {
    it("returns shaped scan list", async () => {
      const client = createMockClient();
      registerScanTools(server, client);

      const result = await callTool(server, "list_scans", { limit: 10, offset: 0 });
      const parsed = JSON.parse(result.content[0]?.text);

      expect(parsed.totalCount).toBe(1);
      expect(parsed.scans).toHaveLength(1);
      expect(parsed.scans[0].id).toBe("scan-1");
      expect(parsed.scans[0].status).toBe("Completed");
      expect(parsed.scans[0].engines).toEqual(["sast", "sca"]);
      expect(parsed.scans[0]).not.toHaveProperty("initiator");
    });

    it("returns error on client failure", async () => {
      const client = createMockClient({
        listScans: async () => {
          throw new Error("Timeout");
        },
      });
      registerScanTools(server, client);

      const result = await callTool(server, "list_scans", { limit: 10, offset: 0 });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Timeout");
    });
  });

  describe("get_scan", () => {
    it("returns full scan object", async () => {
      const client = createMockClient();
      registerScanTools(server, client);

      const result = await callTool(server, "get_scan", {
        scanId: "550e8400-e29b-41d4-a716-446655440000",
      });
      const parsed = JSON.parse(result.content[0]?.text);

      expect(parsed.id).toBe("scan-1");
      expect(parsed.status).toBe("Completed");
    });
  });

  describe("trigger_scan_git", () => {
    it("returns scan ID on success", async () => {
      const client = createMockClient();
      registerScanTools(server, client);

      const result = await callTool(server, "trigger_scan_git", {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        repoUrl: "https://github.com/org/repo",
        branch: "main",
        scanTypes: ["sast", "sca"],
      });
      const parsed = JSON.parse(result.content[0]?.text);

      expect(parsed.scanId).toBe("scan-new");
      expect(parsed.status).toBe("Queued");
      expect(parsed.message).toContain("Scan triggered successfully");
    });

    it("returns error on failure", async () => {
      const client = createMockClient({
        createScanFromGit: async () => {
          throw new Error("No project ID provided");
        },
      });
      registerScanTools(server, client);

      const result = await callTool(server, "trigger_scan_git", {
        repoUrl: "https://github.com/org/repo",
        branch: "main",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("No project ID provided");
    });
  });

  describe("trigger_scan_local", () => {
    it("returns scan ID on success", async () => {
      const client = createMockClient();
      registerScanTools(server, client);

      const result = await callTool(server, "trigger_scan_local", {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        directory: testDir,
        branch: "feature/test",
        scanTypes: ["sast"],
      });
      const parsed = JSON.parse(result.content[0]?.text);

      expect(parsed.scanId).toBe("scan-upload");
      expect(parsed.status).toBe("Queued");
      expect(parsed.message).toContain("Local scan triggered successfully");
      expect(parsed.directory).toBe(testDir);
    });

    it("returns error when zip fails", async () => {
      const client = createMockClient();
      registerScanTools(server, client);

      const result = await callTool(server, "trigger_scan_local", {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        directory: "/nonexistent/path/12345",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Error triggering local scan");
    });

    it("returns error when upload fails", async () => {
      const client = createMockClient({
        createScanFromUpload: async () => {
          throw new Error("Upload quota exceeded");
        },
      });
      registerScanTools(server, client);

      const result = await callTool(server, "trigger_scan_local", {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        directory: testDir,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Upload quota exceeded");
    });

    it("accepts excludePatterns without error", async () => {
      const client = createMockClient();
      registerScanTools(server, client);

      const result = await callTool(server, "trigger_scan_local", {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        directory: testDir,
        excludePatterns: ["**/*.log", "coverage/**"],
      });
      const parsed = JSON.parse(result.content[0]?.text);

      expect(result.isError).toBeUndefined();
      expect(parsed.scanId).toBe("scan-upload");
    });
  });

  describe("trigger_scan_image", () => {
    it("returns scan ID and echoes the image reference", async () => {
      let capturedParams: { projectId?: string; image: string; branch?: string } | undefined;
      const client = createMockClient({
        createContainerImageScan: async (params) => {
          capturedParams = params;
          return {
            ...mockScan,
            id: "scan-image",
            status: "Queued" as const,
          };
        },
      } as Partial<CheckmarxClient>);
      registerScanTools(server, client);

      const result = await callTool(server, "trigger_scan_image", {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        image: "nginx:1.27-alpine-slim",
      });
      const parsed = JSON.parse(result.content[0]?.text);

      expect(result.isError).toBeUndefined();
      expect(parsed.scanId).toBe("scan-image");
      expect(parsed.image).toBe("nginx:1.27-alpine-slim");
      expect(parsed.message).toContain("Container image scan triggered successfully");
      expect(capturedParams?.image).toBe("nginx:1.27-alpine-slim");
    });

    it("surfaces client errors", async () => {
      const client = createMockClient({
        createContainerImageScan: async () => {
          throw new Error("Upload failed with HTTP 403");
        },
      } as Partial<CheckmarxClient>);
      registerScanTools(server, client);

      const result = await callTool(server, "trigger_scan_image", {
        image: "nginx:latest",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Upload failed");
    });
  });
});
