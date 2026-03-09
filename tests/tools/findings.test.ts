import { describe, expect, it, beforeEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFindingTools } from "../../src/tools/findings.js";
import type { CheckmarxClient } from "../../src/api/client.js";
import type { Finding, SastFindingData, ScaFindingData, KicsFindingData } from "../../src/api/types.js";

const mockSastFinding: Finding<"sast"> = {
  id: "finding-sast-1",
  type: "sast",
  similarityId: "sim-1",
  status: "NEW",
  state: "TO_VERIFY",
  severity: "HIGH",
  createdAt: "2024-06-01T00:00:00Z",
  firstFoundAt: "2024-06-01T00:00:00Z",
  foundAt: "2024-06-01T00:00:00Z",
  firstScanId: "scan-1",
  description: "SQL Injection vulnerability",
  data: {
    queryId: 1,
    queryName: "SQL_Injection",
    group: "CWE-89",
    resultHash: "abc123",
    languageName: "JavaScript",
    nodes: [
      {
        id: "node-1",
        line: 42,
        column: 10,
        length: 15,
        method: "executeQuery",
        nodeHash: "hash1",
        fileName: "src/db/queries.ts",
        fullName: "src.db.queries.executeQuery",
        typeName: "function",
        methodLine: 40,
        definitions: "",
      },
      {
        id: "node-2",
        line: 25,
        column: 5,
        length: 10,
        method: "handleRequest",
        nodeHash: "hash2",
        fileName: "src/routes/api.ts",
        fullName: "src.routes.api.handleRequest",
        typeName: "function",
        methodLine: 20,
        definitions: "",
      },
    ],
  },
};

const mockScaFinding: Finding<"sca"> = {
  id: "finding-sca-1",
  type: "sca",
  similarityId: "sim-2",
  status: "NEW",
  state: "TO_VERIFY",
  severity: "CRITICAL",
  createdAt: "2024-06-01T00:00:00Z",
  firstFoundAt: "2024-06-01T00:00:00Z",
  foundAt: "2024-06-01T00:00:00Z",
  firstScanId: "scan-1",
  description: "Prototype Pollution in lodash",
  data: {
    packageIdentifier: "npm:lodash:4.17.20",
    recommendation: "Upgrade to 4.17.21",
    recommendedVersion: "4.17.21",
  },
  vulnerabilityDetails: {
    cveId: "CVE-2021-23337",
    cvssScore: 7.2,
    cweId: 1321,
  },
};

const mockKicsFinding: Finding<"kics"> = {
  id: "finding-kics-1",
  type: "kics",
  similarityId: "sim-3",
  status: "NEW",
  state: "TO_VERIFY",
  severity: "MEDIUM",
  createdAt: "2024-06-01T00:00:00Z",
  firstFoundAt: "2024-06-01T00:00:00Z",
  foundAt: "2024-06-01T00:00:00Z",
  firstScanId: "scan-1",
  description: "Container running as root",
  data: {
    queryId: "q-1",
    queryName: "Container_Running_As_Root",
    group: "Access Control",
    queryUrl: "https://docs.kics.io/...",
    fileName: "Dockerfile",
    platform: "Dockerfile",
    issueType: "MissingAttribute",
    searchKey: "USER",
    searchLine: 1,
    searchValue: "",
    expectedValue: "USER instruction should be set",
    actualValue: "USER instruction is missing",
  },
};

function createMockClient(overrides: Partial<CheckmarxClient> = {}): CheckmarxClient {
  return {
    getFindings: async () => ({
      totalCount: 3,
      filteredTotalCount: 3,
      items: [mockSastFinding, mockScaFinding, mockKicsFinding] as Finding[],
    }),
    getFindingSummary: async () => ({
      scanId: "scan-1",
      totalCounter: 10,
      counters: [
        { type: "sast" as const, severity: "HIGH" as const, counter: 5 },
        { type: "sca" as const, severity: "CRITICAL" as const, counter: 2 },
        { type: "kics" as const, severity: "MEDIUM" as const, counter: 3 },
      ],
      statusCounters: [{ status: "NEW", counter: 10 }],
    }),
    ...overrides,
  } as unknown as CheckmarxClient;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler: (args: Record<string, unknown>) => Promise<any> }
  >;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.handler(args);
}

describe("Finding Tools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "1.0.0" });
  });

  describe("findings_summary", () => {
    it("returns severity breakdown", async () => {
      const client = createMockClient();
      registerFindingTools(server, client);

      const result = await callTool(server, "findings_summary", {
        scanId: "550e8400-e29b-41d4-a716-446655440000",
      });
      const parsed = JSON.parse(result.content[0]!.text);

      expect(parsed.totalCounter).toBe(10);
      expect(parsed.counters).toHaveLength(3);
    });

    it("returns error on failure", async () => {
      const client = createMockClient({
        getFindingSummary: async () => {
          throw new Error("Scan not found");
        },
      });
      registerFindingTools(server, client);

      const result = await callTool(server, "findings_summary", {
        scanId: "550e8400-e29b-41d4-a716-446655440000",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Scan not found");
    });
  });

  describe("list_findings", () => {
    it("shapes SAST findings with file location", async () => {
      const client = createMockClient();
      registerFindingTools(server, client);

      const result = await callTool(server, "list_findings", {
        scanId: "550e8400-e29b-41d4-a716-446655440000",
        limit: 20,
        offset: 0,
      });
      const parsed = JSON.parse(result.content[0]!.text);
      const sastFinding = parsed.findings[0];

      expect(sastFinding.type).toBe("sast");
      expect(sastFinding.similarityId).toBe("sim-1");
      expect(sastFinding.queryName).toBe("SQL_Injection");
      expect(sastFinding.fileName).toBe("src/db/queries.ts");
      expect(sastFinding.line).toBe(42);
      expect(sastFinding.column).toBe(10);
      expect(sastFinding.dataFlowLength).toBe(2);
      expect(sastFinding.sinkFileName).toBe("src/routes/api.ts");
      expect(sastFinding.sinkLine).toBe(25);
    });

    it("shapes SCA findings with CVE data", async () => {
      const client = createMockClient();
      registerFindingTools(server, client);

      const result = await callTool(server, "list_findings", {
        scanId: "550e8400-e29b-41d4-a716-446655440000",
        limit: 20,
        offset: 0,
      });
      const parsed = JSON.parse(result.content[0]!.text);
      const scaFinding = parsed.findings[1];

      expect(scaFinding.type).toBe("sca");
      expect(scaFinding.packageIdentifier).toBe("npm:lodash:4.17.20");
      expect(scaFinding.recommendation).toBe("Upgrade to 4.17.21");
      expect(scaFinding.cveId).toBe("CVE-2021-23337");
      expect(scaFinding.cvssScore).toBe(7.2);
      expect(scaFinding.recommendedVersion).toBe("4.17.21");
    });

    it("shapes KICS findings with file and platform", async () => {
      const client = createMockClient();
      registerFindingTools(server, client);

      const result = await callTool(server, "list_findings", {
        scanId: "550e8400-e29b-41d4-a716-446655440000",
        limit: 20,
        offset: 0,
      });
      const parsed = JSON.parse(result.content[0]!.text);
      const kicsFinding = parsed.findings[2];

      expect(kicsFinding.type).toBe("kics");
      expect(kicsFinding.queryName).toBe("Container_Running_As_Root");
      expect(kicsFinding.queryUrl).toBe("https://docs.kics.io/...");
      expect(kicsFinding.platform).toBe("Dockerfile");
      expect(kicsFinding.fileName).toBe("Dockerfile");
      expect(kicsFinding.issueType).toBe("MissingAttribute");
      expect(kicsFinding.expectedValue).toBe("USER instruction should be set");
    });

    it("returns error on client failure", async () => {
      const client = createMockClient({
        getFindings: async () => {
          throw new Error("Invalid scan ID");
        },
      });
      registerFindingTools(server, client);

      const result = await callTool(server, "list_findings", {
        scanId: "550e8400-e29b-41d4-a716-446655440000",
        limit: 20,
        offset: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Invalid scan ID");
    });
  });

  describe("get_finding_details", () => {
    it("returns full finding by ID", async () => {
      const client = createMockClient();
      registerFindingTools(server, client);

      const result = await callTool(server, "get_finding_details", {
        scanId: "550e8400-e29b-41d4-a716-446655440000",
        findingId: "finding-sast-1",
      });
      const parsed = JSON.parse(result.content[0]!.text);

      expect(parsed.id).toBe("finding-sast-1");
      expect(parsed.data.nodes).toHaveLength(2);
    });

    it("returns error when finding not found", async () => {
      const client = createMockClient();
      registerFindingTools(server, client);

      const result = await callTool(server, "get_finding_details", {
        scanId: "550e8400-e29b-41d4-a716-446655440000",
        findingId: "nonexistent",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("not found");
    });
  });
});
