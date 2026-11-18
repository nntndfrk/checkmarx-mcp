import { randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type CheckmarxClient, DEFAULT_SCAN_TYPES } from "../api/client.js";
import type { ScanType } from "../api/types.js";
import {
  CONTAINER_IMAGE_REGEX,
  type ContainersResolution,
  type ContainersResolver,
  RESOLUTION_FILE,
} from "../utils/containers-resolver.js";
import { type GitCheckout, checkoutGitRef, copyExtraPaths } from "../utils/git-source.js";
import { type ScaResolution, type ScaResolver, splitArgs } from "../utils/sca-resolver.js";
import { type ExtraZipEntry, stageDirectory, zipDirectory, zipFiles } from "../utils/zip.js";

const ScanStatusEnum = z.enum(["Queued", "Running", "Completed", "Failed", "Partial", "Canceled"]);
const ScanTypeEnum = z.enum(["sast", "sca", "kics", "apisec", "secrets", "containers"]);

// Permissive image reference matcher: [registry[:port]/][namespace/]name[:tag][@digest]
// Covers docker.io/library defaults, GHCR, public ECR, Quay, and digest-pinned refs.
const IMAGE_REF_REGEX =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/;

/** Name `cx` gives the SCA Resolver output inside the zip. */
const SCA_RESULTS_ENTRY = ".cxsca-results.json";
/** Where `cx` writes the containers resolver output in the source folder, and so in the zip. */
const CONTAINERS_RESULTS_ENTRY = `.checkmarx/containers/${RESOLUTION_FILE}`;
/** Tenant flag that makes `cx` resolve containers locally (ast-cli `ContainerEngineCLIEnabled`). */
const CONTAINER_ENGINE_CLI_FLAG = "CONTAINER_ENGINE_CLI_ENABLED";

export interface ScanResolvers {
  scaResolver?: ScaResolver;
  containersResolver?: ContainersResolver;
}

export function registerScanTools(
  server: McpServer,
  client: CheckmarxClient,
  { scaResolver, containersResolver }: ScanResolvers = {},
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
      "With scaResolution 'local', dependencies are resolved locally as cx --sca-resolver does, " +
      "and with containersResolution 'local', container images are resolved locally as cx does, " +
      "so the scan stores the same SCA packages and container findings as the pipeline scan. " +
      "Pass gitRef to scan a commit as a CI checkout sees it, plus extraPaths for CI build output. " +
      "The result lists warnings when the scan can't match a cx pipeline scan.",
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
            "Use 'containers' to scan the images in Dockerfiles, Docker Compose files and Helm charts for CVEs.",
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
            "its result, as cx --sca-resolver does. It runs as CHECKMARX_SCA_RESOLVER says, " +
            "or in Docker when that is not set. " +
            "'cloud': Checkmarx resolves the uploaded lock files, dev dependencies included. " +
            "Defaults to 'local' when CHECKMARX_SCA_RESOLVER is set and sca is requested, else 'cloud'.",
        ),
      scaResolverParams: z
        .string()
        .optional()
        .describe(
          "SCA Resolver arguments, the same string as cx --sca-resolver-params " +
            "(e.g. \"--ignore-dev-dependencies --extract-archives zip,ear,war\"). Only for scaResolution 'local'.",
        ),
      containersResolution: z
        .enum(["local", "cloud"])
        .optional()
        .describe(
          "Where container images are resolved. 'local': find the images in Dockerfiles, Docker Compose " +
            "files and Helm charts, analyse them and containerImages with the containers resolver, and upload " +
            "the result, as cx does when the tenant flag CONTAINER_ENGINE_CLI_ENABLED is on. " +
            "It runs as CHECKMARX_CONTAINERS_RESOLVER says, or in Docker when that is not set; images are read " +
            "from the local Docker daemon first, so pull or build private images locally. " +
            "'cloud': Checkmarx resolves the images named in the uploaded files. " +
            "Defaults to 'local' when containers is requested, the flag is on, and " +
            "CHECKMARX_CONTAINERS_RESOLVER is set or containerImages is given; else 'cloud'.",
        ),
      containerImages: z
        .array(
          z
            .string()
            .regex(
              CONTAINER_IMAGE_REGEX,
              "Invalid container image. The value must be in the format <image-name>:<image-tag>",
            ),
        )
        .optional()
        .describe(
          "Images to analyse in addition to the ones found in the files, the same as cx --container-images " +
            "(e.g. the image the pipeline builds and ships, ['registry.example.com/app:1.2.3']). " +
            "Needs 'containers' in scanTypes and containersResolution 'local'.",
        ),
      gitRef: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Scan this commit, branch or tag of the git repository that contains directory, instead of the " +
            "working tree: tracked files only, with no .git, ignored or untracked files, as a CI checkout " +
            "sees it. Your index and working tree are not changed. Submodules are not included.",
        ),
      extraPaths: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Files or folders, relative to directory, copied from the working tree on top of the gitRef " +
            "checkout: the CI build output the pipeline scans, e.g. ['dist', 'iac/generated']. " +
            "They go through the same zip filters as the rest. Needs gitRef.",
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
      containersResolution,
      containerImages,
      gitRef,
      extraPaths,
    }) => {
      const types = (scanTypes ?? DEFAULT_SCAN_TYPES) as ScanType[];
      const scaMode =
        scaResolution ?? (scaResolver?.enabled && types.includes("sca") ? "local" : "cloud");
      const containersRequested = types.includes("containers");
      const warnings: string[] = [];
      let workDir: string | undefined;
      try {
        if (scaMode === "local" && !scaResolver) {
          throw new Error("SCA Resolver is not available in this server.");
        }
        if (scaMode === "local" && !types.includes("sca")) {
          throw new Error("scaResolution 'local' needs 'sca' in scanTypes.");
        }
        if (scaMode === "cloud" && scaResolverParams) {
          throw new Error("scaResolverParams is only used with scaResolution 'local'.");
        }
        if (containersResolution === "local" && !containersRequested) {
          throw new Error("containersResolution 'local' needs 'containers' in scanTypes.");
        }
        if (containerImages?.length && !containersRequested) {
          throw new Error("containerImages needs 'containers' in scanTypes.");
        }
        if (containerImages?.length && containersResolution === "cloud") {
          throw new Error("containerImages is only used with containersResolution 'local'.");
        }
        if (extraPaths?.length && !gitRef) {
          throw new Error(
            "extraPaths needs gitRef. Without gitRef the working tree is scanned as it is.",
          );
        }

        const containersMode = containersRequested
          ? await chooseContainersMode(client, warnings, {
              requested: containersResolution,
              configured: containersResolver?.enabled ?? false,
              hasImages: (containerImages?.length ?? 0) > 0,
            })
          : "cloud";
        if (containersMode === "local" && !containersResolver) {
          throw new Error("The containers resolver is not available in this server.");
        }
        if (types.includes("sca") && scaMode === "cloud") {
          warnings.push(
            "SCA dependencies are resolved in the cloud from the uploaded lock files, dev dependencies " +
              "included, so SCA results will not match a pipeline scan that uses cx --sca-resolver. " +
              "Pass scaResolution 'local' to resolve them as cx does.",
          );
        }

        const projectName =
          scaMode === "local"
            ? (await client.getProject(client.resolveProjectId(projectId))).name
            : undefined;

        let sourceDir = directory;
        let checkout: GitCheckout | undefined;
        if (gitRef) {
          workDir = await mkdtemp(join(tmpdir(), "checkmarx-mcp-scan-"));
          checkout = await checkoutGitRef(
            directory,
            gitRef,
            join(workDir, "checkout"),
            join(workDir, "git-index"),
          );
          await copyExtraPaths(directory, extraPaths ?? [], checkout.dir);
          sourceDir = checkout.dir;
        }

        let stageDir: string | undefined;
        if (scaMode === "local" || containersMode === "local") {
          workDir ??= await mkdtemp(join(tmpdir(), "checkmarx-mcp-scan-"));
          stageDir = join(workDir, "src");
          await stageDirectory(sourceDir, stageDir, excludePatterns, zipMode);
        }

        // Containers first: SCA Resolver may write into the staged folder.
        let containers: ContainersResolution | undefined;
        if (containersMode === "local" && containersResolver && workDir && stageDir) {
          containers = await containersResolver.resolve({
            sourceDir: stageDir,
            outDir: join(workDir, "containers"),
            images: containerImages ?? [],
          });
          if (containers.notAnalyzed.length) {
            warnings.push(
              [
                `The containers resolver could not analyse ${containers.notAnalyzed
                  .map((image) => image.name)
                  .join(", ")}, so the scan has no container findings for them.`,
                "Pull or build these images locally, then scan again.",
              ].join(" "),
            );
          }
        }

        let sca: ScaResolution | undefined;
        if (scaMode === "local" && scaResolver && workDir && stageDir) {
          sca = await scaResolver.resolve({
            sourceDir: stageDir,
            outDir: join(workDir, "sca"),
            projectName: projectName as string,
            params: splitArgs(scaResolverParams ?? ""),
          });
        }

        let zipBuffer: Buffer;
        if (containers && types.length === 1) {
          // `cx` zips only the resolution file when containers is the only scan type
          // (isSingleContainerScanTriggered), in a folder named after its temp zip.
          zipBuffer = await zipFiles([
            {
              name: `cx-${randomInt(2 ** 32)}/${RESOLUTION_FILE}`,
              path: containers.outputPath,
            },
          ]);
        } else {
          const extraEntries: ExtraZipEntry[] = [];
          if (sca) extraEntries.push({ name: SCA_RESULTS_ENTRY, path: sca.outputPath });
          if (containers) {
            extraEntries.push({ name: CONTAINERS_RESULTS_ENTRY, path: containers.outputPath });
          }
          zipBuffer = await zipDirectory(sourceDir, excludePatterns, zipMode, extraEntries);
        }

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
                  ...(checkout && {
                    gitRef: { ref: gitRef, commit: checkout.commit },
                    ...(extraPaths?.length && { extraPaths }),
                  }),
                  ...(types.includes("sca") && { scaResolution: scaMode }),
                  ...(sca &&
                    scaResolver && {
                      scaResolver: {
                        mode: scaResolver.mode,
                        version: sca.version,
                        packageCount: sca.packageCount,
                      },
                    }),
                  ...(containersRequested && { containersResolution: containersMode }),
                  ...(containers &&
                    containersResolver && {
                      containersResolver: {
                        mode: containersResolver.mode,
                        versions: containers.versions,
                        images: containers.images,
                        notAnalyzed: containers.notAnalyzed,
                      },
                    }),
                  ...(warnings.length && { warnings }),
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

/**
 * Picks where container images are resolved, with the same condition as `cx`:
 * it resolves them locally only when the tenant flag CONTAINER_ENGINE_CLI_ENABLED
 * is on. An explicit 'local' (or containerImages) fails when the flag is off;
 * the default falls back to 'cloud' with a warning.
 */
async function chooseContainersMode(
  client: CheckmarxClient,
  warnings: string[],
  options: { requested?: "local" | "cloud"; configured: boolean; hasImages: boolean },
): Promise<"local" | "cloud"> {
  let enabled = false;
  let flagError: string | undefined;
  try {
    enabled = await client.getFeatureFlag(CONTAINER_ENGINE_CLI_FLAG);
  } catch (error) {
    flagError = error instanceof Error ? error.message : String(error);
  }
  const flagState = flagError ? `could not be read (${flagError})` : "is off";
  const explicit = options.requested === "local" || options.hasImages;

  if (options.requested === "cloud" || !(explicit || options.configured)) {
    if (enabled) {
      warnings.push(
        [
          `The tenant flag ${CONTAINER_ENGINE_CLI_FLAG} is on, so a cx pipeline scan resolves container`,
          "images locally and uploads the result. This scan lets Checkmarx resolve them, so container",
          "results and SAST findings in .checkmarx/containers/ will differ.",
          "Pass containersResolution 'local' to resolve them as cx does.",
        ].join(" "),
      );
    }
    return "cloud";
  }
  if (enabled) return "local";
  if (explicit) {
    throw new Error(
      [
        `Local container resolution needs the tenant flag ${CONTAINER_ENGINE_CLI_FLAG}, which ${flagState}.`,
        "cx resolves containers locally only when it is on.",
      ].join(" "),
    );
  }
  warnings.push(
    [
      `CHECKMARX_CONTAINERS_RESOLVER is set, but the tenant flag ${CONTAINER_ENGINE_CLI_FLAG} ${flagState},`,
      "so container images are resolved in the cloud. cx does not resolve them locally either.",
    ].join(" "),
  );
  return "cloud";
}
