import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CheckmarxClient } from "../api/client.js";
import type {
  ContainersFindingData,
  Finding,
  KicsFindingData,
  SastFindingData,
  SastMetadata,
  ScaFindingData,
  ScaPackage,
  Scan,
} from "../api/types.js";

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

interface Pair<T> {
  base: T;
  compare: T;
}

/** A finding reduced to what identifies it in a diff. */
type FindingRef = Record<string, unknown> & { similarityId: string; severity: string };

/** Package flags compared between two scans. */
interface PackageFlags {
  direct: boolean;
  dev: boolean;
  test: boolean;
}

export function registerCompareTools(server: McpServer, client: CheckmarxClient): void {
  server.tool(
    "compare_scans",
    "Compare two scans, e.g. a cx pipeline scan (base) and a trigger_scan_local scan of the same commit " +
      "(compare). Reports the engines that ran, per-engine counts by severity, findings matched by " +
      "similarityId, SAST findings per file, SAST LOC, and the stored SCA packages with their direct, " +
      "dev and test flags. `differences` lists what differs; it is empty when the scans match.",
    {
      baseScanId: z.string().uuid().describe("Scan to compare against, e.g. the pipeline scan"),
      compareScanId: z.string().uuid().describe("Scan to compare, e.g. the local MCP scan"),
      hideDevAndTestDependencies: z
        .boolean()
        .default(false)
        .describe(
          "Leave SCA findings in dev and test dependencies out of both scans, " +
            "same as cx --sca-hide-dev-test-dependencies",
        ),
      maxItems: z
        .number()
        .int()
        .min(0)
        .max(500)
        .default(50)
        .describe("Max findings, files and packages listed per difference"),
    },
    async ({ baseScanId, compareScanId, hideDevAndTestDependencies, maxItems }) => {
      try {
        const ids = { base: baseScanId, compare: compareScanId };
        const [scans, findings, sastMetadata] = await Promise.all([
          both(ids, (id) => client.getScan(id)),
          both(ids, (id) => client.getAllFindings({ scanId: id, hideDevAndTestDependencies })),
          client.getSastMetadata([baseScanId, compareScanId]).catch(() => [] as SastMetadata[]),
        ]);
        const packages = await both(ids, (id, side) =>
          scans[side].engines?.includes("sca")
            ? client.getScaPackages(id).catch((error: unknown) => errorMessage(error))
            : Promise.resolve(undefined),
        );

        const engines = compareEngines(scans);
        const perEngine = compareFindings(findings, maxItems);
        const sast = {
          ...compareSastMetadata(sastMetadata, ids),
          files: compareSastFiles(findings, maxItems),
        };
        const sca = comparePackages(packages, maxItems);

        const differences = [
          ...(engines.same
            ? []
            : [`Engines differ: ${engines.base.join(", ")} vs ${engines.compare.join(", ")}`]),
          ...Object.entries(perEngine).flatMap(([engine, diff]) =>
            diff.onlyInBase || diff.onlyInCompare
              ? [
                  `${engine}: ${diff.base.total} vs ${diff.compare.total} findings, ` +
                    `${diff.onlyInBase} only in base, ${diff.onlyInCompare} only in compare`,
                ]
              : [],
          ),
          ...(sast.loc && sast.loc.base !== sast.loc.compare
            ? [`SAST LOC: ${sast.loc.base} vs ${sast.loc.compare}`]
            : []),
          ...sca.differences,
        ];

        const result = {
          scans: {
            base: describeScan(scans.base),
            compare: describeScan(scans.compare),
          },
          differences,
          engines,
          perEngine,
          sast,
          ...(sca.packages && { scaPackages: sca.packages }),
          ...(hideDevAndTestDependencies && {
            note: "SCA findings exclude dev and test dependencies. scaPackages lists all packages.",
          }),
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error comparing scans: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    },
  );
}

async function both<T>(
  ids: Pair<string>,
  get: (id: string, side: keyof Pair<string>) => Promise<T>,
): Promise<Pair<T>> {
  const [base, compare] = await Promise.all([get(ids.base, "base"), get(ids.compare, "compare")]);
  return { base, compare };
}

function describeScan(scan: Scan) {
  return {
    id: scan.id,
    projectName: scan.projectName,
    branch: scan.branch,
    status: scan.status,
    sourceType: scan.sourceType,
    createdAt: scan.createdAt,
  };
}

function compareEngines(scans: Pair<Scan>) {
  const base = [...(scans.base.engines ?? [])].sort();
  const compare = [...(scans.compare.engines ?? [])].sort();
  return { same: base.join(",") === compare.join(","), base, compare };
}

/** Per engine: counts by severity and the findings matched by similarityId. */
function compareFindings(findings: Pair<Finding[]>, maxItems: number) {
  const types = [...new Set([...findings.base, ...findings.compare].map((f) => f.type))].sort();
  return Object.fromEntries(
    types.map((type) => {
      const base = findings.base.filter((f) => f.type === type);
      const compare = findings.compare.filter((f) => f.type === type);
      const { matched, onlyInBase, onlyInCompare } = matchBySimilarity(base, compare);
      return [
        type,
        {
          base: severityCounts(base),
          compare: severityCounts(compare),
          matched,
          onlyInBase: onlyInBase.length,
          onlyInCompare: onlyInCompare.length,
          ...(onlyInBase.length && {
            onlyInBaseFindings: onlyInBase.slice(0, maxItems).map(findingRef),
          }),
          ...(onlyInCompare.length && {
            onlyInCompareFindings: onlyInCompare.slice(0, maxItems).map(findingRef),
          }),
        },
      ];
    }),
  );
}

/**
 * Pairs findings with the same similarityId. A similarityId can occur more
 * than once in a scan, so the extra occurrences on either side are unmatched.
 */
function matchBySimilarity(base: Finding[], compare: Finding[]) {
  const count = (list: Finding[]) => {
    const counts = new Map<string, number>();
    for (const f of list) counts.set(f.similarityId, (counts.get(f.similarityId) ?? 0) + 1);
    return counts;
  };
  const unmatched = (list: Finding[], other: Map<string, number>) => {
    const seen = new Map<string, number>();
    return list.filter((f) => {
      const n = seen.get(f.similarityId) ?? 0;
      seen.set(f.similarityId, n + 1);
      return n >= (other.get(f.similarityId) ?? 0);
    });
  };
  const onlyInBase = unmatched(base, count(compare));
  const onlyInCompare = unmatched(compare, count(base));
  return { matched: base.length - onlyInBase.length, onlyInBase, onlyInCompare };
}

function severityCounts(findings: Finding[]) {
  const counts: Record<string, number> = {};
  for (const severity of SEVERITIES) {
    const count = findings.filter((f) => f.severity === severity).length;
    if (count) counts[severity] = count;
  }
  return { total: findings.length, ...counts };
}

function findingRef(finding: Finding): FindingRef {
  const ref: FindingRef = { similarityId: finding.similarityId, severity: finding.severity };
  if (finding.type === "sast") {
    const data = finding.data as SastFindingData;
    const node = data.nodes?.[0];
    Object.assign(ref, { queryName: data.queryName, fileName: node?.fileName, line: node?.line });
  } else if (finding.type === "sca") {
    const data = finding.data as ScaFindingData;
    Object.assign(ref, {
      packageIdentifier: data.packageIdentifier,
      cveId: finding.vulnerabilityDetails?.cveId,
    });
  } else if (finding.type === "containers") {
    const data = finding.data as ContainersFindingData;
    Object.assign(ref, {
      image: data.imageName && `${data.imageName}:${data.imageTag ?? ""}`,
      packageIdentifier: data.packageIdentifier,
      cveId: finding.vulnerabilityDetails?.cveId,
    });
  } else if (finding.type === "kics") {
    const data = finding.data as KicsFindingData;
    Object.assign(ref, {
      queryName: data.queryName,
      fileName: data.fileName,
      line: data.searchLine,
    });
  } else {
    ref.description = finding.description?.slice(0, 200);
  }
  return ref;
}

/** SAST finding counts per file (the first data flow node), where they differ. */
function compareSastFiles(findings: Pair<Finding[]>, maxItems: number) {
  const counts = new Map<string, Pair<number>>();
  for (const side of ["base", "compare"] as const) {
    for (const finding of findings[side]) {
      if (finding.type !== "sast") continue;
      const file = (finding.data as SastFindingData).nodes?.[0]?.fileName ?? "(unknown)";
      const entry = counts.get(file) ?? { base: 0, compare: 0 };
      entry[side]++;
      counts.set(file, entry);
    }
  }
  const differing = [...counts.entries()]
    .filter(([, count]) => count.base !== count.compare)
    .sort(
      ([a, x], [b, y]) =>
        Math.abs(y.base - y.compare) - Math.abs(x.base - x.compare) || a.localeCompare(b),
    );
  return {
    total: counts.size,
    differing: differing.length,
    ...(differing.length && {
      differingFiles: differing.slice(0, maxItems).map(([file, count]) => ({ file, ...count })),
    }),
  };
}

function compareSastMetadata(metadata: SastMetadata[], ids: Pair<string>) {
  const base = metadata.find((m) => m.scanId === ids.base);
  const compare = metadata.find((m) => m.scanId === ids.compare);
  if (!base && !compare) return {};
  const field = <K extends keyof SastMetadata>(key: K) => ({
    base: base?.[key],
    compare: compare?.[key],
  });
  return {
    loc: field("loc"),
    fileCount: field("fileCount"),
    preset: field("queryPreset"),
    incremental: field("isIncremental"),
  };
}

function flags(pkg: ScaPackage): PackageFlags {
  return {
    direct: pkg.IsDirectDependency === true,
    dev: pkg.IsDevelopmentDependency === true,
    test: pkg.IsTestDependency === true,
  };
}

function packageTotals(packages: ScaPackage[]) {
  const all = packages.map(flags);
  return {
    total: packages.length,
    direct: all.filter((f) => f.direct).length,
    dev: all.filter((f) => f.dev).length,
    test: all.filter((f) => f.test).length,
  };
}

/** Stored SCA packages, matched by package ID, with differing flags. */
function comparePackages(packages: Pair<ScaPackage[] | string | undefined>, maxItems: number) {
  const { base, compare } = packages;
  if (base === undefined && compare === undefined) return { differences: [] as string[] };
  if (typeof base === "string" || typeof compare === "string" || !base || !compare) {
    const side = (value: ScaPackage[] | string | undefined) =>
      typeof value === "string"
        ? { error: value }
        : value
          ? packageTotals(value)
          : { error: "SCA did not run" };
    return {
      packages: { base: side(base), compare: side(compare) },
      differences: ["SCA packages could not be compared for both scans"],
    };
  }

  const byId = (list: ScaPackage[]) => new Map(list.map((pkg) => [pkg.Id, pkg]));
  const baseIds = byId(base);
  const compareIds = byId(compare);
  const describe = (pkg: ScaPackage) => ({ id: pkg.Id, ...flags(pkg) });
  const onlyInBase = base.filter((pkg) => !compareIds.has(pkg.Id));
  const onlyInCompare = compare.filter((pkg) => !baseIds.has(pkg.Id));
  const flagsDiffer = base.flatMap((pkg) => {
    const other = compareIds.get(pkg.Id);
    if (!other) return [];
    const a = flags(pkg);
    const b = flags(other);
    return a.direct === b.direct && a.dev === b.dev && a.test === b.test
      ? []
      : [{ id: pkg.Id, base: a, compare: b }];
  });

  const differences: string[] = [];
  if (onlyInBase.length || onlyInCompare.length) {
    differences.push(
      `SCA packages: ${base.length} vs ${compare.length}, ` +
        `${onlyInBase.length} only in base, ${onlyInCompare.length} only in compare`,
    );
  }
  if (flagsDiffer.length) {
    differences.push(
      `SCA packages: ${flagsDiffer.length} with different direct, dev or test flags`,
    );
  }
  return {
    packages: {
      base: packageTotals(base),
      compare: packageTotals(compare),
      matched: base.length - onlyInBase.length,
      onlyInBase: onlyInBase.length,
      onlyInCompare: onlyInCompare.length,
      ...(onlyInBase.length && {
        onlyInBasePackages: onlyInBase.slice(0, maxItems).map(describe),
      }),
      ...(onlyInCompare.length && {
        onlyInComparePackages: onlyInCompare.slice(0, maxItems).map(describe),
      }),
      ...(flagsDiffer.length && { flagsDiffer: flagsDiffer.slice(0, maxItems) }),
    },
    differences,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
