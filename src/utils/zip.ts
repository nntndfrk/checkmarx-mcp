import { constants, access, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import readdirGlob, { type Options as ReaddirGlobOptions } from "readdir-glob";

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out-tsc/**",
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

/**
 * File name patterns the `cx` CLI (2.3.27) puts in the zip, matched on the base
 * name only. Copied from ast-cli `internal/params/filters.go` (BaseIncludeFilters).
 */
const CX_INCLUDE_FILTERS = [
  "*.javasln",
  "*.project",
  "*.java",
  "*.jsp",
  "*.jspf",
  "*.tag",
  "*.tld",
  "*.hbs",
  "*.properties",
  "*.sln",
  "*.csproj",
  "*.cs",
  "*.cshtml",
  "*.xaml",
  "*.vb",
  "*.config",
  "*.asp",
  "*.bas",
  "*.vbp",
  "*.frm",
  "*.cls",
  "*.dsr",
  "*.ctl",
  "*.cpp",
  "*.c++",
  "*.cxx",
  "*.hpp",
  "*.hh",
  "*.h++",
  "*.hxx",
  "*.c",
  "*.cc",
  "*.h",
  "*.php",
  "*.php3",
  "*.php4",
  "*.php5",
  "*.php5*6",
  "*.phtm",
  "*.phtml",
  "*.tpl",
  "*.ctp",
  "*.twig",
  "*.apex",
  "*.apexp",
  "*.page",
  "*.component",
  "*.trigger",
  "*.tgr",
  "*.object",
  "*.report",
  "*.workflow",
  "*.rb",
  "*.rhtml",
  "*.rxml",
  "*.rjs",
  "*.erb",
  "*.js",
  "*.htm",
  "*.html",
  "*.json",
  "*.ts",
  "*.tsx",
  "*.vbs",
  "*.pl",
  "*.pm",
  "*.plx",
  "*.psgi",
  "*.kt",
  "*.m",
  "*.swift",
  "*.xib",
  "*.pls",
  "*.sql",
  "*.pkh",
  "*.pks",
  "*.pkb",
  "*.pck",
  "*.py",
  "*.groovy",
  "*.gsh",
  "*.gvy",
  "*.gy",
  "*.scala",
  "*.sc",
  "*.conf",
  "*.go",
  "*.kts",
  "*.cbl",
  "*.cob",
  "*.eco",
  "*.pco",
  "*.sqb",
  "*.cpy",
  "*.aspx",
  "*.ascx",
  "*.xml",
  "*.cgi",
  "*.inc",
  "*.jar",
  "*.dll",
  "*.tf",
  "*.yaml",
  "*.yml",
  "*.gradle",
  "gradlew",
  "build.gradle",
  "build.sbt",
  "yarn.lock",
  "pyproject.toml",
  "poetry.lock",
  "requirements.txt",
  "requirement.txt",
  "requirement*.txt",
  "composer.lock",
  "Dockerfile*",
  "dock*",
  "*.dart",
  "*.plist",
  "go.mod",
  "go.sum",
  "Podfile",
  "Podfile.lock",
  "*.cmp",
  "Directory.Packages.props",
  "Directory.Build.props",
  "*.rs",
  "*.jsx",
];

/**
 * Folders the `cx` CLI skips (BaseExcludeFilters), matched on the folder name.
 * `cx` uploads `.git` as is; it is skipped here because no engine needs it.
 */
const CX_FOLDER_EXCLUDES = ["**/node_modules", "**/.vs", "**/.vscode", "**/.idea", "**/.git"];

/**
 * - `cx`: same files as `cx scan create`: the CLI include list, minus a few folders.
 * - `all`: every file type, minus build output, dependency and tool folders.
 */
export type ZipMode = "cx" | "all";

/** A file added to the zip in addition to the directory contents. */
export interface ExtraZipEntry {
  /** Path inside the zip. */
  name: string;
  /** File on disk. */
  path: string;
}

export async function zipDirectory(
  dirPath: string,
  additionalExcludes?: string[],
  mode: ZipMode = "cx",
  extraEntries: ExtraZipEntry[] = [],
): Promise<Buffer> {
  const absolutePath = await validateDirectory(dirPath);
  const excludes = excludeOptions(mode, additionalExcludes);
  const globOptions: ReaddirGlobOptions = {
    ...excludes,
    // An extra entry replaces a file with the same name in the directory.
    ignore: [...(excludes.ignore as string[]), ...extraEntries.map((entry) => entry.name)],
    ...(mode === "cx"
      ? // `options.pattern` takes precedence over the glob() pattern argument.
        { pattern: CX_INCLUDE_FILTERS, matchBase: true, nodir: true }
      : {}),
  };

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

    archive.glob("**/*", { cwd: absolutePath, dot: true, ...globOptions });
    for (const entry of extraEntries) {
      archive.file(entry.path, { name: entry.name });
    }
    archive.finalize();
  });
}

/**
 * Copies `dirPath` to `destDir` with the same folder and pattern excludes as
 * `zipDirectory`, but without the `cx` include list: `cx` runs SCA Resolver on
 * the whole checkout, not on the files it zips. Returns the number of files copied.
 */
export async function stageDirectory(
  dirPath: string,
  destDir: string,
  additionalExcludes?: string[],
  mode: ZipMode = "cx",
): Promise<number> {
  const absolutePath = await validateDirectory(dirPath);
  const files = await new Promise<string[]>((resolve, reject) => {
    const matches: string[] = [];
    readdirGlob(absolutePath, {
      dot: true,
      nodir: true,
      ...excludeOptions(mode, additionalExcludes),
    })
      .on("match", (match: readdirGlob.Match) => matches.push(match.relative))
      .on("error", (error: Error) =>
        reject(new Error(`Could not read ${absolutePath}: ${error.message}`)),
      )
      .on("end", () => resolve(matches));
  });

  let copied = 0;
  for (const file of files) {
    const target = join(destDir, file);
    await mkdir(dirname(target), { recursive: true });
    try {
      await copyFile(join(absolutePath, file), target);
      copied++;
    } catch (error) {
      // Dangling symlinks and symlinks to folders are skipped, as `cx` does.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EISDIR") throw error;
    }
  }
  return copied;
}

async function validateDirectory(dirPath: string): Promise<string> {
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

  return absolutePath;
}

/**
 * Folder and pattern excludes for a zip mode plus `excludePatterns`. Folder
 * patterns (`**\/name/**`) are also skip patterns, so excluded folders are not walked.
 */
function excludeOptions(
  mode: ZipMode,
  additionalExcludes: string[] = [],
): Pick<ReaddirGlobOptions, "skip" | "ignore"> {
  const userExcludes = additionalExcludes.map((p) => (p.startsWith("**/") ? p : `**/${p}`));
  const ignore = mode === "cx" ? userExcludes : [...DEFAULT_EXCLUDES, ...userExcludes];
  const folders = ignore.filter((p) => p.endsWith("/**")).map((p) => p.slice(0, -3));
  return { skip: [...(mode === "cx" ? CX_FOLDER_EXCLUDES : []), ...folders], ignore };
}

/**
 * Builds an in-memory zip containing a single minimal `Dockerfile` with
 * `FROM <image>\n`. Used by the Container Security engine to scan an arbitrary
 * public image reference without requiring a real project source tree.
 */
export async function synthesizeDockerfileZip(image: string): Promise<Buffer> {
  if (!image || image.trim() === "") {
    throw new Error("Image reference cannot be empty");
  }

  const dockerfile = `FROM ${image.trim()}\n`;

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const passthrough = new PassThrough();

    passthrough.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    const archive = archiver("zip", { store: true });

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
        reject(new Error("Synthesized Dockerfile zip produced empty output"));
        return;
      }
      resolve(buffer);
    });

    archive.append(dockerfile, { name: "Dockerfile" });
    archive.finalize();
  });
}
