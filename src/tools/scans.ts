import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type CheckmarxClient, DEFAULT_SCAN_TYPES } from "../api/client.js";
import type { ScanType } from "../api/types.js";
import { type ScaResolution, type ScaResolver, splitArgs } from "../utils/sca-resolver.js";
import { type ExtraZipEntry, stageDirectory, zipDirectory } from "../utils/zip.js";

const ScanStatusEnum = z.enum(["Queued", "Running", "Completed", "Failed", "Partial", "Canceled"]);
const ScanTypeEnum = z.enum(["sast", "sca", "kics", "apisec", "secrets", "containers"]);

// Permissive image reference matcher: [registry[:port]/][namespace/]name[:tag][@digest]
// Covers docker.io/library defaults, GHCR, public ECR, Quay, and digest-pinned refs.
const IMAGE_REF_REGEX =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/;

/** Name `cx` gives the SCA Resolver output inside the zip. */
const SCA_RESULTS_ENTRY = ".cxsca-results.json";

export function registerScanTools(
  server: McpServer,
  client: CheckmarxClient,
  scaResolver?: ScaResolver,
): void {
  server.tool(
    "list_scans",
    "List recent scans, optionally filtered by project and status. Returns scan IDs, status, engines, and timestamps.",
    {
      projectId: z
        .string()
        .uuid()
        .optional()
        .describe("Filter by project UUID (uses default if set)"),
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
          content: [
            {
              type: "text",
              text: `Error listing scans: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
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
          content: [
            {
              type: "text",
              text: `Error getting scan: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
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
        .describe(
          "Scanner engines to run (defaults to sast, sca, kics). " +
            "Use 'containers' to scan Dockerfiles and their base image layers for CVEs.",
        ),
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
            {
              type: "text",
              text: `Error triggering git scan: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "trigger_scan_local",
    "Scan a local directory by zipping and uploading it. Returns the created scan ID for status polling. " +
      "By default the zip holds the same files as a `cx scan create` pipeline scan, so results can be compared. " +
      "Local build output and caches (e.g. dist/, .angular/) are included like cx does; " +
      "add them to excludePatterns if the pipeline scans a clean checkout. " +
      "Use a separate branch label (e.g. '<branch>-mcp') so manual scans don't mix into the real branch history. " +
      "When SCA Resolver is configured, dependencies are resolved locally as cx --sca-resolver does, " +
      "so the scan stores the same SCA packages and findings as the pipeline scan.",
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
        .describe(
          "Scanner engines to run (defaults to sast, sca, kics). " +
            "Use 'containers' to scan Dockerfiles and their base image layers for CVEs.",
        ),
      excludePatterns: z
        .array(z.string())
        .optional()
        .describe(
          "Additional glob patterns to exclude from zip (node_modules, .git already excluded)",
        ),
      zipMode: z
        .enum(["cx", "all"])
        .default("cx")
        .describe(
          "Which files go into the zip. 'cx' (default): the file types the cx CLI uploads, " +
            "skipping node_modules, .git, .vs, .vscode and .idea. " +
            "'all': every file type, skipping build output, dependency and tool folders " +
            "(dist, build, vendor, iac, .angular and similar).",
        ),
      sastFilter: z
        .string()
        .optional()
        .describe("SAST file filter, same as cx --sast-filter (e.g. '!*.spec.ts,!test')"),
      scaFilter: z.string().optional().describe("SCA file filter, same as cx --sca-filter"),
      kicsFilter: z
        .string()
        .optional()
        .describe("KICS (IaC) file filter, same as cx --iac-security-filter"),
      presetName: z.string().optional().describe("SAST preset name, same as cx --sast-preset-name"),
      incremental: z
        .boolean()
        .optional()
        .describe("Run an incremental SAST scan, same as cx --sast-incremental"),
      scaResolution: z
        .enum(["local", "cloud"])
        .optional()
        .describe(
          "Where SCA dependencies are resolved. 'local': run SCA Resolver on the directory and upload " +
            "its result, as cx --sca-resolver does (needs CHECKMARX_SCA_RESOLVER). " +
            "'cloud': Checkmarx resolves the uploaded lock files, dev dependencies included. " +
            "Defaults to 'local' when SCA Resolver is configured and sca is requested, else 'cloud'.",
        ),
      scaResolverParams: z
        .string()
        .optional()
        .describe(
          "SCA Resolver arguments, the same string as cx --sca-resolver-params " +
            "(e.g. \"--ignore-dev-dependencies --extract-archives zip,ear,war\"). Only for scaResolution 'local'.",
        ),
    },
    async ({
      projectId,
      directory,
      branch,
      scanTypes,
      excludePatterns,
      zipMode,
      sastFilter,
      scaFilter,
      kicsFilter,
      presetName,
      incremental,
      scaResolution,
      scaResolverParams,
    }) => {
      const types = (scanTypes ?? DEFAULT_SCAN_TYPES) as ScanType[];
      const resolution =
        scaResolution ?? (scaResolver?.enabled && types.includes("sca") ? "local" : "cloud");
      let workDir: string | undefined;
      try {
        if (resolution === "local" && !scaResolver?.enabled) {
          throw new Error(
            "scaResolution 'local' needs SCA Resolver. Set CHECKMARX_SCA_RESOLVER to 'docker' or 'native'.",
          );
        }
        if (resolution === "local" && !types.includes("sca")) {
          throw new Error("scaResolution 'local' needs 'sca' in scanTypes.");
        }
        if (resolution === "cloud" && scaResolverParams) {
          throw new Error("scaResolverParams is only used with scaResolution 'local'.");
        }

        const extraEntries: ExtraZipEntry[] = [];
        let sca: ScaResolution | undefined;
        if (resolution === "local" && scaResolver) {
          const project = await client.getProject(client.resolveProjectId(projectId));
          workDir = await mkdtemp(join(tmpdir(), "checkmarx-mcp-sca-"));
          const stageDir = join(workDir, "src");
          await stageDirectory(directory, stageDir, excludePatterns, zipMode);
          sca = await scaResolver.resolve({
            sourceDir: stageDir,
            outDir: join(workDir, "out"),
            projectName: project.name,
            params: splitArgs(scaResolverParams ?? ""),
          });
          extraEntries.push({ name: SCA_RESULTS_ENTRY, path: sca.outputPath });
        }

        const zipBuffer = await zipDirectory(directory, excludePatterns, zipMode, extraEntries);

        const scan = await client.createScanFromUpload({
          projectId,
          zipBuffer,
          branch,
          scanTypes: scanTypes as ScanType[] | undefined,
          settings: { sastFilter, scaFilter, kicsFilter, presetName, incremental },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  message:
                    "Local scan triggered successfully. Use get_scan to poll for completion.",
                  scanId: scan.id,
                  status: scan.status,
                  projectId: scan.projectId,
                  directory,
                  ...(types.includes("sca") && { scaResolution: resolution }),
                  ...(sca && {
                    scaResolver: { version: sca.version, packageCount: sca.packageCount },
                  }),
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
            {
              type: "text",
              text: `Error triggering local scan: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      } finally {
        if (workDir) await rm(workDir, { recursive: true, force: true });
      }
    },
  );

  server.tool(
    "trigger_scan_image",
    "Scan a specific container image (e.g. 'nginx:1.27-alpine-slim', 'ghcr.io/org/app:v1') via Checkmarx Container Security. " +
      "Works for any public registry (Docker Hub, GHCR, public ECR, Quay). Returns a scan ID for polling. " +
      "For private registries, set up a Private Registry Integration in Checkmarx One first.",
    {
      projectId: z
        .string()
        .uuid()
        .optional()
        .describe("Project UUID (uses CHECKMARX_PROJECT_ID if not provided)"),
      image: z
        .string()
        .min(1)
        .regex(
          IMAGE_REF_REGEX,
          "Invalid image reference. Expected forms: name:tag, registry/ns/name:tag, name@sha256:<digest>",
        )
        .describe(
          "Image reference in {name}:{tag} form, optionally with registry prefix or @sha256 digest",
        ),
      branch: z
        .string()
        .optional()
        .describe("Branch label for the scan (defaults to a sanitized form of the image ref)"),
    },
    async ({ projectId, image, branch }) => {
      try {
        const scan = await client.createContainerImageScan({
          projectId,
          image,
          branch,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  message:
                    "Container image scan triggered successfully. Use get_scan to poll for completion.",
                  scanId: scan.id,
                  status: scan.status,
                  projectId: scan.projectId,
                  image,
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
            {
              type: "text",
              text: `Error triggering image scan: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
