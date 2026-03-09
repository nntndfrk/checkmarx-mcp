import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CheckmarxClient } from "../api/client.js";

export function registerProjectTools(server: McpServer, client: CheckmarxClient): void {
  server.tool(
    "health_check",
    "Verify connectivity to the Checkmarx One platform. Returns ok status and a diagnostic message.",
    {},
    async () => {
      try {
        const result = await client.healthCheck();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Health check failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "list_projects",
    "List Checkmarx One projects. Supports filtering by name and pagination.",
    {
      name: z.string().optional().describe("Filter projects by name (partial match)"),
      limit: z.number().int().min(1).max(100).default(10).describe("Max results to return"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    async ({ name, limit, offset }) => {
      try {
        const result = await client.listProjects({ name, limit, offset });
        const shaped = {
          totalCount: result.totalCount,
          projects: result.items.map((p) => ({
            id: p.id,
            name: p.name,
            repoUrl: p.repoUrl,
            mainBranch: p.mainBranch,
            criticality: p.criticality,
            tags: p.tags,
          })),
        };
        return { content: [{ type: "text", text: JSON.stringify(shaped, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error listing projects: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_project",
    "Get details for a specific Checkmarx One project by its ID.",
    {
      projectId: z.string().uuid().describe("The project UUID"),
    },
    async ({ projectId }) => {
      try {
        const project = await client.getProject(projectId);
        return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error getting project: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
