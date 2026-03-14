import type { Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CheckmarxAuth } from "./api/auth.js";
import { CheckmarxClient } from "./api/client.js";
import { loadConfig } from "./config.js";
import { registerAllTools } from "./tools/index.js";
import { startHttpTransport } from "./transport/http.js";
import { startStdioTransport } from "./transport/stdio.js";

const SERVER_NAME = "checkmarx-mcp";
const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const auth = new CheckmarxAuth(config);
  const client = new CheckmarxClient(config, auth);

  let httpServer: HttpServer | undefined;

  if (config.transport === "http") {
    const createServer = () => {
      const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} } },
      );
      registerAllTools(server, client);
      return server;
    };
    httpServer = await startHttpTransport(createServer, config.port);
  } else {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    registerAllTools(server, client);
    await startStdioTransport(server);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[${SERVER_NAME}] Shutting down...`);
    try {
      if (httpServer) {
        httpServer.close();
      }
    } catch (err) {
      console.error(`[${SERVER_NAME}] Error during shutdown:`, err);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] Fatal error:`, error);
  process.exit(1);
});
