import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageDirectory, synthesizeDockerfileZip, zipDirectory } from "../../src/utils/zip.js";
import { zipEntries } from "../helpers/zip-entries.js";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "zip-test-"));
  await writeFile(join(testDir, "file1.ts"), "const x = 1;");
  await writeFile(join(testDir, "file2.ts"), "const y = 2;");
  await mkdir(join(testDir, "src"));
  await writeFile(join(testDir, "src", "index.ts"), "export {};");
  await mkdir(join(testDir, "node_modules"));
  await writeFile(join(testDir, "node_modules", "dep.js"), "module.exports = {};");
  await writeFile(join(testDir, "esm-helper.mjs"), "export {};");
  await writeFile(join(testDir, "styles.scss"), "a {}");
  await writeFile(join(testDir, "Dockerfile"), "FROM node:22");
  await writeFile(join(testDir, "yarn.lock"), "");
  await mkdir(join(testDir, "iac"));
  await writeFile(join(testDir, "iac", "main.tf"), "");
  await mkdir(join(testDir, "dist"));
  await writeFile(join(testDir, "dist", "bundle.js"), "");
  await mkdir(join(testDir, ".vscode"));
  await writeFile(join(testDir, ".vscode", "settings.json"), "{}");
  await mkdir(join(testDir, ".git"));
  await writeFile(join(testDir, ".git", "config"), "");
  await writeFile(join(testDir, "README.md"), "# app");
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("zipDirectory", () => {
  it("produces a valid zip buffer", async () => {
    const buffer = await zipDirectory(testDir);

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer[0]).toBe(0x50); // PK zip magic bytes
    expect(buffer[1]).toBe(0x4b);
  });

  it("excludes node_modules by default", async () => {
    const buffer = await zipDirectory(testDir);
    const content = buffer.toString("binary");

    expect(content).toContain("file1.ts");
    expect(content).toContain("src/index.ts");
    expect(content).not.toContain("dep.js");
  });

  it("applies additional exclude patterns", async () => {
    const buffer = await zipDirectory(testDir, ["src/*"]);
    const content = buffer.toString("binary");

    expect(content).toContain("file1.ts");
    expect(content).not.toContain("index.ts");
  });

  it("uses the cx include list and folder excludes by default", async () => {
    const entries = zipEntries(await zipDirectory(testDir));

    expect(entries).toEqual([
      "Dockerfile",
      "dist/bundle.js",
      "file1.ts",
      "file2.ts",
      "iac/main.tf",
      "src/index.ts",
      "yarn.lock",
    ]);
  });

  it("keeps all file types and skips build folders in 'all' mode", async () => {
    const entries = zipEntries(await zipDirectory(testDir, undefined, "all"));

    expect(entries).toContain("esm-helper.mjs");
    expect(entries).toContain("styles.scss");
    expect(entries).toContain("Dockerfile");
    expect(entries).not.toContain("iac/main.tf");
    expect(entries).not.toContain("dist/bundle.js");
    expect(entries).not.toContain(".git/config");
    expect(entries).not.toContain("node_modules/dep.js");
  });

  it("applies additional exclude patterns in cx mode", async () => {
    const entries = zipEntries(await zipDirectory(testDir, ["dist/**"], "cx"));

    expect(entries).not.toContain("dist/bundle.js");
    expect(entries).toContain("iac/main.tf");
  });

  it("adds extra entries at the zip root and keeps the manifests", async () => {
    const extra = join(testDir, "..", `${testDir.split("/").pop()}-sca.json`);
    await writeFile(extra, "{}");
    try {
      const entries = zipEntries(
        await zipDirectory(testDir, undefined, "cx", [
          { name: ".cxsca-results.json", path: extra },
        ]),
      );

      expect(entries).toContain(".cxsca-results.json");
      expect(entries).toContain("yarn.lock");
      expect(entries.filter((e) => e.endsWith(".cxsca-results.json"))).toEqual([
        ".cxsca-results.json",
      ]);
    } finally {
      await rm(extra);
    }
  });

  it("replaces a file of the same name with the extra entry", async () => {
    await writeFile(join(testDir, ".cxsca-results.json"), "stale");
    const extra = join(testDir, "..", `${testDir.split("/").pop()}-fresh.json`);
    await writeFile(extra, "fresh");
    try {
      const entries = zipEntries(
        await zipDirectory(testDir, undefined, "cx", [
          { name: ".cxsca-results.json", path: extra },
        ]),
      );
      expect(entries.filter((e) => e === ".cxsca-results.json")).toHaveLength(1);
    } finally {
      await rm(extra);
      await rm(join(testDir, ".cxsca-results.json"));
    }
  });

  it("throws on empty path", async () => {
    await expect(zipDirectory("")).rejects.toThrow("cannot be empty");
    await expect(zipDirectory("   ")).rejects.toThrow("cannot be empty");
  });

  it("throws on nonexistent directory", async () => {
    await expect(zipDirectory("/nonexistent/path/12345")).rejects.toThrow(
      "Directory not accessible",
    );
  });

  it("throws when path is a file", async () => {
    const filePath = join(testDir, "file1.ts");
    await expect(zipDirectory(filePath)).rejects.toThrow("not a directory");
  });

  it("resolves relative paths", async () => {
    const buffer = await zipDirectory(testDir);
    expect(buffer.length).toBeGreaterThan(0);
  });
});

describe("stageDirectory", () => {
  async function listFiles(dir: string, prefix = ""): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name), `${path}/`)));
      else files.push(path);
    }
    return files.sort();
  }

  async function stage(excludes?: string[], mode?: "cx" | "all"): Promise<string[]> {
    const dest = await mkdtemp(join(tmpdir(), "stage-test-"));
    try {
      await stageDirectory(testDir, join(dest, "src"), excludes, mode);
      return await listFiles(join(dest, "src"));
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  }

  it("copies every file type and skips the cx folder excludes", async () => {
    const files = await stage();

    expect(files).toEqual([
      "Dockerfile",
      "README.md",
      "dist/bundle.js",
      "esm-helper.mjs",
      "file1.ts",
      "file2.ts",
      "iac/main.tf",
      "src/index.ts",
      "styles.scss",
      "yarn.lock",
    ]);
  });

  it("honours excludePatterns", async () => {
    const files = await stage(["dist/**", "*.md"]);

    expect(files).not.toContain("dist/bundle.js");
    expect(files).not.toContain("README.md");
    expect(files).toContain("iac/main.tf");
  });

  it("uses the 'all' mode folder excludes", async () => {
    const files = await stage(undefined, "all");

    expect(files).not.toContain("dist/bundle.js");
    expect(files).not.toContain("iac/main.tf");
    expect(files).toContain("README.md");
  });

  it("copies file contents", async () => {
    const dest = await mkdtemp(join(tmpdir(), "stage-test-"));
    try {
      const copied = await stageDirectory(testDir, dest);
      expect(copied).toBe(10);
      expect(await readFile(join(dest, "Dockerfile"), "utf8")).toBe("FROM node:22");
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });
});

describe("synthesizeDockerfileZip", () => {
  it("produces a valid zip buffer with a Dockerfile entry", async () => {
    const buffer = await synthesizeDockerfileZip("nginx:1.27-alpine-slim");

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);

    const binary = buffer.toString("binary");
    expect(binary).toContain("Dockerfile");
    expect(binary).toContain("FROM nginx:1.27-alpine-slim\n");
  });

  it("supports digest-pinned image references", async () => {
    const image = `ghcr.io/org/app@sha256:${"a".repeat(64)}`;
    const buffer = await synthesizeDockerfileZip(image);
    expect(buffer.toString("binary")).toContain(`FROM ${image}\n`);
  });

  it("throws on empty image reference", async () => {
    await expect(synthesizeDockerfileZip("")).rejects.toThrow("cannot be empty");
    await expect(synthesizeDockerfileZip("   ")).rejects.toThrow("cannot be empty");
  });

  it("trims whitespace around the image reference", async () => {
    const buffer = await synthesizeDockerfileZip("  nginx:latest  ");
    expect(buffer.toString("binary")).toContain("FROM nginx:latest\n");
  });
});
