import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function startStdioTransport(server: McpServer): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[checkmarx-mcp] Stdio transport connected");
  return transport;
}
