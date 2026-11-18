import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContainersResolverConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { type ProcessResult, lastLines, runProcess } from "./process.js";

const BINARY = "containers-resolver";
/** Name `cx` gives the resolver output. */
export const RESOLUTION_FILE = "containers-resolution.json";
const IMAGES_FILE = "images.json";
/** Image the wrapper is built and run in. ast-cli 2.3.27 needs Go 1.24. */
const GO_IMAGE = "golang:1.24";
const AST_CLI_REPO = "https://github.com/Checkmarx/ast-cli";
const WRAPPER_PACKAGE = "./cmd/cxmcp-containers-resolver";
/** Mounted into the container so that stereoscope reads images from the local daemon. */
const DOCKER_SOCKET = "/var/run/docker.sock";
const BUILD_TIMEOUT_MS = 1_800_000;
const QUICK_COMMAND_TIMEOUT_MS = 30_000;
const LOG_TAIL_LINES = 50;
/** Wrapper source (`containers-resolver/main.go`), shipped next to `dist/`. */
const WRAPPER_DIR = fileURLToPath(new URL("../../containers-resolver/", import.meta.url));

/**
 * Same check as `cx --container-images` (`validateContainerImageFormat` in
 * ast-cli 2.3.27 `internal/commands/scan.go`): `<image-name>:<image-tag>`.
 */
export const CONTAINER_IMAGE_REGEX =
  /^(?:[a-zA-Z0-9.-]+(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[\w][\w.-]{0,127}$/;

/** Exit codes of the wrapper, plus the ones `docker run` uses when it can't start the command. */
const EXIT_CODES: Record<number, string> = {
  1: "resolver error",
  2: "invalid arguments",
  125: "Docker could not start the container",
  126: "the resolver binary is not executable",
  127: "the resolver binary was not found",
};

export class ContainersResolverError extends Error {
  constructor(message: string, output = "") {
    const tail = lastLines(output, LOG_TAIL_LINES);
    super(
      tail ? `${message}\n\nLast ${LOG_TAIL_LINES} lines of resolver output:\n${tail}` : message,
    );
    this.name = "ContainersResolverError";
  }
}

export interface ResolvedImage {
  /** The image as the resolver read it, e.g. `nginx:1.27`. */
  name: string;
  /** Where it was found: `UserInput`, `Dockerfile`, `DockerCompose` or `Helm`. */
  origins: string[];
  /** Files that reference it. */
  paths: string[];
  packageCount: number;
}

export interface ContainersResolution {
  /** Resolver output, to be added to the zip. */
  outputPath: string;
  /** Module versions the resolver was built with (containers-resolver, syft, stereoscope). */
  versions: Record<string, string>;
  images: ResolvedImage[];
  /** Images that were found or given but could not be analysed, e.g. because they can't be pulled. */
  notAnalyzed: Omit<ResolvedImage, "packageCount">[];
}

export interface ContainersResolveOptions {
  /** Directory to resolve. It is only read. */
  sourceDir: string;
  /** Empty directory for the output files. */
  outDir: string;
  /** Images to analyse in addition to the ones in the files, as `cx --container-images`. */
  images: string[];
}

interface ImageLocation {
  Origin?: string;
  Path?: string;
}

/**
 * Runs the container resolution of `cx scan create` (containers-resolver, at
 * the version a given ast-cli release uses), either natively or in Docker.
 * Checkmarx ships no standalone binary, so Docker mode builds the wrapper in
 * `containers-resolver/main.go` once inside the ast-cli module.
 */
export class ContainersResolver {
  constructor(
    private readonly config: ContainersResolverConfig,
    private readonly logger: Logger,
    private readonly cacheDir = join(homedir(), ".cache", "checkmarx-mcp", "containers-resolver"),
    private readonly wrapperDir = WRAPPER_DIR,
  ) {}

  /** True when CHECKMARX_CONTAINERS_RESOLVER is set, so local resolution is the default. */
  get enabled(): boolean {
    return this.config.mode !== undefined;
  }

  /** The configured mode, or `docker` when local resolution is asked for per call. */
  get mode(): "docker" | "native" {
    return this.config.mode ?? "docker";
  }

  async resolve(options: ContainersResolveOptions): Promise<ContainersResolution> {
    await mkdir(options.outDir, { recursive: true });
    const output =
      this.mode === "docker" ? await this.runDocker(options) : await this.runNative(options);

    let resolution: string;
    try {
      resolution = await readFile(join(options.outDir, RESOLUTION_FILE), "utf8");
    } catch {
      throw new ContainersResolverError(
        `Containers resolver finished without writing ${RESOLUTION_FILE}`,
        output,
      );
    }
    const found = await readFile(join(options.outDir, IMAGES_FILE), "utf8").catch(() => "");
    return {
      outputPath: join(options.outDir, RESOLUTION_FILE),
      ...summarize(resolution, found),
    };
  }

  private async runDocker(options: ContainersResolveOptions): Promise<string> {
    await this.checkDocker();
    const binDir = await this.install();
    const name = `checkmarx-mcp-containers-${randomUUID()}`;
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--platform",
      this.config.platform,
      "-v",
      `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
      "-v",
      `${options.sourceDir}:/src:ro`,
      "-v",
      `${binDir}:/opt/cxmcp:ro`,
      "-v",
      `${options.outDir}:/out`,
      GO_IMAGE,
      `/opt/cxmcp/${BINARY}`,
      ...resolverArgs("/src", "/out", options.images),
    ];

    this.logger.info(`Running containers resolver (ast-cli ${this.config.version}) in Docker`);
    const result = await runProcess("docker", args, {
      timeoutMs: this.config.timeoutMs,
      // Killing `docker run` does not stop the container.
      onTimeout: () => void runProcess("docker", ["rm", "-f", name]),
    });
    this.checkResult(result, "Containers resolver", this.config.timeoutMs);
    return result.output;
  }

  private async runNative(options: ContainersResolveOptions): Promise<string> {
    const binary = this.config.path as string;
    this.logger.info(`Running containers resolver from ${binary}`);
    const result = await runProcess(
      binary,
      resolverArgs(options.sourceDir, options.outDir, options.images),
      { cwd: options.outDir, timeoutMs: this.config.timeoutMs },
    );
    this.checkResult(result, "Containers resolver", this.config.timeoutMs);
    return result.output;
  }

  private async checkDocker(): Promise<void> {
    const docker = await runProcess("docker", ["info"], { timeoutMs: QUICK_COMMAND_TIMEOUT_MS });
    if (docker.error || docker.code !== 0) {
      throw new ContainersResolverError("Docker is not running. Start Docker Desktop.");
    }
  }

  private checkResult(result: ProcessResult, what: string, timeoutMs: number): void {
    if (result.error) {
      throw new ContainersResolverError(`Could not start ${what}: ${result.error.message}`);
    }
    if (result.timedOut) {
      throw new ContainersResolverError(`${what} timed out after ${timeoutMs} ms`, result.output);
    }
    if (result.code !== 0) {
      const meaning = EXIT_CODES[result.code ?? -1] ?? "unknown error";
      throw new ContainersResolverError(
        `${what} failed with exit code ${result.code} (${meaning})`,
        result.output,
      );
    }
  }

  /**
   * Builds the wrapper once to `<cacheDir>/<version>/<platform>/` inside the
   * ast-cli module at tag `version`, so that its go.mod and go.sum select the
   * same resolver, syft and stereoscope versions as that `cx` release.
   */
  private async install(): Promise<string> {
    const { version, platform } = this.config;
    const versionDir = join(this.cacheDir, version);
    const dir = join(versionDir, platform.replace(/[^A-Za-z0-9._-]+/g, "-"));
    if (await isInstalled(dir)) return dir;

    await mkdir(versionDir, { recursive: true });
    const staging = await mkdtemp(join(versionDir, ".build-"));
    try {
      const name = `checkmarx-mcp-containers-build-${randomUUID()}`;
      const script = [
        `git clone --quiet --depth 1 --branch "$AST_CLI_TAG" ${AST_CLI_REPO} /tmp/ast-cli`,
        `mkdir -p /tmp/ast-cli/${WRAPPER_PACKAGE}`,
        `cp /wrapper/main.go /tmp/ast-cli/${WRAPPER_PACKAGE}/`,
        "cd /tmp/ast-cli",
        `CGO_ENABLED=0 GOFLAGS=-mod=mod go build -trimpath -o /out/${BINARY} ${WRAPPER_PACKAGE}`,
      ].join(" && ");
      this.logger.info(
        `Building containers resolver for ast-cli ${version} (${platform}). This runs once.`,
      );
      const result = await runProcess(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          name,
          "--platform",
          platform,
          "-e",
          `AST_CLI_TAG=${version}`,
          "-v",
          `${this.wrapperDir}:/wrapper:ro`,
          "-v",
          `${staging}:/out`,
          GO_IMAGE,
          "sh",
          "-ec",
          script,
        ],
        {
          timeoutMs: BUILD_TIMEOUT_MS,
          onTimeout: () => void runProcess("docker", ["rm", "-f", name]),
        },
      );
      this.checkResult(result, "Building the containers resolver", BUILD_TIMEOUT_MS);
      if (!(await isInstalled(staging))) {
        throw new ContainersResolverError(
          `Building the containers resolver wrote no ${BINARY} binary`,
          result.output,
        );
      }
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      // Another server process may have built the same version meanwhile.
      if (await isInstalled(dir)) return dir;
      throw error;
    }
    return dir;
  }
}

function resolverArgs(scanPath: string, outputPath: string, images: string[]): string[] {
  return [
    "-scan-path",
    scanPath,
    "-output-path",
    outputPath,
    ...(images.length ? ["-images", images.join(",")] : []),
  ];
}

async function isInstalled(dir: string): Promise<boolean> {
  try {
    await access(join(dir, BINARY));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists the analysed images from `containers-resolution.json` and the images
 * from `images.json` that are missing in it: the resolver logs an image it
 * can't analyse and leaves it out.
 */
function summarize(resolution: string, found: string): Omit<ContainersResolution, "outputPath"> {
  const resolved =
    parseJson<
      Array<{
        ContainerImage?: { ImageId?: string; ImageLocations?: ImageLocation[] | null };
        ContainerPackages?: unknown[] | null;
      }>
    >(resolution);
  // `null` is an empty list; undefined means the file is not JSON.
  if (resolved !== null && !Array.isArray(resolved)) {
    throw new ContainersResolverError(`${RESOLUTION_FILE} is not a JSON array`);
  }
  const info = parseJson<{
    modules?: Record<string, string>;
    images?: Array<{ Name?: string; ImageLocations?: ImageLocation[] | null }> | null;
  }>(found);

  const images = (resolved ?? []).map((entry) => ({
    name: entry.ContainerImage?.ImageId ?? "unknown",
    ...locations(entry.ContainerImage?.ImageLocations),
    packageCount: entry.ContainerPackages?.length ?? 0,
  }));
  const analyzed = new Set(images.map((image) => image.name));
  const notAnalyzed = (info?.images ?? [])
    .filter((image) => image.Name && !analyzed.has(image.Name))
    .map((image) => ({ name: image.Name as string, ...locations(image.ImageLocations) }));
  return { versions: info?.modules ?? {}, images, notAnalyzed };
}

function locations(list: ImageLocation[] | null | undefined): {
  origins: string[];
  paths: string[];
} {
  const origins = new Set<string>();
  const paths = new Set<string>();
  for (const location of list ?? []) {
    if (location.Origin) origins.add(location.Origin);
    if (location.Path && location.Path !== "NONE") paths.add(location.Path);
  }
  return { origins: [...origins], paths: [...paths] };
}

function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw.replace(/^﻿/, "")) as T;
  } catch {
    return undefined;
  }
}
