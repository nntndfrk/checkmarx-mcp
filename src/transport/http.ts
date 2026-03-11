import type { Server as HttpServer } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

const SERVER_NAME = "checkmarx-mcp";

export type McpServerFactory = () => McpServer;

const JSON_RPC_ERROR = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

export async function startHttpTransport(
  createServer: McpServerFactory,
  port: number,
): Promise<HttpServer> {
  const app = express();

  app.use(express.json());

  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
    );
    res.header("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
    next();
  });
  app.options("/{*path}", (_req, res) => res.sendStatus(204));

  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[checkmarx-mcp] Error handling MCP request:", error);
      if (!res.headersSent) {
        res
          .status(500)
          .type("application/json")
          .send(JSON_RPC_ERROR(-32603, "Internal server error"));
      }
    }

    res.on("close", () => {
      transport.close();
      server.close();
    });
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).type("application/json").send(JSON_RPC_ERROR(-32000, "Method not allowed"));
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).type("application/json").send(JSON_RPC_ERROR(-32000, "Method not allowed"));
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "http" });
  });

  app.get("/", (_req, res) => {
    res.json({
      name: SERVER_NAME,
      version: "0.1.0",
      transport: "http",
      endpoints: {
        mcp: "POST /mcp",
        health: "GET /health",
      },
    });
  });

  return new Promise<HttpServer>((resolve) => {
    const httpServer = app.listen(port, () => {
      console.error(`[${SERVER_NAME}] HTTP transport listening on http://localhost:${port}`);
      console.error(`[${SERVER_NAME}] MCP endpoint: POST http://localhost:${port}/mcp`);
      resolve(httpServer);
    });
  });
}
