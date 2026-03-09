import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CheckmarxClient } from "../api/client.js";
import type {
  Finding,
  FindingState,
  KicsFindingData,
  SastFindingData,
  ScaFindingData,
  Severity,
  ScanType,
} from "../api/types.js";

const SeverityEnum = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);
const ScanTypeEnum = z.enum(["sast", "sca", "kics", "apisec", "secrets"]);
const FindingStateEnum = z.enum([
  "TO_VERIFY",
  "CONFIRMED",
  "URGENT",
  "NOT_EXPLOITABLE",
  "PROPOSED_NOT_EXPLOITABLE",
]);

const MAX_FINDING_SEARCH_PAGES = 10;
const FINDING_PAGE_SIZE = 200;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerFindingTools(server: McpServer, client: CheckmarxClient): void {
  server.tool(
    "findings_summary",
    "Get a severity breakdown of findings for a completed scan, grouped by scanner type. " +
      "Returns total count and per-engine severity counters.",
    {
      scanId: z.string().uuid().describe("The scan UUID"),
    },
    async ({ scanId }) => {
      try {
        const summary = await client.getFindingSummary(scanId);
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
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
      "KICS (IaC) findings include platform, file, and expected/actual values.",
    {
      scanId: z.string().uuid().describe("The scan UUID"),
      severity: z
        .array(SeverityEnum)
        .optional()
        .describe("Filter by severity levels"),
      type: z
        .array(ScanTypeEnum)
        .optional()
        .describe("Filter by scanner type (sast, sca, kics, etc.)"),
      state: z
        .array(FindingStateEnum)
        .optional()
        .describe("Filter by finding state"),
      limit: z.number().int().min(1).max(200).default(20).describe("Max results to return"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    async ({ scanId, severity, type, state, limit, offset }) => {
      try {
        const result = await client.getFindings({
          scanId,
          severity: severity as Severity[] | undefined,
          type: type as ScanType[] | undefined,
          state: state as FindingState[] | undefined,
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
          content: [
            { type: "text", text: `Error listing findings: ${errorMessage(error)}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_finding_details",
    "Get full details for a specific finding, including data flow (SAST) or vulnerability chain (SCA). " +
      "Searches up to 2000 findings (paginated). Use list_findings first to get valid finding IDs.",
    {
      scanId: z.string().uuid().describe("The scan UUID"),
      findingId: z.string().min(1).describe("The finding ID from list_findings"),
    },
    async ({ scanId, findingId }) => {
      try {
        for (let page = 0; page < MAX_FINDING_SEARCH_PAGES; page++) {
          const result = await client.getFindings({
            scanId,
            limit: FINDING_PAGE_SIZE,
            offset: page * FINDING_PAGE_SIZE,
          });
          const finding = result.items.find((f) => f.id === findingId);
          if (finding) {
            return { content: [{ type: "text", text: JSON.stringify(finding, null, 2) }] };
          }
          if (result.items.length < FINDING_PAGE_SIZE) break;
        }

        return {
          content: [
            {
              type: "text",
              text:
                `Finding ${findingId} not found in scan ${scanId}. ` +
                "Use list_findings with filters to locate it.",
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
