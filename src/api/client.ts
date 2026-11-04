import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { CheckmarxAuth } from "./auth.js";
import type {
  CheckmarxApiError,
  CreateScanGitRequest,
  CreateScanUploadRequest,
  Finding,
  ListFindingsParams,
  ListProjectsParams,
  ListScansParams,
  PaginatedResponse,
  Project,
  Scan,
  ScanConfig,
  ScanSettings,
  ScanSummary,
  ScanSummaryResponse,
  ScanType,
  UploadUrlResponse,
} from "./types.js";

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const RETRY_DELAY_MS = 2_000;
export const DEFAULT_SCAN_TYPES: readonly ScanType[] = ["sast", "sca", "kics"];
/** Page size `cx` uses for `/api/results`. */
const RESULTS_PAGE_SIZE = 10_000;
const MAX_RESULTS_PAGES = 10;
const RESULTS_TIMEOUT_MS = 120_000;

export class CheckmarxClient {
  private readonly baseUrl: string;
  private readonly auth: CheckmarxAuth;
  private readonly logger: Logger;
  private readonly defaultProjectId?: string;

  constructor(config: Config, auth: CheckmarxAuth, logger: Logger) {
    this.baseUrl = config.checkmarx.baseUrl.replace(/\/+$/, "");
    this.auth = auth;
    this.logger = logger;
    this.defaultProjectId = config.checkmarx.projectId;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const token = await this.auth.getToken();
    const url = `${this.baseUrl}${path}`;

    this.logger.debug(`${method} ${path}`);
    if (body !== undefined && !(body instanceof Buffer)) {
      this.logger.debug("Request body", body);
    }

    const fetchOptions: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...headers,
        ...(body !== undefined && !(body instanceof Buffer)
          ? { "Content-Type": "application/json" }
          : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: body instanceof Buffer ? body : body !== undefined ? JSON.stringify(body) : undefined,
    };

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Request failed: ${method} ${path} — ${message}`);
      throw new Error(`Checkmarx API request failed (${method} ${path}): ${message}`);
    }

    this.logger.debug(`Response: ${method} ${path} → HTTP ${response.status}`);

    if (response.status === 429) {
      this.logger.info(`Rate limited on ${method} ${path}, retrying`);
      await response.text().catch(() => {});
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : RETRY_DELAY_MS;
      await this.delay(Number.isNaN(waitMs) ? RETRY_DELAY_MS : waitMs);

      try {
        response = await fetch(url, {
          ...fetchOptions,
          headers: {
            ...(fetchOptions.headers as Record<string, string>),
            Authorization: `Bearer ${await this.auth.getToken()}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Checkmarx API retry failed (${method} ${path}): ${message}`);
      }
    }

    if (response.status >= 500) {
      this.logger.info(`Server error ${response.status} on ${method} ${path}, retrying`);
      await response.text().catch(() => {});
      await this.delay(RETRY_DELAY_MS);

      try {
        response = await fetch(url, {
          ...fetchOptions,
          headers: {
            ...(fetchOptions.headers as Record<string, string>),
            Authorization: `Bearer ${await this.auth.getToken()}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Checkmarx API retry failed (${method} ${path}): ${message}`);
      }
    }

    if (!response.ok) {
      let apiError: CheckmarxApiError;
      try {
        apiError = (await response.json()) as CheckmarxApiError;
      } catch {
        apiError = { code: response.status, message: response.statusText };
      }
      this.logger.error(`API error: ${method} ${path} → HTTP ${response.status}`, apiError);
      throw new CheckmarxRequestError(response.status, apiError, method, path);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  resolveProjectId(explicitId?: string): string {
    const id = explicitId ?? this.defaultProjectId;
    if (!id) {
      throw new Error(
        "No project ID provided. Pass projectId or set CHECKMARX_PROJECT_ID environment variable.",
      );
    }
    return id;
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.request<PaginatedResponse<Project>>("/api/projects?limit=1");
      return { ok: true, message: "Connected to Checkmarx One" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Health check failed: ${message}` };
    }
  }

  async listProjects(params: ListProjectsParams = {}): Promise<PaginatedResponse<Project>> {
    const searchParams = new URLSearchParams();
    if (params.name) searchParams.set("name", params.name);
    searchParams.set("limit", String(params.limit ?? 10));
    searchParams.set("offset", String(params.offset ?? 0));

    const query = searchParams.toString();
    const raw = await this.request<{
      totalCount: number;
      filteredTotalCount: number;
      projects: Project[];
    }>(`/api/projects?${query}`);
    return {
      totalCount: raw.totalCount,
      filteredTotalCount: raw.filteredTotalCount,
      items: raw.projects,
    };
  }

  async getProject(projectId: string): Promise<Project> {
    return this.request<Project>(`/api/projects/${projectId}`);
  }

  async listScans(params: ListScansParams = {}): Promise<PaginatedResponse<Scan>> {
    const searchParams = new URLSearchParams();
    if (params.projectId) searchParams.set("project-id", params.projectId);
    searchParams.set("limit", String(params.limit ?? 10));
    searchParams.set("offset", String(params.offset ?? 0));
    if (params.statuses?.length) searchParams.set("statuses", params.statuses.join(","));
    if (params.sort) searchParams.set("sort", params.sort);

    const query = searchParams.toString();
    const raw = await this.request<{
      totalCount: number;
      filteredTotalCount: number;
      scans: Scan[];
    }>(`/api/scans?${query}`);
    return {
      totalCount: raw.totalCount,
      filteredTotalCount: raw.filteredTotalCount,
      items: raw.scans,
    };
  }

  async getScan(scanId: string): Promise<Scan> {
    return this.request<Scan>(`/api/scans/${scanId}`);
  }

  /**
   * `/api/results` reads `offset` as a page index and ignores `type`, so all
   * pages are fetched (as `cx` does) and type, offset and limit are applied here.
   */
  async getFindings(params: ListFindingsParams): Promise<PaginatedResponse<Finding>> {
    const all = await this.getAllFindings(params);
    const items = params.type?.length
      ? all.filter((finding) => params.type?.includes(finding.type))
      : all;
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 20;
    return {
      totalCount: items.length,
      filteredTotalCount: items.length,
      items: items.slice(offset, offset + limit),
    };
  }

  /** All findings that match the server-side filters (severity, state, dev/test). */
  async getAllFindings(params: ListFindingsParams): Promise<Finding[]> {
    const searchParams = new URLSearchParams();
    searchParams.set("scan-id", params.scanId);
    if (params.severity?.length) searchParams.set("severity", params.severity.join(","));
    if (params.state?.length) searchParams.set("state", params.state.join(","));
    if (params.hideDevAndTestDependencies) {
      // Same filter as `cx results show --sca-hide-dev-test-dependencies`.
      searchParams.set("exclude-result-types", "DEV_AND_TEST");
    }
    searchParams.set("limit", String(RESULTS_PAGE_SIZE));
    searchParams.set("sort", "-severity");

    const findings: Finding[] = [];
    for (let page = 0; page < MAX_RESULTS_PAGES; page++) {
      searchParams.set("offset", String(page));
      const raw = await this.request<{ totalCount: number; results: Finding[] | null }>(
        `/api/results?${searchParams.toString()}`,
        { timeoutMs: RESULTS_TIMEOUT_MS },
      );
      const results = raw.results ?? [];
      findings.push(...results);
      if (results.length < RESULTS_PAGE_SIZE || findings.length >= raw.totalCount) break;
    }
    return findings;
  }

  async getFindingSummary(scanId: string): Promise<ScanSummary> {
    const raw = await this.request<ScanSummaryResponse>(
      `/api/scan-summary?scan-ids=${encodeURIComponent(scanId)}`,
    );
    const summary = raw.scansSummaries?.[0];
    if (!summary) {
      throw new Error(`No summary found for scan ${scanId}`);
    }
    return summary;
  }

  async createUploadUrl(): Promise<UploadUrlResponse> {
    return this.request<UploadUrlResponse>("/api/uploads", { method: "POST" });
  }

  async uploadZip(presignedUrl: string, zipBuffer: Buffer): Promise<void> {
    const urlHost = new URL(presignedUrl).host;
    this.logger.debug(`Uploading zip (${zipBuffer.length} bytes) to ${urlHost}`);

    const doUpload = (headers: Record<string, string> = {}) =>
      fetch(presignedUrl, {
        method: "PUT",
        body: zipBuffer,
        headers,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });

    try {
      let response = await doUpload();

      if (response.status === 401 || response.status === 403) {
        this.logger.debug("Presigned URL rejected without auth, retrying with token");
        const token = await this.auth.getToken();
        response = await doUpload({ Authorization: `Bearer ${token}` });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        this.logger.error(`Upload failed: HTTP ${response.status} — ${body}`);
        throw new Error(`Upload failed with HTTP ${response.status}`);
      }
      this.logger.debug("Upload completed successfully");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Upload failed")) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Zip upload failed: ${message}`);
    }
  }

  async createScanFromGit(params: {
    projectId?: string;
    repoUrl: string;
    branch: string;
    scanTypes?: ScanType[];
  }): Promise<Scan> {
    const projectId = this.resolveProjectId(params.projectId);
    const config = this.buildScanConfig(params.scanTypes);

    const request: CreateScanGitRequest = {
      type: "git",
      project: { id: projectId },
      handler: { repoUrl: params.repoUrl, branch: params.branch },
      config,
    };

    return this.request<Scan>("/api/scans", { method: "POST", body: request });
  }

  async createScanFromUpload(params: {
    projectId?: string;
    zipBuffer: Buffer;
    branch?: string;
    scanTypes?: ScanType[];
    settings?: ScanSettings;
  }): Promise<Scan> {
    const projectId = this.resolveProjectId(params.projectId);

    const { url } = await this.createUploadUrl();
    await this.uploadZip(url, params.zipBuffer);

    const config = this.buildScanConfig(params.scanTypes, params.settings);

    const request: CreateScanUploadRequest = {
      type: "upload",
      project: { id: projectId },
      handler: { uploadUrl: url, branch: params.branch ?? "local-scan" },
      config,
    };

    return this.request<Scan>("/api/scans", { method: "POST", body: request });
  }

  async createContainerImageScan(params: {
    projectId?: string;
    image: string;
    branch?: string;
  }): Promise<Scan> {
    const { synthesizeDockerfileZip } = await import("../utils/zip.js");
    const zipBuffer = await synthesizeDockerfileZip(params.image);
    return this.createScanFromUpload({
      projectId: params.projectId,
      zipBuffer,
      branch: params.branch ?? `image-scan-${sanitizeImageRef(params.image)}`,
      scanTypes: ["containers"],
    });
  }

  /**
   * Builds the per-engine config the same way `cx scan create` does: only the
   * settings that were given are sent. `cx` drops `enableContainersScan: false`
   * from the SCA value, so nothing extra is sent when containers is requested.
   */
  private buildScanConfig(scanTypes?: ScanType[], settings: ScanSettings = {}): ScanConfig[] {
    const types = scanTypes ?? DEFAULT_SCAN_TYPES;

    return types.map((type) => {
      const value: Record<string, string> = {};
      if (type === "sast") {
        if (settings.sastFilter) value.filter = settings.sastFilter;
        if (settings.presetName) value.presetName = settings.presetName;
        if (settings.incremental !== undefined) value.incremental = String(settings.incremental);
      } else if (type === "sca") {
        if (settings.scaFilter) value.filter = settings.scaFilter;
      } else if (type === "kics") {
        if (settings.kicsFilter) value.filter = settings.kicsFilter;
      }
      return { type, value };
    });
  }
}

function sanitizeImageRef(image: string): string {
  return (
    image
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "image"
  );
}

export class CheckmarxRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly apiError: CheckmarxApiError,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(`Checkmarx API error (${method} ${path}, HTTP ${statusCode}): ${apiError.message}`);
    this.name = "CheckmarxRequestError";
  }
}
