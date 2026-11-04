import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CheckmarxClient } from "../api/client.js";
import type { ScaResolver } from "../utils/sca-resolver.js";
import { registerFindingTools } from "./findings.js";
import { registerProjectTools } from "./projects.js";
import { registerScanTools } from "./scans.js";

export function registerAllTools(
  server: McpServer,
  client: CheckmarxClient,
  scaResolver?: ScaResolver,
): void {
  registerProjectTools(server, client);
  registerScanTools(server, client, scaResolver);
  registerFindingTools(server, client);
}
