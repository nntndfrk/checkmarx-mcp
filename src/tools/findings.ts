import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CheckmarxClient } from "../api/client.js";
import type {
  ContainersFindingData,
  EngineCounters,
  EngineSummaryCounters,
  Finding,
  FindingState,
  KicsFindingData,
  SastFindingData,
  ScaFindingData,
  ScanSummary,
  ScanType,
  Severity,
} from "../api/types.js";

const SeverityEnum = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);
const ScanTypeEnum = z.enum(["sast", "sca", "kics", "apisec", "secrets", "containers"]);
const FindingStateEnum = z.enum([
  "TO_VERIFY",
  "CONFIRMED",
  "URGENT",
  "NOT_EXPLOITABLE",
  "PROPOSED_NOT_EXPLOITABLE",
]);

/** `/api/scan-summary` counter blocks, keyed by the engine name used in `scanTypes`. */
const SUMMARY_ENGINES = {
  sast: "sastCounters",
  sca: "scaCounters",
  kics: "kicsCounters",
  apisec: "apiSecCounters",
  containers: "containersCounters",
} as const satisfies Partial<Record<ScanType, keyof ScanSummary>>;

const hideDevAndTestDependenciesParam = z
  .boolean()
  .default(false)
  .describe(
    "Hide SCA findings in dev and test dependencies, same as cx --sca-hide-dev-test-dependencies. " +
      "Use this to compare with a cx pipeline scan.",
  );

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerFindingTools(server: McpServer, client: CheckmarxClient): void {
  server.tool(
    "findings_summary",
    "Get a severity breakdown of findings for a completed scan, grouped by scanner type. " +
      "Returns total count, per-engine severity/status/state counters, and the number of SCA packages.",
    {
      scanId: z.string().uuid().describe("The scan UUID"),
      hideDevAndTestDependencies: hideDevAndTestDependenciesParam,
    },
    async ({ scanId, hideDevAndTestDependencies }) => {
      try {
        const summary = await client.getFindingSummary(scanId);
        const perEngine = summaryPerEngine(summary);
        if (hideDevAndTestDependencies && perEngine.sca) {
          // The summary API has no dev/test filter, so SCA is recounted from the results.
          const findings = await client.getAllFindings({
            scanId,
            hideDevAndTestDependencies: true,
          });
          perEngine.sca = countFindings(findings.filter((f) => f.type === "sca"));
        }
        const shaped = shapeSummary(summary, perEngine);
        if (hideDevAndTestDependencies) {
          shaped.note =
            "SCA counters exclude dev and test dependencies. scaPackages still includes them.";
        }
        return { content: [{ type: "text", text: JSON.stringify(shaped, null, 2) }] };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error getting findings summary: ${errorMessage(error)}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "list_findings",
    "List security findings from a scan with filtering by severity, type, and state. " +
      "SAST findings include file location and data flow length. " +
      "SCA findings include package, CVE, and remediation data. " +
      "KICS (IaC) findings include platform, file, and expected/actual values. " +
      "Containers findings include image, package, CVE, and recommended image data.",
    {
      scanId: z.string().uuid().describe("The scan UUID"),
      severity: z.array(SeverityEnum).optional().describe("Filter by severity levels"),
      type: z
        .array(ScanTypeEnum)
        .optional()
        .describe("Filter by scanner type (sast, sca, kics, etc.)"),
      state: z.array(FindingStateEnum).optional().describe("Filter by finding state"),
      hideDevAndTestDependencies: hideDevAndTestDependenciesParam,
      limit: z.number().int().min(1).max(200).default(20).describe("Max results to return"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    async ({ scanId, severity, type, state, hideDevAndTestDependencies, limit, offset }) => {
      try {
        const result = await client.getFindings({
          scanId,
          severity: severity as Severity[] | undefined,
          type: type as ScanType[] | undefined,
          state: state as FindingState[] | undefined,
          hideDevAndTestDependencies,
          limit,
          offset,
        });

        const shaped = {
          totalCount: result.totalCount,
          findings: result.items.map(shapeFinding),
        };

        return { content: [{ type: "text", text: JSON.stringify(shaped, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error listing findings: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_finding_details",
    "Get full details for a specific finding, including data flow (SAST) or vulnerability chain (SCA). " +
      "Use list_findings first to get valid finding IDs.",
    {
      scanId: z.string().uuid().describe("The scan UUID"),
      findingId: z.string().min(1).describe("The finding ID from list_findings"),
    },
    async ({ scanId, findingId }) => {
      try {
        const findings = await client.getAllFindings({ scanId });
        const finding = findings.find((f) => f.id === findingId);
        if (finding) {
          return { content: [{ type: "text", text: JSON.stringify(finding, null, 2) }] };
        }

        return {
          content: [
            {
              type: "text",
              text: `Finding ${findingId} not found in scan ${scanId}. Use list_findings with filters to locate it.`,
            },
          ],
          isError: true,
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error getting finding details: ${errorMessage(error)}` },
          ],
          isError: true,
        };
      }
    },
  );
}

function summaryPerEngine(summary: ScanSummary): Record<string, EngineCounters> {
  const perEngine: Record<string, EngineCounters> = {};
  for (const [engine, key] of Object.entries(SUMMARY_ENGINES)) {
    const counters = summary[key];
    if (counters) perEngine[engine] = toEngineCounters(counters);
  }
  return perEngine;
}

function toEngineCounters(counters: EngineSummaryCounters): EngineCounters {
  const severityCounters = counters.severityCounters ?? [];
  return {
    totalCounter:
      counters.totalCounter ?? severityCounters.reduce((total, c) => total + c.counter, 0),
    severityCounters,
    statusCounters: counters.statusCounters ?? [],
    stateCounters: counters.stateCounters ?? [],
  };
}

function countFindings(findings: Finding[]): EngineCounters {
  const count = (key: (f: Finding) => string) => {
    const counts = new Map<string, number>();
    for (const finding of findings) counts.set(key(finding), (counts.get(key(finding)) ?? 0) + 1);
    return [...counts];
  };
  return {
    totalCounter: findings.length,
    severityCounters: count((f) => f.severity).map(([severity, counter]) => ({
      severity: severity as Severity,
      counter,
    })),
    statusCounters: count((f) => f.status).map(([status, counter]) => ({ status, counter })),
    stateCounters: count((f) => f.state).map(([state, counter]) => ({ state, counter })),
  };
}

function shapeSummary(
  summary: ScanSummary,
  perEngine: Record<string, EngineCounters>,
): Record<string, unknown> {
  const scaContainers = summary.scaContainersCounters;
  return {
    scanId: summary.scanId,
    totalCounter: Object.values(perEngine).reduce((total, e) => total + e.totalCounter, 0),
    perEngine,
    scaPackages: summary.scaPackagesCounters?.stateCounters?.reduce(
      (total, c) => total + c.counter,
      0,
    ),
    containersCounters: perEngine.containers,
    scaContainersCounters: scaContainers && {
      totalPackages: scaContainers.totalPackagesCounter,
      totalVulnerabilities: scaContainers.totalVulnerabilitiesCounter,
      severityCounters: scaContainers.severityVulnerabilitiesCounters ?? [],
    },
  };
}

function shapeFinding(finding: Finding): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: finding.id,
    type: finding.type,
    similarityId: finding.similarityId,
    severity: finding.severity,
    status: finding.status,
    state: finding.state,
    description: finding.description,
  };

  if (finding.type === "sast") {
    const data = finding.data as SastFindingData;
    base.queryName = data.queryName;
    base.language = data.languageName;
    const sourceNode = data.nodes?.[0];
    if (sourceNode) {
      base.fileName = sourceNode.fileName;
      base.line = sourceNode.line;
      base.column = sourceNode.column;
    }
    if (data.nodes?.length > 1) {
      base.dataFlowLength = data.nodes.length;
      const sinkNode = data.nodes[data.nodes.length - 1];
      if (sinkNode) {
        base.sinkFileName = sinkNode.fileName;
        base.sinkLine = sinkNode.line;
      }
    }
  } else if (finding.type === "sca") {
    const data = finding.data as ScaFindingData;
    base.packageIdentifier = data.packageIdentifier;
    base.recommendation = data.recommendation;
    base.recommendedVersion = data.recommendedVersion;
    if (finding.vulnerabilityDetails) {
      base.cveId = finding.vulnerabilityDetails.cveId;
      base.cvssScore = finding.vulnerabilityDetails.cvssScore;
      base.cweId = finding.vulnerabilityDetails.cweId;
    }
  } else if (finding.type === "containers") {
    const data = finding.data as ContainersFindingData;
    base.packageIdentifier = data.packageIdentifier;
    base.packageName = data.packageName;
    base.packageVersion = data.packageVersion;
    base.imageName = data.imageName;
    base.imageTag = data.imageTag;
    base.imageDigest = data.imageDigest;
    base.baseImage = data.baseImage;
    base.layerId = data.layerId;
    base.recommendation = data.recommendation;
    base.recommendedVersion = data.recommendedVersion;
    base.recommendedImage = data.recommendedImage;
    if (finding.vulnerabilityDetails) {
      base.cveId = finding.vulnerabilityDetails.cveId;
      base.cvssScore = finding.vulnerabilityDetails.cvssScore;
      base.cweId = finding.vulnerabilityDetails.cweId;
    }
  } else if (finding.type === "kics") {
    const data = finding.data as KicsFindingData;
    base.queryName = data.queryName;
    base.queryUrl = data.queryUrl;
    base.platform = data.platform;
    base.fileName = data.fileName;
    base.line = data.searchLine;
    base.issueType = data.issueType;
    base.expectedValue = data.expectedValue;
    base.actualValue = data.actualValue;
  }

  return base;
}
