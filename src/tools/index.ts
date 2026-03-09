import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CheckmarxClient } from "../api/client.js";
import { registerProjectTools } from "./projects.js";
import { registerScanTools } from "./scans.js";
import { registerFindingTools } from "./findings.js";

export function registerAllTools(server: McpServer, client: CheckmarxClient): void {
  registerProjectTools(server, client);
  registerScanTools(server, client);
  registerFindingTools(server, client);
}
