import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { CheckmarxClient } from "../../src/api/client.js";
import type { Finding, ScaPackage, Scan } from "../../src/api/types.js";
import { registerCompareTools } from "../../src/tools/compare.js";

const BASE = "11111111-1111-4111-8111-111111111111";
const LOCAL = "22222222-2222-4222-8222-222222222222";

function scan(id: string, engines: string[]): Scan {
  return {
    id,
    status: "Completed",
    statusDetails: [],
    projectId: "proj-1",
    projectName: "my-app",
    branch: id === BASE ? "main" : "main-mcp",
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:10:00Z",
    engines,
    sourceType: "zip",
    sourceOrigin: "cx",
    initiator: "ci",
    tags: {},
  };
}

function sast(similarityId: string, file: string, severity = "LOW"): Finding {
  return {
    type: "sast",
    similarityId,
    severity,
    data: { queryName: "Q", nodes: [{ fileName: file, line: 3 }] },
  } as unknown as Finding;
}

function containers(similarityId: string): Finding {
  return {
    type: "containers",
    similarityId,
    severity: "CRITICAL",
    data: { imageName: "nginx", imageTag: "1.27", packageIdentifier: "openssl-3.0" },
    vulnerabilityDetails: { cveId: "CVE-2026-1" },
  } as unknown as Finding;
}

function pkg(id: string, direct: boolean, dev = false): ScaPackage {
  return { Id: id, IsDirectDependency: direct, IsDevelopmentDependency: dev };
}

interface Data {
  engines: Record<string, string[]>;
  findings: Record<string, Finding[]>;
  packages: Record<string, ScaPackage[] | Error>;
  loc: Record<string, number>;
}

function setup(server: McpServer, data: Data, captured: { hideDev?: boolean[] } = {}) {
  const client = {
    getScan: async (id: string) => scan(id, data.engines[id] ?? []),
    getAllFindings: async (params: { scanId: string; hideDevAndTestDependencies?: boolean }) => {
      captured.hideDev = [...(captured.hideDev ?? []), params.hideDevAndTestDependencies ?? false];
      return data.findings[params.scanId] ?? [];
    },
    getSastMetadata: async (ids: string[]) =>
      ids.map((id) => ({ scanId: id, loc: data.loc[id], fileCount: 10 })),
    getScaPackages: async (id: string) => {
      const packages = data.packages[id];
      if (packages instanceof Error) throw packages;
      return packages ?? [];
    },
  } as unknown as CheckmarxClient;
  registerCompareTools(server, client);
}

async function compare(server: McpServer, args: Record<string, unknown> = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK internals for test harness
  const tool = (server as any)._registeredTools.compare_scans as {
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>;
  };
  const result = await tool.handler({
    baseScanId: BASE,
    compareScanId: LOCAL,
    hideDevAndTestDependencies: false,
    maxItems: 50,
    ...args,
  });
  return { result, parsed: result.isError ? undefined : JSON.parse(result.content[0]?.text ?? "") };
}

describe("compare_scans", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "1.0.0" });
  });

  it("reports no differences for matching scans", async () => {
    const findings = [sast("1", "a.ts"), sast("2", "b.ts"), containers("c1")];
    setup(server, {
      engines: { [BASE]: ["sast", "sca", "containers"], [LOCAL]: ["containers", "sast", "sca"] },
      findings: { [BASE]: findings, [LOCAL]: [...findings].reverse() },
      packages: { [BASE]: [pkg("npm-rxjs-7.8.2", true)], [LOCAL]: [pkg("npm-rxjs-7.8.2", true)] },
      loc: { [BASE]: 156609, [LOCAL]: 156609 },
    });

    const { parsed } = await compare(server);

    expect(parsed.differences).toEqual([]);
    expect(parsed.engines.same).toBe(true);
    expect(parsed.perEngine.sast).toEqual({
      base: { total: 2, LOW: 2 },
      compare: { total: 2, LOW: 2 },
      matched: 2,
      onlyInBase: 0,
      onlyInCompare: 0,
    });
    expect(parsed.perEngine.containers.matched).toBe(1);
    expect(parsed.sast.loc).toEqual({ base: 156609, compare: 156609 });
    expect(parsed.sast.files).toEqual({ total: 2, differing: 0 });
    expect(parsed.scaPackages).toMatchObject({ matched: 1, onlyInBase: 0, onlyInCompare: 0 });
  });

  it("lists findings, files, LOC and packages that differ", async () => {
    setup(server, {
      engines: { [BASE]: ["sast", "sca"], [LOCAL]: ["sast", "sca", "kics"] },
      findings: {
        // similarityId "1" twice in base but once locally: one extra in base.
        [BASE]: [sast("1", "a.ts"), sast("1", "a.ts"), sast("2", "b.ts", "MEDIUM")],
        [LOCAL]: [sast("1", "a.ts"), sast("3", ".checkmarx/containers/containers-resolution.json")],
      },
      packages: {
        [BASE]: [pkg("rxjs", true), pkg("tslib", false)],
        [LOCAL]: [pkg("rxjs", true), pkg("tslib", true), pkg("vitest", true, true)],
      },
      loc: { [BASE]: 100, [LOCAL]: 120 },
    });

    const { parsed } = await compare(server);

    expect(parsed.differences).toEqual([
      "Engines differ: sast, sca vs kics, sast, sca",
      "sast: 3 vs 2 findings, 2 only in base, 1 only in compare",
      "SAST LOC: 100 vs 120",
      "SCA packages: 2 vs 3, 0 only in base, 1 only in compare",
      "SCA packages: 1 with different direct, dev or test flags",
    ]);
    expect(parsed.perEngine.sast.onlyInBaseFindings).toEqual([
      { similarityId: "1", severity: "LOW", queryName: "Q", fileName: "a.ts", line: 3 },
      { similarityId: "2", severity: "MEDIUM", queryName: "Q", fileName: "b.ts", line: 3 },
    ]);
    expect(parsed.sast.files.differingFiles).toEqual([
      { file: ".checkmarx/containers/containers-resolution.json", base: 0, compare: 1 },
      { file: "a.ts", base: 2, compare: 1 },
      { file: "b.ts", base: 1, compare: 0 },
    ]);
    expect(parsed.scaPackages.onlyInComparePackages).toEqual([
      { id: "vitest", direct: true, dev: true, test: false },
    ]);
    expect(parsed.scaPackages.flagsDiffer).toEqual([
      {
        id: "tslib",
        base: { direct: false, dev: false, test: false },
        compare: { direct: true, dev: false, test: false },
      },
    ]);
  });

  it("limits listed items to maxItems", async () => {
    setup(server, {
      engines: { [BASE]: ["sast"], [LOCAL]: ["sast"] },
      findings: { [BASE]: [sast("1", "a.ts"), sast("2", "b.ts"), sast("3", "c.ts")], [LOCAL]: [] },
      packages: {},
      loc: {},
    });

    const { parsed } = await compare(server, { maxItems: 1 });

    expect(parsed.perEngine.sast.onlyInBase).toBe(3);
    expect(parsed.perEngine.sast.onlyInBaseFindings).toHaveLength(1);
    expect(parsed.sast.files.differingFiles).toHaveLength(1);
  });

  it("reports an SCA export error without failing the comparison", async () => {
    setup(server, {
      engines: { [BASE]: ["sca"], [LOCAL]: ["sca"] },
      findings: {},
      packages: { [BASE]: [pkg("rxjs", true)], [LOCAL]: new Error("export timed out") },
      loc: {},
    });

    const { result, parsed } = await compare(server);

    expect(result.isError).toBeUndefined();
    expect(parsed.scaPackages.compare).toEqual({ error: "export timed out" });
    expect(parsed.differences).toContain("SCA packages could not be compared for both scans");
  });

  it("passes hideDevAndTestDependencies to both scans", async () => {
    const captured: { hideDev?: boolean[] } = {};
    setup(server, { engines: {}, findings: {}, packages: {}, loc: {} }, captured);

    const { parsed } = await compare(server, { hideDevAndTestDependencies: true });

    expect(captured.hideDev).toEqual([true, true]);
    expect(parsed.note).toContain("exclude dev and test dependencies");
  });
});
