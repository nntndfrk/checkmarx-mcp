import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CheckmarxClient } from "../../src/api/client.js";
import { registerScanTools } from "../../src/tools/scans.js";
import type {
  ContainersResolution,
  ContainersResolveOptions,
  ContainersResolver,
} from "../../src/utils/containers-resolver.js";
import {
  type ResolveOptions,
  type ScaResolution,
  type ScaResolver,
  ScaResolverError,
} from "../../src/utils/sca-resolver.js";
import { createRepo, git } from "../helpers/git-repo.js";
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
    getFeatureFlag: async () => true,
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
        mode: "docker",
        resolve: async (options: ResolveOptions) => {
          captured.resolve = options;
          captured.stagedFiles = await listFiles(options.sourceDir);
          return resolve(options);
        },
      } as unknown as ScaResolver;
      registerScanTools(server, client, { scaResolver: resolver });
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
      expect(parsed.scaResolver).toEqual({
        mode: "docker",
        version: "2.12.23",
        packageCount: 47,
      });
      expect(parsed.warnings).toBeUndefined();
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

    it("resolves locally per call when CHECKMARX_SCA_RESOLVER is not set", async () => {
      const captured: Captured = {};
      setup(captured, undefined, false);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scaResolution: "local",
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(result.isError).toBeUndefined();
      expect(parsed.scaResolution).toBe("local");
      expect(parsed.scaResolver.mode).toBe("docker");
      expect(captured.resolve).toBeDefined();
    });

    it("warns that cloud resolution will not match cx --sca-resolver", async () => {
      const captured: Captured = {};
      setup(captured, undefined, false);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(parsed.scaResolution).toBe("cloud");
      expect(parsed.warnings).toEqual([expect.stringContaining("cx --sca-resolver")]);
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
  describe("trigger_scan_local container resolution", () => {
    const projectId = "550e8400-e29b-41d4-a716-446655440000";
    const resolution: Omit<ContainersResolution, "outputPath"> = {
      versions: { "containers-resolver": "v1.0.11", syft: "v1.21.0" },
      images: [
        { name: "nginx:1.27", origins: ["Dockerfile"], paths: ["Dockerfile"], packageCount: 42 },
      ],
      notAnalyzed: [],
    };

    interface Captured {
      upload?: { zipBuffer: Buffer; scanTypes?: string[] };
      resolve?: ContainersResolveOptions;
      stagedFiles?: string[];
      flagCalls: string[];
      scaResolved?: boolean;
      order: string[];
    }

    function setup(
      captured: Captured,
      options: {
        flag?: boolean | Error;
        enabled?: boolean;
        result?: Omit<ContainersResolution, "outputPath">;
      } = {},
    ) {
      const client = createMockClient({
        getProject: async (id: string) => ({ ...mockScan, id, name: "my-app" }),
        getFeatureFlag: async (name: string) => {
          captured.flagCalls.push(name);
          if (options.flag instanceof Error) throw options.flag;
          return options.flag ?? true;
        },
        createScanFromUpload: async (params: { zipBuffer: Buffer; scanTypes?: string[] }) => {
          captured.upload = params;
          return { ...mockScan, id: "scan-upload", status: "Queued" as const };
        },
      } as unknown as Partial<CheckmarxClient>);
      const containersResolver = {
        enabled: options.enabled ?? true,
        mode: "docker",
        resolve: async (resolveOptions: ContainersResolveOptions) => {
          captured.order.push("containers");
          captured.resolve = resolveOptions;
          captured.stagedFiles = await readdir(resolveOptions.sourceDir, { recursive: true });
          const outputPath = join(resolveOptions.outDir, "containers-resolution.json");
          await mkdir(resolveOptions.outDir, { recursive: true });
          await writeFile(outputPath, "[]");
          return { outputPath, ...(options.result ?? resolution) };
        },
      } as unknown as ContainersResolver;
      const scaResolver = {
        enabled: true,
        mode: "docker",
        resolve: async (resolveOptions: ResolveOptions) => {
          captured.order.push("sca");
          captured.scaResolved = true;
          const outputPath = join(resolveOptions.outDir, "sca.json");
          await mkdir(resolveOptions.outDir, { recursive: true });
          await writeFile(outputPath, "{}");
          return { outputPath, version: "2.12.23", packageCount: 47 };
        },
      } as unknown as ScaResolver;
      registerScanTools(server, client, { scaResolver, containersResolver });
    }

    function newCaptured(): Captured {
      return { flagCalls: [], order: [] };
    }

    it("resolves containers locally and adds the result under .checkmarx/containers", async () => {
      const captured = newCaptured();
      setup(captured);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scanTypes: ["sast", "sca", "containers"],
        containerImages: ["registry.example.com:5000/team/app:1.2.3"],
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(result.isError).toBeUndefined();
      expect(captured.flagCalls).toEqual(["CONTAINER_ENGINE_CLI_ENABLED"]);
      expect(captured.resolve?.images).toEqual(["registry.example.com:5000/team/app:1.2.3"]);
      expect(captured.stagedFiles).not.toContain("node_modules");
      // Containers run first, on the staged copy, then SCA Resolver.
      expect(captured.order).toEqual(["containers", "sca"]);
      expect(parsed.containersResolution).toBe("local");
      expect(parsed.containersResolver).toEqual({ mode: "docker", ...resolution });
      expect(parsed.warnings).toBeUndefined();

      const entries = zipEntries(captured.upload?.zipBuffer ?? Buffer.alloc(0));
      expect(entries).toContain(".checkmarx/containers/containers-resolution.json");
      expect(entries).toContain(".cxsca-results.json");
      expect(entries).toContain("src/app.ts");
      expect(existsSync(dirname(captured.resolve?.sourceDir ?? ""))).toBe(false);
    });

    it("zips only the resolution file when containers is the only scan type", async () => {
      const captured = newCaptured();
      setup(captured);

      await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scanTypes: ["containers"],
      });

      const entries = zipEntries(captured.upload?.zipBuffer ?? Buffer.alloc(0));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^cx-\d+\/containers-resolution\.json$/);
      expect(captured.scaResolved).toBeUndefined();
    });

    it("resolves in the cloud by default when no resolver is configured, and warns", async () => {
      const captured = newCaptured();
      setup(captured, { enabled: false });

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scanTypes: ["sast", "containers"],
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(parsed.containersResolution).toBe("cloud");
      expect(captured.resolve).toBeUndefined();
      expect(parsed.warnings).toEqual([expect.stringContaining("containersResolution 'local'")]);
      expect(zipEntries(captured.upload?.zipBuffer ?? Buffer.alloc(0))).not.toContain(
        ".checkmarx/containers/containers-resolution.json",
      );
    });

    it("containerImages imply local resolution without CHECKMARX_CONTAINERS_RESOLVER", async () => {
      const captured = newCaptured();
      setup(captured, { enabled: false });

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scanTypes: ["containers"],
        containerImages: ["app:1.0"],
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(parsed.containersResolution).toBe("local");
      expect(captured.resolve?.images).toEqual(["app:1.0"]);
    });

    it("falls back to the cloud with a warning when the tenant flag is off", async () => {
      const captured = newCaptured();
      setup(captured, { flag: false });

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scanTypes: ["sast", "containers"],
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(result.isError).toBeUndefined();
      expect(parsed.containersResolution).toBe("cloud");
      expect(captured.resolve).toBeUndefined();
      expect(parsed.warnings).toEqual([
        expect.stringContaining("CONTAINER_ENGINE_CLI_ENABLED is off"),
      ]);
    });

    it("rejects explicit local resolution when the flag can't be read", async () => {
      const captured = newCaptured();
      setup(captured, { flag: new Error("HTTP 403") });

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scanTypes: ["containers"],
        containersResolution: "local",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("could not be read (HTTP 403)");
      expect(captured.upload).toBeUndefined();
    });

    it("warns about images the resolver could not analyse", async () => {
      const captured = newCaptured();
      setup(captured, {
        result: {
          ...resolution,
          notAnalyzed: [{ name: "private.example.com/app:1.0", origins: ["UserInput"], paths: [] }],
        },
      });

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: testDir,
        scanTypes: ["containers"],
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(parsed.warnings).toEqual([expect.stringContaining("private.example.com/app:1.0")]);
    });

    for (const [name, args, error] of [
      [
        "containerImages without containers",
        { scanTypes: ["sast"], containerImages: ["app:1.0"] },
        "containerImages needs 'containers'",
      ],
      [
        "containerImages with cloud resolution",
        { scanTypes: ["containers"], containersResolution: "cloud", containerImages: ["app:1.0"] },
        "only used with containersResolution 'local'",
      ],
      [
        "local resolution without containers",
        { scanTypes: ["sast"], containersResolution: "local" },
        "needs 'containers' in scanTypes",
      ],
    ] as const) {
      it(`rejects ${name}`, async () => {
        const captured = newCaptured();
        setup(captured);

        const result = await callTool(server, "trigger_scan_local", {
          projectId,
          directory: testDir,
          ...args,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain(error);
        expect(captured.upload).toBeUndefined();
      });
    }
  });
  describe("trigger_scan_local gitRef", () => {
    const projectId = "550e8400-e29b-41d4-a716-446655440000";
    let repo: string;

    beforeAll(async () => {
      repo = await createRepo();
    });

    afterAll(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    function setup(captured: { upload?: { zipBuffer: Buffer } }) {
      const client = createMockClient({
        createScanFromUpload: async (params: { zipBuffer: Buffer }) => {
          captured.upload = params;
          return { ...mockScan, id: "scan-upload", status: "Queued" as const };
        },
      } as unknown as Partial<CheckmarxClient>);
      registerScanTools(server, client);
    }

    it("zips the commit plus extraPaths instead of the working tree", async () => {
      const captured: { upload?: { zipBuffer: Buffer } } = {};
      setup(captured);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: join(repo, "app"),
        scanTypes: ["sast"],
        zipMode: "cx",
        gitRef: "HEAD",
        extraPaths: ["dist"],
      });
      const parsed = JSON.parse(result.content[0]?.text ?? "");

      expect(result.isError).toBeUndefined();
      expect(parsed.gitRef).toEqual({ ref: "HEAD", commit: git(repo, "rev-parse", "HEAD") });
      expect(parsed.extraPaths).toEqual(["dist"]);
      expect(zipEntries(captured.upload?.zipBuffer ?? Buffer.alloc(0))).toEqual([
        "dist/bundle.js",
        "export-ignored.ts",
        "src/added.ts",
        "src/main.ts",
      ]);
    });

    it("rejects extraPaths without gitRef", async () => {
      const captured: { upload?: { zipBuffer: Buffer } } = {};
      setup(captured);

      const result = await callTool(server, "trigger_scan_local", {
        projectId,
        directory: join(repo, "app"),
        extraPaths: ["dist"],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("extraPaths needs gitRef");
      expect(captured.upload).toBeUndefined();
    });
  });
});
