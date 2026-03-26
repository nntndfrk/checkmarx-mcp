import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | undefined;

/**
 * Reads `version` from the published `package.json` next to `dist/` at runtime
 * (same layout as the npm tarball and local `npm run build`).
 */
export function getPackageVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  const dir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(dir, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  cachedVersion = pkg.version;
  return cachedVersion;
}
