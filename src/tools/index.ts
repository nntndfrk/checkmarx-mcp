import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CheckmarxClient } from "../api/client.js";
import { registerCompareTools } from "./compare.js";
import { registerFindingTools } from "./findings.js";
import { registerProjectTools } from "./projects.js";
import { type ScanResolvers, registerScanTools } from "./scans.js";

export function registerAllTools(
  server: McpServer,
  client: CheckmarxClient,
  resolvers: ScanResolvers = {},
): void {
  registerProjectTools(server, client);
  registerScanTools(server, client, resolvers);
  registerFindingTools(server, client);
  registerCompareTools(server, client);
}
