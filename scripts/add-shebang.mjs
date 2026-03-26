import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/index.js";
const body = readFileSync(path, "utf8");
const shebang = "#!/usr/bin/env node\n";
if (!body.startsWith(shebang)) {
  writeFileSync(path, shebang + body);
}
