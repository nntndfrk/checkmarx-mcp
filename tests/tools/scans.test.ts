import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CheckmarxClient } from "../../src/api/client.js";
import { registerScanTools } from "../../src/tools/scans.js";
import {
  type ResolveOptions,
  type ScaResolution,
  type ScaResolver,
  ScaResolverError,
} from "../../src/utils/sca-resolver.js";
import { zipEntries } from "../helpers/zip-entries.js";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "scan-tool-test-"));
  await mkdir(join(testDir, "src"));
  await writeFile(join(testDir, "src", "app.ts"), "export const x = 1;");
  await writeFile(join(testDir, "package.json"), "{}");
  await writeFile(join(testDir, "package-lock.json"), "{}");
  await writeFile(join(testDir, "README.md"), "# app");
  await mkdir(join(testDir, "node_modules", "dep"), { recursive: true });
  await writeFile(join(testDir, "node_modules", "dep", "package.json"), "{}");
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

    it("passes scan settings to the client", async () => {
      let captured: Record<string, unknown> = {};
      const client = createMockClient({
        createScanFromUpload: async (params: Record<string, unknown>) => {
          captured = params;
          return { ...mockScan, id: "scan-upload", status: "Queued" as const };
        },
      } as Partial<CheckmarxClient>);
      registerScanTools(server, client);

      await callTool(server, "trigger_scan_local", {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        directory: testDir,
        zipMode: "all",
        sastFilter: "!*.spec.ts",
        presetName: "ASA Premium",
        incremental: true,
      });

      expect(captured.settings).toEqual({
        sastFilter: "!*.spec.ts",
        scaFilter: undefined,
        kicsFilter: undefined,
        presetName: "ASA Premium",
        incremental: true,
      });
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

  describe("trigger_scan_local SCA resolution", () => {
    const projectId = "550e8400-e29b-41d4-a716-446655440000";

    interface Captured {
      upload?: { zipBuffer: Buffer };
      resolve?: ResolveOptions;
      stagedFiles?: string[];
    }

    function setup(
      captured: Captured,
      resolve: (options: ResolveOptions) => Promise<ScaResolution> = async (options) => {
        const outputPath = join(options.outDir, "sca.json");
        await mkdir(options.outDir, { recursive: true });
        await writeFile(outputPath, "{}");
        return { outputPath, version: "2.12.23", packageCount: 47 };
      },
      enabled = true,
    ) {
      const client = createMockClient({
        getProject: async (id: string) => ({ ...mockScan, id, name: "my-app" }),
        createScanFromUpload: async (params: { zipBuffer: Buffer }) => {
          captured.upload = params;
          return { ...mockScan, id: "scan-upload", status: "Queued" as const };
        },
      } as unknown as Partial<CheckmarxClient>);
      const resolver = {
        enabled,
        resolve: async (options: ResolveOptions) => {
          captured.resolve = options;
          captured.stagedFiles = await listFiles(options.sourceDir);
          return resolve(options);
        },
      } as unknown as ScaResolver;
      registerScanTools(server, client, resolver);
    }

    async function listFiles(dir: string, prefix = ""): Promise<string[]> {
      const files: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory())
          files.push(...(await listFiles(join(dir, entry.name), `${path}/`)));
        else files.push(path);
      }
      return files.sort();
    }

    it("resolves locally by default and adds .cxsca-results.json at the zip root", async () => {
      const captured: Captured = {};
      setup(captured);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scaResolverParams: "--ignore-dev-dependencies --maven-parameters='-Dscope=runtime'",
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(result.isError).toBeUndefined();
      expect(parsed.scaResolution).toBe("local");
      expect(parsed.scaResolver).toEqual({ version: "2.12.23", packageCount: 47 });
      expect(captured.resolve?.projectName).toBe("my-app");
      expect(captured.resolve?.params).toEqual([
        "--ignore-dev-dependencies",
        "--maven-parameters=-Dscope=runtime",
      ]);
      // The resolver sees the whole tree minus excluded folders, not the cx include list.
      expect(captured.stagedFiles).toEqual([
        "README.md",
        "package-lock.json",
        "package.json",
        "src/app.ts",
      ]);

      const entries = zipEntries(captured.upload?.zipBuffer ?? Buffer.alloc(0));
      expect(entries).toEqual([
        ".cxsca-results.json",
        "package-lock.json",
        "package.json",
        "src/app.ts",
      ]);
      expect(existsSync(dirname(captured.resolve?.sourceDir ?? ""))).toBe(false);
    });

    it("uploads no resolver output for cloud resolution", async () => {
      const captured: Captured = {};
      setup(captured);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scaResolution: "cloud",
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(parsed.scaResolution).toBe("cloud");
      expect(parsed.scaResolver).toBeUndefined();
      expect(captured.resolve).toBeUndefined();
      expect(zipEntries(captured.upload?.zipBuffer ?? Buffer.alloc(0))).not.toContain(
        ".cxsca-results.json",
      );
    });

    it("defaults to cloud when sca is not requested", async () => {
      const captured: Captured = {};
      setup(captured);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scanTypes: ["sast"],
      });

      expect(result.isError).toBeUndefined();
      expect(captured.resolve).toBeUndefined();
    });

    it("defaults to cloud when SCA Resolver is not configured", async () => {
      const captured: Captured = {};
      setup(captured, undefined, false);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(parsed.scaResolution).toBe("cloud");
      expect(captured.resolve).toBeUndefined();
    });

    it("rejects local resolution without SCA Resolver", async () => {
      const captured: Captured = {};
      setup(captured, undefined, false);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scaResolution: "local",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("CHECKMARX_SCA_RESOLVER");
      expect(captured.upload).toBeUndefined();
    });

    it("rejects scaResolverParams for cloud resolution", async () => {
      const captured: Captured = {};
      setup(captured);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scaResolution: "cloud",
        scaResolverParams: "--ignore-dev-dependencies",
      });

      expect(result.isError).toBe(true);
      expect(captured.upload).toBeUndefined();
    });

    for (const [name, error] of [
      ["a non-zero exit", "SCA Resolver failed with exit code 9 (package manager error)"],
      ["a timeout", "SCA Resolver timed out after 600000 ms"],
      ["missing output", "SCA Resolver finished without writing sca.json"],
    ] as const) {
      it(`creates no scan and removes temp dirs on ${name}`, async () => {
        const captured: Captured = {};
        setup(captured, async () => {
          throw new ScaResolverError(error, "last log line");
        });

        const result = await callTool(server, "trigger_scan_local", {
          projectId,
          directory: testDir,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain(error);
        expect(result.content[0]?.text).toContain("last log line");
        expect(captured.upload).toBeUndefined();
        expect(existsSync(dirname(captured.resolve?.sourceDir ?? ""))).toBe(false);
      });
    }
  });
});
