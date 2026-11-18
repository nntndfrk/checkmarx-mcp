import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

/**
 * A repository with an `app/` folder, committed twice (tag `v1`, then HEAD),
 * plus an ignored file, an untracked file and an uncommitted change.
 */
export async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "git-source-test-"));
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  };
  git(repo, "init", "--quiet");
  await write(".gitignore", "dist/\n*.log\n");
  await write(".gitattributes", "app/export-ignored.ts export-ignore\n");
  await write("app/src/main.ts", "export const v = 1;\n");
  await write("app/export-ignored.ts", "export const kept = true;\n");
  await write("root.ts", "export const root = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "v1");
  git(repo, "tag", "v1");
  await write("app/src/main.ts", "export const v = 2;\n");
  await write("app/src/added.ts", "export const added = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "v2");
  await write("app/src/main.ts", "export const v = 3; // uncommitted\n");
  await write("app/untracked.ts", "export const untracked = 1;\n");
  await write("app/dist/bundle.js", "console.log('built');\n");
  await write("app/debug.log", "log\n");
  return repo;
}
