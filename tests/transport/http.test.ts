import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { McpServerFactory } from "../../src/transport/http.js";
import { startHttpTransport } from "../../src/transport/http.js";

const packageVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
).version as string;

const TEST_PORT = 19876;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let httpServer: HttpServer;

const createTestServer: McpServerFactory = () =>
  new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });

beforeAll(async () => {
  stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  httpServer = await startHttpTransport(createTestServer, TEST_PORT);
});

afterAll(() => {
  httpServer.close();
  stderrSpy.mockRestore();
});

describe("HTTP transport", () => {
  it("GET /health returns ok", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", transport: "http" });
  });

  it("GET / returns server info", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("checkmarx-mcp");
    expect(body.version).toBe(packageVersion);
    expect(body.transport).toBe("http");
    expect(body.endpoints).toBeDefined();
  });

  it("sets CORS headers including Mcp-Protocol-Version", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const exposed = res.headers.get("access-control-expose-headers") ?? "";
    expect(exposed).toContain("Mcp-Protocol-Version");
  });

  it("OPTIONS returns 204", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
  });

  it("DELETE /mcp returns 405 with JSON-RPC error", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "DELETE",
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error).toBeDefined();
  });

  it("GET /mcp returns 405 with JSON-RPC error", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
  });

  it("POST /mcp with invalid body returns error status", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("handles multiple sequential POST /mcp requests without crashing", async () => {
    const req1 = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    const req2 = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 2 }),
    });
    expect(req1.status).toBeLessThan(500);
    expect(req2.status).toBeLessThan(500);
  });
});
