import { constants, access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import archiver from "archiver";

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.angular/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/vendor/**",
  "**/iac/**",
  "**/.idea/**",
  "**/.vscode/**",
  "**/*.zip",
];

export async function zipDirectory(
  dirPath: string,
  additionalExcludes?: string[],
): Promise<Buffer> {
  if (!dirPath || dirPath.trim() === "") {
    throw new Error("Directory path cannot be empty");
  }

  const absolutePath = resolve(dirPath);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(absolutePath);
  } catch {
    throw new Error(`Directory not accessible: ${absolutePath}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${absolutePath}`);
  }

  try {
    await access(absolutePath, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(`Directory not readable: ${absolutePath}`);
  }

  const userExcludes = (additionalExcludes ?? []).map((p) => (p.startsWith("**/") ? p : `**/${p}`));
  const ignore = [...DEFAULT_EXCLUDES, ...userExcludes];

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const passthrough = new PassThrough();

    passthrough.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    const archive = archiver("zip", { zlib: { level: 6 } });

    archive.on("error", (err) => {
      reject(new Error(`Archive error: ${err.message}`));
    });

    archive.on("warning", (err) => {
      if (err.code === "ENOENT") return;
      reject(new Error(`Archive warning: ${err.message}`));
    });

    archive.pipe(passthrough);

    passthrough.on("end", () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        reject(
          new Error("Zip produced empty output — directory may have no files after exclusions"),
        );
        return;
      }
      resolve(buffer);
    });

    archive.glob("**/*", { cwd: absolutePath, ignore, dot: true });
    archive.finalize();
  });
}
