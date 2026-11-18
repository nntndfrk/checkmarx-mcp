import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkoutGitRef, copyExtraPaths } from "../../src/utils/git-source.js";
import { createRepo, git } from "../helpers/git-repo.js";

let repo: string;
let work: string;

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

beforeAll(async () => {
  repo = await createRepo();
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "git-source-work-"));
  return () => rm(work, { recursive: true, force: true });
});

describe("checkoutGitRef", () => {
  it("checks out the tracked files of the scanned folder at the ref", async () => {
    const statusBefore = git(repo, "status", "--porcelain");

    const checkout = await checkoutGitRef(
      join(repo, "app"),
      "HEAD",
      join(work, "checkout"),
      join(work, "index"),
    );

    expect(checkout.commit).toBe(git(repo, "rev-parse", "HEAD"));
    expect(checkout.dir).toBe(join(work, "checkout", "app"));
    // No untracked, ignored or uncommitted content; export-ignore files are kept.
    expect(await listFiles(checkout.dir)).toEqual([
      "export-ignored.ts",
      "src/added.ts",
      "src/main.ts",
    ]);
    expect(await readFile(join(checkout.dir, "src/main.ts"), "utf8")).toBe("export const v = 2;\n");
    // The repository's index and working tree are unchanged.
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
  });

  it("checks out an older tag", async () => {
    const checkout = await checkoutGitRef(repo, "v1", join(work, "checkout"), join(work, "index"));

    expect(checkout.commit).toBe(git(repo, "rev-parse", "v1^{commit}"));
    expect(await listFiles(join(checkout.dir, "app"))).toEqual([
      "export-ignored.ts",
      "src/main.ts",
    ]);
  });

  it("rejects unknown refs and option-like refs", async () => {
    await expect(
      checkoutGitRef(repo, "no-such-branch", join(work, "c"), join(work, "i")),
    ).rejects.toThrow('gitRef "no-such-branch" is not a commit');
    await expect(
      checkoutGitRef(repo, "--output=/tmp/x", join(work, "c"), join(work, "i")),
    ).rejects.toThrow("Invalid gitRef");
  });

  it("fails outside a git repository", async () => {
    await expect(checkoutGitRef(work, "HEAD", join(work, "c"), join(work, "i"))).rejects.toThrow(
      "is not in a git repository",
    );
  });

  it("fails when the folder does not exist at the ref", async () => {
    await expect(
      checkoutGitRef(join(repo, "app", "dist"), "HEAD", join(work, "c"), join(work, "i")),
    ).rejects.toThrow("does not exist in HEAD");
  });
});

describe("copyExtraPaths", () => {
  it("copies files and folders to the same place", async () => {
    await copyExtraPaths(join(repo, "app"), ["dist", "debug.log"], work);

    expect(await listFiles(work)).toEqual(["debug.log", "dist/bundle.js"]);
  });

  it("rejects paths outside the directory and missing paths", async () => {
    await expect(copyExtraPaths(join(repo, "app"), ["../root.ts"], work)).rejects.toThrow(
      "is not inside",
    );
    await expect(copyExtraPaths(join(repo, "app"), ["."], work)).rejects.toThrow("is not inside");
    await expect(copyExtraPaths(join(repo, "app"), ["missing"], work)).rejects.toThrow(
      "does not exist",
    );
  });
});
