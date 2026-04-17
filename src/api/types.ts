export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type FindingState =
  | "TO_VERIFY"
  | "CONFIRMED"
  | "URGENT"
  | "NOT_EXPLOITABLE"
  | "PROPOSED_NOT_EXPLOITABLE";

export type FindingStatus = "NEW" | "RECURRENT" | "FIXED";

export type ScanStatus = "Queued" | "Running" | "Completed" | "Failed" | "Partial" | "Canceled";

export type ScanType = "sast" | "sca" | "kics" | "apisec" | "secrets" | "containers";

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  groups: string[];
  tags: Record<string, string>;
  repoUrl?: string;
  mainBranch?: string;
  criticality: number;
}

export interface Scan {
  id: string;
  status: ScanStatus;
  statusDetails: ScanStatusDetail[];
  projectId: string;
  projectName?: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  engines: string[];
  sourceType: string;
  sourceOrigin: string;
  initiator: string;
  tags: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface ScanStatusDetail {
  name: string;
  status: string;
  details?: string;
}

export interface FindingDataMap {
  sast: SastFindingData;
  sca: ScaFindingData;
  kics: KicsFindingData;
  apisec: Record<string, unknown>;
  secrets: Record<string, unknown>;
  containers: ContainersFindingData;
}

export interface Finding<T extends ScanType = ScanType> {
  id: string;
  type: T;
  similarityId: string;
  status: FindingStatus;
  state: FindingState;
  severity: Severity;
  createdAt: string;
  firstFoundAt: string;
  foundAt: string;
  firstScanId: string;
  description: string;
  descriptionHTML?: string;
  data: T extends keyof FindingDataMap ? FindingDataMap[T] : Record<string, unknown>;
  comments?: FindingComment[];
  vulnerabilityDetails?: VulnerabilityDetails;
}

export interface SastFindingData {
  queryId: number;
  queryName: string;
  group: string;
  resultHash: string;
  languageName: string;
  nodes: SastNode[];
}

export interface SastNode {
  id: string;
  line: number;
  column: number;
  length: number;
  method: string;
  nodeHash: string;
  fileName: string;
  fullName: string;
  typeName: string;
  methodLine: number;
  definitions: string;
}

export interface ScaFindingData {
  packageIdentifier: string;
  publishedAt?: string;
  recommendation?: string;
  recommendedVersion?: string;
  exploitablePathData?: unknown;
  packageData?: ScaPackageData;
}

export interface ScaPackageData {
  type: string;
  url: string;
}

export interface ContainersFindingData {
  packageIdentifier: string;
  packageName?: string;
  packageVersion?: string;
  imageName?: string;
  imageTag?: string;
  imageDigest?: string;
  baseImage?: string;
  layerId?: string;
  recommendedVersion?: string;
  recommendedImage?: string;
  recommendation?: string;
}

export interface KicsFindingData {
  queryId: string;
  queryName: string;
  group: string;
  queryUrl: string;
  fileName: string;
  platform: string;
  issueType: string;
  searchKey: string;
  searchLine: number;
  searchValue: string;
  expectedValue: string;
  actualValue: string;
}

export interface FindingComment {
  comment: string;
  createdAt: string;
  createdBy: string;
}

export interface VulnerabilityDetails {
  cweId?: number;
  cveId?: string;
  cvssScore?: number;
  cvss?: CvssDetails;
  compliances?: string[];
}

export interface CvssDetails {
  version: number;
  attackVector?: string;
  integrity?: string;
  availability?: string;
  confidentiality?: string;
  score: number;
}

export interface FindingSummary {
  scanId: string;
  totalCounter: number;
  counters: SummaryCounter[];
  statusCounters: StatusCounter[];
  containersCounters?: EngineCounters;
  scaContainersCounters?: EngineCounters;
}

export interface EngineCounters {
  totalCounter: number;
  severityCounters: Array<{ severity: Severity; counter: number }>;
}

export interface SummaryCounter {
  type: ScanType;
  severity: Severity;
  counter: number;
}

export interface StatusCounter {
  status: string;
  counter: number;
}

export interface PaginatedResponse<T> {
  totalCount: number;
  filteredTotalCount: number;
  items: T[];
}

export interface UploadUrlResponse {
  url: string;
}

export type CreateScanRequest = CreateScanGitRequest | CreateScanUploadRequest;

interface CreateScanBase {
  project: { id: string };
  config: ScanConfig[];
  tags?: Record<string, string>;
}

export interface CreateScanGitRequest extends CreateScanBase {
  type: "git";
  handler: CreateScanGitHandler;
}

export interface CreateScanUploadRequest extends CreateScanBase {
  type: "upload";
  handler: CreateScanUploadHandler;
}

export interface CreateScanGitHandler {
  repoUrl: string;
  branch: string;
}

export interface CreateScanUploadHandler {
  uploadUrl: string;
  branch: string;
}

export interface ScanConfig {
  type: ScanType;
  value: Record<string, unknown>;
}

export interface ListProjectsParams {
  name?: string;
  limit?: number;
  offset?: number;
}

export interface ListScansParams {
  projectId?: string;
  limit?: number;
  offset?: number;
  statuses?: ScanStatus[];
  sort?: string;
}

export interface ListFindingsParams {
  scanId: string;
  severity?: Severity[];
  type?: ScanType[];
  state?: FindingState[];
  limit?: number;
  offset?: number;
}

export interface CheckmarxApiError {
  code: number;
  message: string;
  type?: string;
  correlationId?: string;
}
