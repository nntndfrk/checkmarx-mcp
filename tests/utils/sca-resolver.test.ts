import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScaResolverConfig } from "../../src/config.js";
import { Logger } from "../../src/logger.js";

interface FakeRun {
  /** Lines written to stdout. */
  output?: string[];
  code?: number;
  /** Never exits on its own; only a kill ends it. */
  hang?: boolean;
  /** Runs before the process exits, e.g. to write the resolver output. */
  effect?: (args: string[]) => Promise<void>;
  error?: NodeJS.ErrnoException;
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

const spawnCalls: SpawnCall[] = [];
let fakeRun: (command: string, args: string[]) => FakeRun = () => ({});

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, args, options });
    const run = fakeRun(command, args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        setImmediate(() => child.emit("close", null));
        return true;
      },
    });
    setImmediate(async () => {
      if (run.error) {
        child.emit("error", run.error);
        return;
      }
      await run.effect?.(args);
      for (const line of run.output ?? []) child.stdout.write(`${line}\n`);
      if (!run.hang) setImmediate(() => child.emit("close", run.code ?? 0));
    });
    return child;
  },
}));

const { ScaResolver, splitArgs } = await import("../../src/utils/sca-resolver.js");

const RESOLVER_OUTPUT = JSON.stringify({
  DependencyResolutionResults: [
    {
      PackageManagerFile: "package.json",
      Dependencies: [
        { Id: { Name: "highcharts", Version: "11.4.8" } },
        { Id: { Name: "rxjs", Version: "7.8.2" } },
      ],
    },
    {
      PackageManagerFile: "scripts/package.json",
      Dependencies: [{ Id: { Name: "rxjs", Version: "7.8.2" } }],
    },
  ],
});
const ARCHIVE = Buffer.from("fake-tarball");
const ARCHIVE_SHA256 = "746e8948ec0a7b6e150cc34446bad2bd0d0e2e3f0bd8f03f0edef7467a38e3b6";

let root: string;
let cacheDir: string;
let sourceDir: string;
let outDir: string;
let fetchCalls: string[];

function config(overrides: Partial<ScaResolverConfig> = {}): ScaResolverConfig {
  return {
    mode: "docker",
    version: "2.12.23",
    image: "node:24.16.0-bookworm",
    platform: "linux/amd64",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function resolver(cfg: ScaResolverConfig = config()) {
  return new ScaResolver(cfg, new Logger("error"), cacheDir);
}

function resolveOptions(params: string[] = []) {
  return { sourceDir, outDir, projectName: "my-app", params };
}

/** Value after a flag in an argument list, e.g. the mount after the n-th `-v`. */
function mounts(args: string[]): string[] {
  return args.flatMap((arg, i) => (arg === "-v" ? [args[i + 1] ?? ""] : []));
}

/** Writes the resolver output into the folder mounted at /out. */
async function writeOutput(args: string[]): Promise<void> {
  const out = mounts(args).find((m) => m.endsWith(":/out"));
  await writeFile(join(out?.replace(/:\/out$/, "") ?? "", "sca.json"), RESOLVER_OUTPUT);
}

/** Default fakes: Docker is up, tar extracts the resolver, the resolver succeeds. */
function dockerWorks(run: Partial<FakeRun> = {}) {
  fakeRun = (command, args) => {
    if (command === "docker" && args[0] === "info") return {};
    if (command === "docker" && args[0] === "rm") return {};
    if (command === "tar") {
      return {
        effect: async () => {
          const dir = args[args.indexOf("-C") + 1] ?? "";
          await writeFile(join(dir, "ScaResolver"), "binary");
          await writeFile(join(dir, "Configuration.yml"), "config");
        },
      };
    }
    return { effect: writeOutput, ...run };
  };
}

function mockDownload(checksum: string | undefined = ARCHIVE_SHA256) {
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    if (String(url).endsWith(".sha256sum")) {
      return checksum === undefined
        ? new Response("Not found", { status: 404 })
        : new Response(`${checksum}\n`, { status: 200 });
    }
    return new Response(ARCHIVE, { status: 200 });
  }) as typeof fetch;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sca-resolver-test-"));
  cacheDir = join(root, "cache");
  sourceDir = join(root, "src");
  outDir = join(root, "out");
  await mkdir(sourceDir);
  spawnCalls.length = 0;
  fetchCalls = [];
  mockDownload();
  dockerWorks();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("splitArgs", () => {
  it("splits the CI parameters like cx", () => {
    expect(
      splitArgs(
        "--extract-archives zip,ear,war --extract-depth 1 --ignore-dev-dependencies --maven-parameters='-Dscope=runtime'",
      ),
    ).toEqual([
      "--extract-archives",
      "zip,ear,war",
      "--extract-depth",
      "1",
      "--ignore-dev-dependencies",
      "--maven-parameters=-Dscope=runtime",
    ]);
  });

  it("keeps = values as one argument", () => {
    expect(splitArgs("--ignore-dev-dependencies=true --ignore-test-dependencies=true")).toEqual([
      "--ignore-dev-dependencies=true",
      "--ignore-test-dependencies=true",
    ]);
  });

  it("groups quoted text and removes the quotes", () => {
    expect(splitArgs(`-e "**/test fixtures/**"  --x 'a "b" c'`)).toEqual([
      "-e",
      "**/test fixtures/**",
      "--x",
      'a "b" c',
    ]);
  });

  it("returns no arguments for an empty or blank string", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs(" \t\n ")).toEqual([]);
  });
});

describe("ScaResolver (docker)", () => {
  it("is disabled without a mode", () => {
    expect(resolver(config({ mode: undefined })).enabled).toBe(false);
    expect(resolver().enabled).toBe(true);
  });

  it("downloads, verifies and runs the linux64 build without a shell", async () => {
    const result = await resolver().resolve(resolveOptions(["--ignore-dev-dependencies"]));

    expect(fetchCalls).toEqual([
      "https://sca-downloads.s3.amazonaws.com/cli/2.12.23/ScaResolver-linux64.tar.gz",
      "https://sca-downloads.s3.amazonaws.com/cli/2.12.23/ScaResolver-linux64.tar.gz.sha256sum",
    ]);
    const resolverDir = join(cacheDir, "2.12.23");
    expect(existsSync(join(resolverDir, "ScaResolver"))).toBe(true);
    expect(existsSync(join(resolverDir, "logs"))).toBe(true);

    const run = spawnCalls.find((c) => c.command === "docker" && c.args[0] === "run");
    expect(run?.options.shell).toBeUndefined();
    const args = run?.args ?? [];
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(args[args.indexOf("--platform") + 1]).toBe("linux/amd64");
    expect(mounts(args)).toEqual([
      `${sourceDir}:/src`,
      `${resolverDir}:/opt/sca:ro`,
      `${join(outDir, "logs")}:/opt/sca/logs`,
      `${outDir}:/out`,
    ]);
    expect(args.slice(args.indexOf("-w"))).toEqual([
      "-w",
      "/out",
      "node:24.16.0-bookworm",
      "/opt/sca/ScaResolver",
      "offline",
      "-s",
      "/src",
      "-n",
      "my-app",
      "-r",
      "/out/sca.json",
      "--ignore-dev-dependencies",
    ]);

    expect(result).toEqual({
      outputPath: join(outDir, "sca.json"),
      version: "2.12.23",
      packageCount: 2,
    });
  });

  it("reuses an installed resolver", async () => {
    await resolver().resolve(resolveOptions());
    fetchCalls = [];

    await resolver().resolve(resolveOptions());

    expect(fetchCalls).toEqual([]);
    expect(spawnCalls.filter((c) => c.command === "tar")).toHaveLength(1);
  });

  it("uses CHECKMARX_SCA_RESOLVER_SHA256 over the published checksum", async () => {
    await expect(
      resolver(config({ sha256: "a".repeat(64) })).resolve(resolveOptions()),
    ).rejects.toThrow("SHA-256 mismatch");
    expect(fetchCalls.some((u) => u.endsWith(".sha256sum"))).toBe(false);
  });

  it("fails on a checksum mismatch and installs nothing", async () => {
    mockDownload("b".repeat(64));

    await expect(resolver().resolve(resolveOptions())).rejects.toThrow(
      `expected ${"b".repeat(64)}, got ${ARCHIVE_SHA256}`,
    );
    expect(existsSync(join(cacheDir, "2.12.23"))).toBe(false);
    expect(spawnCalls.some((c) => c.args[0] === "run")).toBe(false);
  });

  it("installs without verification when no checksum is published", async () => {
    mockDownload(undefined);

    await expect(resolver().resolve(resolveOptions())).resolves.toMatchObject({
      packageCount: 2,
    });
  });

  it("asks to start Docker when docker info fails", async () => {
    fakeRun = () => ({ code: 1, output: ["Cannot connect to the Docker daemon"] });

    await expect(resolver().resolve(resolveOptions())).rejects.toThrow(
      "Docker is not running. Start Docker Desktop.",
    );
    expect(fetchCalls).toEqual([]);
  });

  it("reports the exit code meaning and the last 50 output lines", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `log line ${i + 1}`);
    dockerWorks({ code: 9, output: lines, effect: async () => {} });

    const error = await resolver()
      .resolve(resolveOptions())
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("SCA Resolver failed with exit code 9 (package manager error)");
    expect(message).toContain("log line 11\n");
    expect(message).toContain("log line 60");
    expect(message).not.toContain("log line 10\n");
  });

  it("stops the container on timeout", async () => {
    dockerWorks({ hang: true, effect: async () => {} });

    await expect(resolver(config({ timeoutMs: 20 })).resolve(resolveOptions())).rejects.toThrow(
      "SCA Resolver timed out after 20 ms",
    );
    const run = spawnCalls.find((c) => c.args[0] === "run");
    const name = run?.args[run.args.indexOf("--name") + 1];
    expect(spawnCalls.some((c) => c.args[0] === "rm" && c.args.includes(name ?? ""))).toBe(true);
  });

  it("fails when the resolver writes no output", async () => {
    dockerWorks({ effect: async () => {}, output: ["done"] });

    await expect(resolver().resolve(resolveOptions())).rejects.toThrow(
      "SCA Resolver finished without writing sca.json",
    );
  });
});

describe("ScaResolver (native)", () => {
  it("runs the binary with host paths in the output folder", async () => {
    fakeRun = (_command, args) =>
      args[0] === "--version"
        ? { output: ["CxSCA Resolver 2.16.2"] }
        : {
            effect: async () => writeFile(join(outDir, "sca.json"), RESOLVER_OUTPUT),
          };

    const result = await resolver(config({ mode: "native", path: "/opt/sca/ScaResolver" })).resolve(
      resolveOptions(["--ignore-dev-dependencies=true"]),
    );

    expect(spawnCalls.map((c) => c.command)).toEqual([
      "/opt/sca/ScaResolver",
      "/opt/sca/ScaResolver",
    ]);
    const run = spawnCalls[1];
    expect(run?.args).toEqual([
      "offline",
      "-s",
      sourceDir,
      "-n",
      "my-app",
      "-r",
      join(outDir, "sca.json"),
      "--ignore-dev-dependencies=true",
    ]);
    expect(run?.options.cwd).toBe(outDir);
    expect(run?.options.shell).toBeUndefined();
    expect(result.version).toBe("2.16.2");
    expect(fetchCalls).toEqual([]);
  });

  it("reports a binary that cannot start", async () => {
    const error = Object.assign(new Error("spawn /missing ENOENT"), { code: "ENOENT" });
    fakeRun = () => ({ error });

    await expect(
      resolver(config({ mode: "native", path: "/missing" })).resolve(resolveOptions()),
    ).rejects.toThrow("Could not start SCA Resolver: spawn /missing ENOENT");
  });
});
