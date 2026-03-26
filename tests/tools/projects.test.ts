import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { CheckmarxClient } from "../../src/api/client.js";
import { registerProjectTools } from "../../src/tools/projects.js";

function createMockClient(overrides: Partial<CheckmarxClient> = {}): CheckmarxClient {
  return {
    healthCheck: async () => ({ ok: true, message: "Connected to Checkmarx One" }),
    listProjects: async () => ({
      totalCount: 2,
      filteredTotalCount: 2,
      items: [
        {
          id: "proj-1",
          name: "my-app",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-06-01T00:00:00Z",
          groups: [],
          tags: {},
          repoUrl: "https://github.com/org/my-app",
          mainBranch: "main",
          criticality: 3,
        },
        {
          id: "proj-2",
          name: "backend",
          createdAt: "2024-02-01T00:00:00Z",
          updatedAt: "2024-06-15T00:00:00Z",
          groups: [],
          tags: { env: "prod" },
          criticality: 5,
        },
      ],
    }),
    getProject: async (id: string) => ({
      id,
      name: "my-app",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-06-01T00:00:00Z",
      groups: ["group-1"],
      tags: {},
      repoUrl: "https://github.com/org/my-app",
      mainBranch: "main",
      criticality: 3,
    }),
    ...overrides,
  } as unknown as CheckmarxClient;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK internals for test harness
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler: (args: Record<string, unknown>) => Promise<unknown> }
  >;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.handler(args);
}

describe("Project Tools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "1.0.0" });
  });

  describe("health_check", () => {
    it("returns ok when API is reachable", async () => {
      const client = createMockClient();
      registerProjectTools(server, client);

      const result = await callTool(server, "health_check");
      const parsed = JSON.parse(result.content[0]?.text);

      expect(parsed.ok).toBe(true);
      expect(parsed.message).toBe("Connected to Checkmarx One");
      expect(result.isError).toBeFalsy();
    });

    it("returns error when API is unreachable", async () => {
      const client = createMockClient({
        healthCheck: async () => ({ ok: false, message: "Health check failed: Network error" }),
      });
      registerProjectTools(server, client);

      const result = await callTool(server, "health_check");
      const parsed = JSON.parse(result.content[0]?.text);

      expect(parsed.ok).toBe(false);
      expect(result.isError).toBe(true);
    });
  });

  describe("list_projects", () => {
    it("returns shaped project list", async () => {
      const client = createMockClient();
      registerProjectTools(server, client);

      const result = await callTool(server, "list_projects", { limit: 10, offset: 0 });
      const parsed = JSON.parse(result.content[0]?.text);

      expect(parsed.totalCount).toBe(2);
      expect(parsed.projects).toHaveLength(2);
      expect(parsed.projects[0].id).toBe("proj-1");
      expect(parsed.projects[0].name).toBe("my-app");
      expect(parsed.projects[0].repoUrl).toBe("https://github.com/org/my-app");
      expect(parsed.projects[0]).not.toHaveProperty("createdAt");
    });

    it("returns error on client failure", async () => {
      const client = createMockClient({
        listProjects: async () => {
          throw new Error("API unavailable");
        },
      });
      registerProjectTools(server, client);

      const result = await callTool(server, "list_projects", { limit: 10, offset: 0 });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("API unavailable");
    });
  });

  describe("get_project", () => {
    it("returns full project details", async () => {
      const client = createMockClient();
      registerProjectTools(server, client);

      const result = await callTool(server, "get_project", {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
      });
      const parsed = JSON.parse(result.content[0]?.text);

      expect(parsed.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(parsed.name).toBe("my-app");
    });

    it("returns error for nonexistent project", async () => {
      const client = createMockClient({
        getProject: async () => {
          throw new Error("Project not found");
        },
      });
      registerProjectTools(server, client);

      const result = await callTool(server, "get_project", {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Project not found");
    });
  });
});
