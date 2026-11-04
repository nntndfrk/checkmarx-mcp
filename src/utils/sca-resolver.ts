import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScaResolverConfig } from "../config.js";
import type { Logger } from "../logger.js";

const DOWNLOAD_BASE_URL = "https://sca-downloads.s3.amazonaws.com/cli";
const BINARY = "ScaResolver";
const CONFIG_FILE = "Configuration.yml";
const OUTPUT_FILE = "sca.json";
const DOWNLOAD_TIMEOUT_MS = 300_000;
const QUICK_COMMAND_TIMEOUT_MS = 30_000;
const LOG_TAIL_LINES = 50;
const MAX_OUTPUT_CHARS = 256 * 1024;

/** SCA Resolver exit codes, plus the ones `docker run` uses when it can't start the command. */
const EXIT_CODES: Record<number, string> = {
  4: "internal error",
  5: "parsing error",
  9: "package manager error",
  10: "unsupported configuration",
  125: "Docker could not start the container",
  126: "the resolver binary is not executable",
  127: "the resolver binary was not found",
};

export class ScaResolverError extends Error {
  constructor(message: string, output = "") {
    const tail = lastLines(output, LOG_TAIL_LINES);
    super(
      tail ? `${message}\n\nLast ${LOG_TAIL_LINES} lines of resolver output:\n${tail}` : message,
    );
    this.name = "ScaResolverError";
  }
}

export interface ScaResolution {
  /** Resolver output, to be added to the zip as `.cxsca-results.json`. */
  outputPath: string;
  version: string;
  /** Unique resolved packages, when the output lists them. */
  packageCount?: number;
}

export interface ResolveOptions {
  /** Directory to resolve. The resolver may write into it, so pass a copy. */
  sourceDir: string;
  /** Empty directory for the output file and logs. */
  outDir: string;
  projectName: string;
  /** Extra resolver arguments, already split (see `splitArgs`). */
  params: string[];
}

/**
 * Splits `--sca-resolver-params` the way `cx` does (`parseArgs` in ast-cli
 * `internal/commands/scan.go`): whitespace separates arguments, and single or
 * double quotes group text and are removed.
 */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of input) {
    if (quote === undefined && (char === "'" || char === '"')) {
      quote = char;
    } else if (char === quote) {
      quote = undefined;
    } else if (quote === undefined && /\s/.test(char)) {
      if (current) args.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Runs Checkmarx SCA Resolver in offline mode, as `cx scan create
 * --sca-resolver` does, either natively or as the linux64 build in Docker.
 */
export class ScaResolver {
  constructor(
    private readonly config: ScaResolverConfig,
    private readonly logger: Logger,
    private readonly cacheDir = join(homedir(), ".cache", "checkmarx-mcp", "sca-resolver"),
  ) {}

  get enabled(): boolean {
    return this.config.mode !== undefined;
  }

  async resolve(options: ResolveOptions): Promise<ScaResolution> {
    const { mode } = this.config;
    if (!mode) {
      throw new ScaResolverError(
        "SCA Resolver is not configured. Set CHECKMARX_SCA_RESOLVER to 'docker' or 'native'.",
      );
    }

    await mkdir(options.outDir, { recursive: true });
    const outputPath = join(options.outDir, OUTPUT_FILE);
    const { version, output } =
      mode === "docker" ? await this.runDocker(options) : await this.runNative(options);

    let raw: string;
    try {
      raw = await readFile(outputPath, "utf8");
    } catch {
      throw new ScaResolverError(`SCA Resolver finished without writing ${OUTPUT_FILE}`, output);
    }
    return { outputPath, version, packageCount: countPackages(raw) };
  }

  private async runDocker(options: ResolveOptions): Promise<{ version: string; output: string }> {
    const docker = await runProcess("docker", ["info"], { timeoutMs: QUICK_COMMAND_TIMEOUT_MS });
    if (docker.error || docker.code !== 0) {
      throw new ScaResolverError("Docker is not running. Start Docker Desktop.");
    }

    const resolverDir = await this.install();
    // The resolver writes logs/ next to its binary, so a writable folder is
    // mounted over the empty logs/ folder of the read-only resolver mount.
    const logsDir = join(options.outDir, "logs");
    await mkdir(logsDir, { recursive: true });

    const name = `checkmarx-mcp-sca-${randomUUID()}`;
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--platform",
      this.config.platform,
      "-v",
      `${options.sourceDir}:/src`,
      "-v",
      `${resolverDir}:/opt/sca:ro`,
      "-v",
      `${logsDir}:/opt/sca/logs`,
      "-v",
      `${options.outDir}:/out`,
      "-w",
      "/out",
      this.config.image,
      `/opt/sca/${BINARY}`,
      ...offlineArgs("/src", options.projectName, `/out/${OUTPUT_FILE}`, options.params),
    ];

    this.logger.info(`Running SCA Resolver ${this.config.version} in ${this.config.image}`);
    const result = await runProcess("docker", args, {
      timeoutMs: this.config.timeoutMs,
      // Killing `docker run` does not stop the container.
      onTimeout: () => void runProcess("docker", ["rm", "-f", name], {}),
    });
    this.checkResult(result);
    return { version: this.config.version, output: result.output };
  }

  private async runNative(options: ResolveOptions): Promise<{ version: string; output: string }> {
    const binary = this.config.path as string;
    const versionResult = await runProcess(binary, ["--version"], {
      timeoutMs: QUICK_COMMAND_TIMEOUT_MS,
    });
    this.checkResult(versionResult);
    const version = versionResult.output.match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown";

    this.logger.info(`Running SCA Resolver ${version} from ${binary}`);
    const result = await runProcess(
      binary,
      offlineArgs(
        options.sourceDir,
        options.projectName,
        join(options.outDir, OUTPUT_FILE),
        options.params,
      ),
      { cwd: options.outDir, timeoutMs: this.config.timeoutMs },
    );
    this.checkResult(result);
    return { version, output: result.output };
  }

  private checkResult(result: ProcessResult): void {
    if (result.error) {
      throw new ScaResolverError(`Could not start SCA Resolver: ${result.error.message}`);
    }
    if (result.timedOut) {
      throw new ScaResolverError(
        `SCA Resolver timed out after ${this.config.timeoutMs} ms`,
        result.output,
      );
    }
    if (result.code !== 0) {
      const meaning = EXIT_CODES[result.code ?? -1] ?? "unknown error";
      throw new ScaResolverError(
        `SCA Resolver failed with exit code ${result.code} (${meaning})`,
        result.output,
      );
    }
  }

  /** Downloads the linux64 build once to `<cacheDir>/<version>/` and returns that folder. */
  private async install(): Promise<string> {
    const { version } = this.config;
    const dir = join(this.cacheDir, version);
    if (await isInstalled(dir)) return dir;

    const url = `${DOWNLOAD_BASE_URL}/${version}/ScaResolver-linux64.tar.gz`;
    this.logger.info(`Downloading SCA Resolver ${version} from ${url}`);
    const archive = await download(url);

    const expected = this.config.sha256 ?? (await publishedChecksum(`${url}.sha256sum`));
    const actual = createHash("sha256").update(archive).digest("hex");
    if (expected && expected.toLowerCase() !== actual) {
      throw new ScaResolverError(
        `SHA-256 mismatch for ${url}: expected ${expected.toLowerCase()}, got ${actual}`,
      );
    }
    if (!expected) {
      this.logger.info(`No checksum published for ${url}; the download was not verified`);
    }

    await mkdir(this.cacheDir, { recursive: true });
    const staging = await mkdtemp(join(this.cacheDir, `.${version}-`));
    try {
      const archivePath = join(staging, "ScaResolver-linux64.tar.gz");
      await writeFile(archivePath, archive);
      const tar = await runProcess("tar", ["-xzf", archivePath, "-C", staging], {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      if (tar.error || tar.code !== 0) {
        throw new ScaResolverError(`Could not extract ${url}`, tar.output);
      }
      await rm(archivePath);
      if (!(await isInstalled(staging))) {
        throw new ScaResolverError(`${url} does not contain ${BINARY} and ${CONFIG_FILE}`);
      }
      await mkdir(join(staging, "logs"));
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      // Another server process may have installed the same version meanwhile.
      if (await isInstalled(dir)) return dir;
      throw error;
    }
    return dir;
  }
}

function offlineArgs(
  sourceDir: string,
  projectName: string,
  outputPath: string,
  params: string[],
): string[] {
  return ["offline", "-s", sourceDir, "-n", projectName, "-r", outputPath, ...params];
}

async function isInstalled(dir: string): Promise<boolean> {
  try {
    await access(join(dir, BINARY));
    await access(join(dir, CONFIG_FILE));
    return true;
  } catch {
    return false;
  }
}

async function download(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScaResolverError(`Could not download ${url}: ${message}`);
  }
  if (!response.ok) {
    throw new ScaResolverError(`Could not download ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Reads `<url>.sha256sum`. Returns undefined when none is published. */
async function publishedChecksum(url: string): Promise<string | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(QUICK_COMMAND_TIMEOUT_MS) });
  if (response.status === 403 || response.status === 404) return undefined;
  if (!response.ok) {
    throw new ScaResolverError(`Could not download ${url}: HTTP ${response.status}`);
  }
  const checksum = (await response.text()).trim().split(/\s+/)[0] ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(checksum)) {
    throw new ScaResolverError(`${url} does not contain a SHA-256 digest`);
  }
  return checksum;
}

/** Counts unique `name@version` pairs in `DependencyResolutionResults[].Dependencies`. */
function countPackages(raw: string): number | undefined {
  try {
    const output = JSON.parse(raw.replace(/^\uFEFF/, "")) as {
      DependencyResolutionResults?: Array<{
        Dependencies?: Array<{ Id?: { Name?: string; Version?: string } }>;
      }>;
    };
    if (!Array.isArray(output.DependencyResolutionResults)) return undefined;
    const packages = new Set<string>();
    for (const result of output.DependencyResolutionResults) {
      for (const dependency of result.Dependencies ?? []) {
        packages.add(`${dependency.Id?.Name}@${dependency.Id?.Version}`);
      }
    }
    return packages.size;
  } catch {
    return undefined;
  }
}

function lastLines(output: string, count: number): string {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-count)
    .join("\n");
}

interface ProcessResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  error?: Error;
}

/** Runs a command without a shell and keeps the tail of stdout and stderr. */
function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; onTimeout?: () => void },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
    };

    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            options.onTimeout?.();
            child.kill("SIGKILL");
          }, options.timeoutMs);

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output, timedOut, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}
