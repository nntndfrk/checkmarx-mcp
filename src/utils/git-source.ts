import { cp, mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { lastLines, runProcess } from "./process.js";

const GIT_TIMEOUT_MS = 600_000;
const LOG_TAIL_LINES = 20;

export interface GitCheckout {
  /** The folder in the checkout that corresponds to the scanned directory. */
  dir: string;
  /** Full commit SHA the ref resolved to. */
  commit: string;
}

/**
 * Checks out `ref` of the repository that contains `directory` into
 * `destDir`, as a CI checkout of that commit sees it: tracked files only, with
 * `.gitattributes` filters and line endings applied, and no `.git`, ignored or
 * untracked files. `git archive` is not used because it drops `export-ignore`
 * files and expands `export-subst`.
 *
 * A temporary index (`indexFile`) is used, so the repository's index, working
 * tree and refs are not changed. Submodules are not checked out.
 */
export async function checkoutGitRef(
  directory: string,
  ref: string,
  destDir: string,
  indexFile: string,
): Promise<GitCheckout> {
  if (!ref.trim() || ref.startsWith("-")) {
    throw new Error(`Invalid gitRef: ${JSON.stringify(ref)}`);
  }
  const cwd = resolve(directory);
  const top = await git(["rev-parse", "--show-toplevel"], cwd, `${cwd} is not in a git repository`);
  const prefix = await git(["rev-parse", "--show-prefix"], cwd);
  const commit = await git(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    cwd,
    `gitRef ${JSON.stringify(ref)} is not a commit in ${top}`,
  );

  await mkdir(destDir, { recursive: true });
  const env = { GIT_INDEX_FILE: indexFile };
  await git(["read-tree", commit], top, undefined, env);
  await git(["--work-tree", destDir, "checkout-index", "--all", "--force"], top, undefined, env);

  const dir = resolve(destDir, prefix);
  if (!(await isDirectory(dir))) {
    throw new Error(`${prefix || "."} does not exist in ${ref} (${commit.slice(0, 12)})`);
  }
  return { dir, commit };
}

/**
 * Copies files or folders from `directory` (paths relative to it) to the same
 * place in `destDir`, replacing what is there. Used to add CI build output,
 * such as `dist/` or generated IaC files, to a git checkout.
 */
export async function copyExtraPaths(
  directory: string,
  paths: string[],
  destDir: string,
): Promise<void> {
  const root = resolve(directory);
  for (const path of paths) {
    const source = resolve(root, path);
    const rel = relative(root, source);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`extraPaths entry ${JSON.stringify(path)} is not inside ${root}`);
    }
    try {
      await stat(source);
    } catch {
      throw new Error(`extraPaths entry ${JSON.stringify(path)} does not exist in ${root}`);
    }
    await cp(source, join(destDir, rel), { recursive: true, force: true });
  }
}

async function git(
  args: string[],
  cwd: string,
  failure?: string,
  env?: Record<string, string>,
): Promise<string> {
  const result = await runProcess("git", args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS });
  if (result.error) {
    throw new Error(`Could not run git: ${result.error.message}`);
  }
  if (result.timedOut || result.code !== 0) {
    const tail = lastLines(result.output, LOG_TAIL_LINES);
    throw new Error(`${failure ?? `git ${args.join(" ")} failed`}${tail ? `\n${tail}` : ""}`);
  }
  // stdout and stderr are merged; the value is the last line.
  return result.output.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
