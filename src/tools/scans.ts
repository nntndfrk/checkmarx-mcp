import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CheckmarxClient } from "../api/client.js";
import type { ScanType } from "../api/types.js";

const ScanStatusEnum = z.enum(["Queued", "Running", "Completed", "Failed", "Partial", "Canceled"]);
const ScanTypeEnum = z.enum(["sast", "sca", "kics", "apisec", "secrets"]);

export function registerScanTools(server: McpServer, client: CheckmarxClient): void {
  server.tool(
    "list_scans",
    "List recent scans, optionally filtered by project and status. Returns scan IDs, status, engines, and timestamps.",
    {
      projectId: z.string().uuid().optional().describe("Filter by project UUID (uses default if set)"),
      limit: z.number().int().min(1).max(100).default(10).describe("Max results to return"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      statuses: z.array(ScanStatusEnum).optional().describe("Filter by scan statuses"),
    },
    async ({ projectId, limit, offset, statuses }) => {
      try {
        const resolvedProjectId = projectId ?? undefined;
        const result = await client.listScans({
          projectId: resolvedProjectId,
          limit,
          offset,
          statuses,
          sort: "-created_at",
        });
        const shaped = {
          totalCount: result.totalCount,
          scans: result.items.map((s) => ({
            id: s.id,
            status: s.status,
            projectId: s.projectId,
            projectName: s.projectName,
            branch: s.branch,
            engines: s.engines,
            sourceType: s.sourceType,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            statusDetails: s.statusDetails,
          })),
        };
        return { content: [{ type: "text", text: JSON.stringify(shaped, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error listing scans: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_scan",
    "Get details for a specific scan. Use this to poll scan status after triggering a scan.",
    {
      scanId: z.string().uuid().describe("The scan UUID"),
    },
    async ({ scanId }) => {
      try {
        const scan = await client.getScan(scanId);
        return { content: [{ type: "text", text: JSON.stringify(scan, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error getting scan: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "trigger_scan_git",
    "Trigger a new scan from a Git repository URL. Returns the created scan with its ID for status polling.",
    {
      projectId: z
        .string()
        .uuid()
        .optional()
        .describe("Project UUID (uses CHECKMARX_PROJECT_ID if not provided)"),
      repoUrl: z.string().url().describe("Git repository URL to scan"),
      branch: z.string().min(1).describe("Branch name to scan"),
      scanTypes: z
        .array(ScanTypeEnum)
        .optional()
        .describe("Scanner engines to run (defaults to sast, sca, kics)"),
    },
    async ({ projectId, repoUrl, branch, scanTypes }) => {
      try {
        const scan = await client.createScanFromGit({
          projectId,
          repoUrl,
          branch,
          scanTypes: scanTypes as ScanType[] | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  message: "Scan triggered successfully. Use get_scan to poll for completion.",
                  scanId: scan.id,
                  status: scan.status,
                  projectId: scan.projectId,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error triggering git scan: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "trigger_scan_local",
    "Scan a local directory by zipping and uploading it. Returns the created scan ID for status polling.",
    {
      projectId: z
        .string()
        .uuid()
        .optional()
        .describe("Project UUID (uses CHECKMARX_PROJECT_ID if not provided)"),
      directory: z.string().min(1).describe("Absolute path to local directory to scan"),
      branch: z
        .string()
        .optional()
        .describe("Branch name label for the scan (defaults to 'local-scan')"),
      scanTypes: z
        .array(ScanTypeEnum)
        .optional()
        .describe("Scanner engines to run (defaults to sast, sca, kics)"),
      excludePatterns: z
        .array(z.string())
        .optional()
        .describe("Additional glob patterns to exclude from zip (node_modules, .git already excluded)"),
    },
    async ({ projectId, directory, branch, scanTypes, excludePatterns }) => {
      try {
        const { zipDirectory } = await import("../utils/zip.js");
        const zipBuffer = await zipDirectory(directory, excludePatterns);

        const scan = await client.createScanFromUpload({
          projectId,
          zipBuffer,
          branch,
          scanTypes: scanTypes as ScanType[] | undefined,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  message: "Local scan triggered successfully. Use get_scan to poll for completion.",
                  scanId: scan.id,
                  status: scan.status,
                  projectId: scan.projectId,
                  directory,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error triggering local scan: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    },
  );
}
