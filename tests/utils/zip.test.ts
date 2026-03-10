import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipDirectory } from "../../src/utils/zip.js";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "zip-test-"));
  await writeFile(join(testDir, "file1.ts"), "const x = 1;");
  await writeFile(join(testDir, "file2.ts"), "const y = 2;");
  await mkdir(join(testDir, "src"));
  await writeFile(join(testDir, "src", "index.ts"), "export {};");
  await mkdir(join(testDir, "node_modules"));
  await writeFile(join(testDir, "node_modules", "dep.js"), "module.exports = {};");
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
