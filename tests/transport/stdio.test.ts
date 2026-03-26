import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { startStdioTransport } from "../../src/transport/stdio.js";

describe("startStdioTransport", () => {
  it("connects transport to server and returns it", async () => {
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );

    const connectSpy = vi.spyOn(server, "connect").mockResolvedValue(undefined);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const transport = await startStdioTransport(server);

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(transport).toBeDefined();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Stdio transport connected"));
    } finally {
      connectSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("propagates errors from server.connect()", async () => {
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );

    const connectSpy = vi.spyOn(server, "connect").mockRejectedValue(new Error("connect failed"));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(startStdioTransport(server)).rejects.toThrow("connect failed");
    } finally {
      connectSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
