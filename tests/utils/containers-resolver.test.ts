import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainersResolverConfig } from "../../src/config.js";
import { Logger } from "../../src/logger.js";

interface FakeRun {
  output?: string[];
  code?: number;
  hang?: boolean;
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

const { ContainersResolver, CONTAINER_IMAGE_REGEX } = await import(
  "../../src/utils/containers-resolver.js"
);

const RESOLUTION = JSON.stringify([
  {
    ContainerImage: {
      ImageName: "nginx",
      ImageTag: "1.27",
      ImageId: "nginx:1.27",
      ImageLocations: [
        { Origin: "Dockerfile", Path: "Dockerfile", FinalStage: true },
        { Origin: "DockerCompose", Path: "compose.yaml", FinalStage: false },
      ],
    },
    ContainerPackages: [{ Name: "openssl" }, { Name: "zlib" }],
  },
  {
    ContainerImage: {
      ImageName: "app",
      ImageTag: "1.0",
      ImageId: "app:1.0",
      ImageLocations: [{ Origin: "UserInput", Path: "NONE", FinalStage: false }],
    },
    ContainerPackages: [{ Name: "musl" }],
  },
]);
const IMAGES = JSON.stringify({
  modules: { "containers-resolver": "v1.0.11", syft: "v1.21.0" },
  images: [
    { Name: "app:1.0", ImageLocations: [{ Origin: "UserInput", Path: "NONE" }] },
    { Name: "nginx:1.27", ImageLocations: [{ Origin: "Dockerfile", Path: "Dockerfile" }] },
    { Name: "private.example.com/api:2.0", ImageLocations: [{ Origin: "Helm", Path: "chart" }] },
  ],
});

let root: string;
let cacheDir: string;
let wrapperDir: string;
let sourceDir: string;
let outDir: string;

function config(overrides: Partial<ContainersResolverConfig> = {}): ContainersResolverConfig {
  return {
    mode: "docker",
    version: "2.3.27",
    platform: "linux/amd64",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function resolver(cfg: ContainersResolverConfig = config()) {
  return new ContainersResolver(cfg, new Logger("error"), cacheDir, wrapperDir);
}

function resolveOptions(images: string[] = []) {
  return { sourceDir, outDir, images };
}

function mounts(args: string[]): string[] {
  return args.flatMap((arg, i) => (arg === "-v" ? [args[i + 1] ?? ""] : []));
}

function hostDir(args: string[], target: string): string {
  return (mounts(args).find((m) => m.endsWith(`:${target}`)) ?? "").slice(0, -target.length - 1);
}

/** Writes the resolver output into the folder mounted at /out. */
async function writeOutput(args: string[]): Promise<void> {
  const out = hostDir(args, "/out");
  await writeFile(join(out, "containers-resolution.json"), RESOLUTION);
  await writeFile(join(out, "images.json"), IMAGES);
}

/** Default fakes: Docker is up, the build writes the binary, the resolver succeeds. */
function dockerWorks(run: Partial<FakeRun> = {}) {
  fakeRun = (command, args) => {
    if (command === "docker" && (args[0] === "info" || args[0] === "rm")) return {};
    if (command === "docker" && args.includes("sh")) {
      return {
        effect: async () => writeFile(join(hostDir(args, "/out"), "containers-resolver"), "bin"),
      };
    }
    return { effect: writeOutput, ...run };
  };
}

function dockerRuns(): SpawnCall[] {
  return spawnCalls.filter((c) => c.command === "docker" && c.args[0] === "run");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "containers-resolver-test-"));
  cacheDir = join(root, "cache");
  wrapperDir = join(root, "wrapper");
  sourceDir = join(root, "src");
  outDir = join(root, "out");
  await mkdir(sourceDir);
  spawnCalls.length = 0;
  dockerWorks();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CONTAINER_IMAGE_REGEX", () => {
  it("accepts what cx --container-images accepts", () => {
    for (const image of [
      "nginx:1.27",
      "manuelbcd/vulnapp:latest",
      "debian:10",
      "registry.example.com:5000/team/app:1.2.3",
      "ghcr.io/org/app:v1_rc.2",
    ]) {
      expect(CONTAINER_IMAGE_REGEX.test(image), image).toBe(true);
    }
  });

  it("rejects images without a tag, digests and upper-case names", () => {
    for (const image of ["nginx", "nginx@sha256:abc", "Nginx:1", " debian:10", "app:-x"]) {
      expect(CONTAINER_IMAGE_REGEX.test(image), image).toBe(false);
    }
  });
});

describe("ContainersResolver (docker)", () => {
  it("is enabled only with CHECKMARX_CONTAINERS_RESOLVER and runs Docker by default", () => {
    const unset = resolver(config({ mode: undefined }));
    expect(unset.enabled).toBe(false);
    expect(unset.mode).toBe("docker");
    expect(resolver().enabled).toBe(true);
  });

  it("builds the wrapper once in the ast-cli module at the configured tag", async () => {
    await resolver().resolve(resolveOptions());
    await resolver().resolve(resolveOptions());

    const builds = dockerRuns().filter((c) => c.args.includes("sh"));
    expect(builds).toHaveLength(1);
    const args = builds[0]?.args ?? [];
    expect(args[args.indexOf("--platform") + 1]).toBe("linux/amd64");
    expect(args).toContain("AST_CLI_TAG=2.3.27");
    expect(mounts(args)[0]).toBe(`${wrapperDir}:/wrapper:ro`);
    const script = args.at(-1) ?? "";
    expect(script).toContain('--branch "$AST_CLI_TAG" https://github.com/Checkmarx/ast-cli');
    expect(script).toContain("CGO_ENABLED=0 GOFLAGS=-mod=mod go build -trimpath");
    expect(existsSync(join(cacheDir, "2.3.27", "linux-amd64", "containers-resolver"))).toBe(true);
  });

  it("mounts the source read-only and the Docker socket, and passes the images", async () => {
    const result = await resolver().resolve(resolveOptions(["app:1.0", "nginx:1.27"]));

    const run = dockerRuns().find((c) => !c.args.includes("sh"));
    expect(run?.options.shell).toBeUndefined();
    const args = run?.args ?? [];
    expect(mounts(args)).toEqual([
      "/var/run/docker.sock:/var/run/docker.sock",
      `${sourceDir}:/src:ro`,
      `${join(cacheDir, "2.3.27", "linux-amd64")}:/opt/cxmcp:ro`,
      `${outDir}:/out`,
    ]);
    expect(args.slice(args.indexOf("/opt/cxmcp/containers-resolver"))).toEqual([
      "/opt/cxmcp/containers-resolver",
      "-scan-path",
      "/src",
      "-output-path",
      "/out",
      "-images",
      "app:1.0,nginx:1.27",
    ]);

    expect(result.outputPath).toBe(join(outDir, "containers-resolution.json"));
    expect(await readFile(result.outputPath, "utf8")).toBe(RESOLUTION);
    expect(result.versions).toEqual({ "containers-resolver": "v1.0.11", syft: "v1.21.0" });
    expect(result.images).toEqual([
      {
        name: "nginx:1.27",
        origins: ["Dockerfile", "DockerCompose"],
        paths: ["Dockerfile", "compose.yaml"],
        packageCount: 2,
      },
      { name: "app:1.0", origins: ["UserInput"], paths: [], packageCount: 1 },
    ]);
    expect(result.notAnalyzed).toEqual([
      { name: "private.example.com/api:2.0", origins: ["Helm"], paths: ["chart"] },
    ]);
  });

  it("omits -images when none are given", async () => {
    await resolver().resolve(resolveOptions());

    const run = dockerRuns().find((c) => !c.args.includes("sh"));
    expect(run?.args).not.toContain("-images");
  });

  it("reports a failed build and caches nothing", async () => {
    fakeRun = (command, args) =>
      command === "docker" && args.includes("sh")
        ? { code: 1, output: ["fatal: Remote branch 9.9.9 not found"] }
        : {};

    await expect(resolver(config({ version: "9.9.9" })).resolve(resolveOptions())).rejects.toThrow(
      /Building the containers resolver failed with exit code 1[\s\S]*Remote branch 9.9.9/,
    );
    expect(existsSync(join(cacheDir, "9.9.9", "linux-amd64"))).toBe(false);
  });

  it("asks to start Docker when docker info fails", async () => {
    fakeRun = () => ({ code: 1 });

    await expect(resolver().resolve(resolveOptions())).rejects.toThrow(
      "Docker is not running. Start Docker Desktop.",
    );
  });

  it("stops the container on timeout", async () => {
    dockerWorks({ hang: true, effect: async () => {} });

    await expect(resolver(config({ timeoutMs: 20 })).resolve(resolveOptions())).rejects.toThrow(
      "Containers resolver timed out after 20 ms",
    );
    const run = dockerRuns().find((c) => !c.args.includes("sh"));
    const name = run?.args[run.args.indexOf("--name") + 1];
    expect(spawnCalls.some((c) => c.args[0] === "rm" && c.args.includes(name ?? ""))).toBe(true);
  });

  it("fails when the resolver writes no resolution", async () => {
    dockerWorks({ effect: async () => {}, output: ["done"] });

    await expect(resolver().resolve(resolveOptions())).rejects.toThrow(
      "Containers resolver finished without writing containers-resolution.json",
    );
  });
});

describe("ContainersResolver (native)", () => {
  it("runs the binary with host paths and builds nothing", async () => {
    fakeRun = () => ({
      effect: async () => {
        await writeFile(join(outDir, "containers-resolution.json"), "null");
      },
    });

    const result = await resolver(config({ mode: "native", path: "/opt/cxresolve" })).resolve(
      resolveOptions(["app:1.0"]),
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toBe("/opt/cxresolve");
    expect(spawnCalls[0]?.args).toEqual([
      "-scan-path",
      sourceDir,
      "-output-path",
      outDir,
      "-images",
      "app:1.0",
    ]);
    expect(spawnCalls[0]?.options.cwd).toBe(outDir);
    expect(result).toMatchObject({ versions: {}, images: [], notAnalyzed: [] });
  });

  it("reports a binary that cannot start", async () => {
    const error = Object.assign(new Error("spawn /missing ENOENT"), { code: "ENOENT" });
    fakeRun = () => ({ error });

    await expect(
      resolver(config({ mode: "native", path: "/missing" })).resolve(resolveOptions()),
    ).rejects.toThrow("Could not start Containers resolver: spawn /missing ENOENT");
  });
});
