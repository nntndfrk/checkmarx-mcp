# checkmarx-mcp

[![npm](https://img.shields.io/npm/v/@nntndfrk/checkmarx-mcp)](https://www.npmjs.com/package/@nntndfrk/checkmarx-mcp)
[![license](https://img.shields.io/npm/l/@nntndfrk/checkmarx-mcp)](https://github.com/nntndfrk/checkmarx-mcp/blob/main/LICENSE)

MCP server providing AI coding agents with full programmatic access to the **Checkmarx One** security platform — projects, scans, findings, and scan triggering.

## Available Tools

| Tool | Description |
|---|---|
| `health_check` | Verify connectivity to Checkmarx One |
| `list_projects` | List projects with optional name filter |
| `get_project` | Get full project details by ID |
| `list_scans` | List scans filtered by project, status |
| `get_scan` | Get scan details (use to poll status) |
| `trigger_scan_git` | Start a scan from a Git repository URL |
| `trigger_scan_local` | Zip and upload a local directory for scanning. Zips the same files as `cx scan create` by default; accepts `sastFilter`, `scaFilter`, `kicsFilter`, `presetName`, `incremental`. Resolves SCA dependencies (`scaResolution`, `scaResolverParams`) and container images (`containersResolution`, `containerImages`) locally as `cx` does, scans a commit as a CI checkout sees it (`gitRef`, `extraPaths`), and returns `warnings` when the scan can't match a `cx` pipeline scan |
| `compare_scans` | Compare two scans, e.g. a pipeline scan and a local scan of the same commit: engines, per-engine counts, findings matched by `similarityId`, SAST findings per file, SAST LOC, and stored SCA packages with their direct, dev and test flags |
| `trigger_scan_image` | Scan an arbitrary public container image by reference (Container Security) |
| `findings_summary` | Per-engine severity, status and state counters (`perEngine`), `scaPackages`, and `containersCounters` / `scaContainersCounters`. `hideDevAndTestDependencies` recounts SCA without dev and test dependencies |
| `list_findings` | List findings with severity/type/state filters and `hideDevAndTestDependencies`. Supports `type: ["containers"]`; containers findings include `imageName`, `imageTag`, `baseImage`, `packageName/Version`, `recommendedImage`, and CVE/CVSS |
| `get_finding_details` | Full finding data flow (SAST) or CVE chain (SCA / Containers) |

All scan-trigger tools accept a `scanTypes` array. Valid values:
`sast`, `sca`, `kics`, `apisec`, `secrets`, `containers`.
Defaults remain `["sast", "sca", "kics"]` — Container Security is opt-in.

## Setup

### Prerequisites

- Node.js >= 18
- A Checkmarx One account with an API key

### Configuration

Copy `.env.example` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `CHECKMARX_API_KEY` | Yes | — | API key (refresh token) from IAM |
| `CHECKMARX_TENANT` | Yes | — | Checkmarx One tenant name |
| `CHECKMARX_BASE_URL` | No | `https://ast.checkmarx.net` | API base URL (change for EU/DEU regions) |
| `CHECKMARX_IAM_URL` | No | `https://iam.checkmarx.net` | IAM URL (change for EU/DEU regions) |
| `CHECKMARX_PROJECT_ID` | No | — | Default project UUID (tools accept per-call override) |
| `TRANSPORT` | No | `stdio` | `stdio` for CLI clients or `http` for remote |
| `PORT` | No | `3000` | Port for HTTP transport |
| `LOG_LEVEL` | No | `info` | Logging verbosity (`debug`, `info`, `error`) |
| `CHECKMARX_SCA_RESOLVER` | No | off | `docker` or `native`: resolve SCA dependencies locally in `trigger_scan_local` (see [Matching a `cx` pipeline scan](#matching-a-cx-pipeline-scan)) |
| `CHECKMARX_SCA_RESOLVER_PATH` | For `native` | — | Path to the `ScaResolver` binary |
| `CHECKMARX_SCA_RESOLVER_VERSION` | No | `2.12.23` | SCA Resolver version that `docker` mode downloads |
| `CHECKMARX_SCA_RESOLVER_IMAGE` | No | `node:24.16.0-bookworm` | Image `docker` mode runs the resolver in. It needs the package managers your projects use (`npm` for npm projects) |
| `CHECKMARX_SCA_RESOLVER_PLATFORM` | No | `linux/amd64` | Docker platform. The resolver is built for x86_64 only |
| `CHECKMARX_SCA_RESOLVER_TIMEOUT_MS` | No | `600000` | Resolver timeout |
| `CHECKMARX_SCA_RESOLVER_SHA256` | No | published checksum | Expected SHA-256 of the downloaded tarball |
| `CHECKMARX_CONTAINERS_RESOLVER` | No | off | `docker` or `native`: resolve container images locally in `trigger_scan_local` by default (see [Containers](#containers-resolve-images-locally)) |
| `CHECKMARX_CONTAINERS_RESOLVER_PATH` | For `native` | — | Path to a containers resolver binary built from [`containers-resolver/main.go`](containers-resolver/main.go) |
| `CHECKMARX_CONTAINERS_RESOLVER_VERSION` | No | `2.3.27` | `cx` (ast-cli) release whose resolver versions `docker` mode builds with |
| `CHECKMARX_CONTAINERS_RESOLVER_PLATFORM` | No | `linux/amd64` | Docker platform for the build and the run |
| `CHECKMARX_CONTAINERS_RESOLVER_TIMEOUT_MS` | No | `600000` | Resolver timeout |

### Claude Code (npx)

```json
{
  "mcpServers": {
    "checkmarx": {
      "command": "npx",
      "args": ["-y", "@nntndfrk/checkmarx-mcp"],
      "env": {
        "CHECKMARX_API_KEY": "your-api-key",
        "CHECKMARX_TENANT": "your-tenant"
      }
    }
  }
}
```

### Cursor (npx)

Add to `.cursor/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "checkmarx": {
      "command": "npx",
      "args": ["-y", "@nntndfrk/checkmarx-mcp"],
      "env": {
        "CHECKMARX_API_KEY": "your-api-key",
        "CHECKMARX_TENANT": "your-tenant"
      }
    }
  }
}
```

### From source

If running from a local clone, replace `npx` with `node` and point to the built file:

```json
{
  "command": "node",
  "args": ["/path/to/checkmarx-mcp/dist/index.js"]
}
```

### Claude Desktop (HTTP mode)

Start the server:

```bash
CHECKMARX_API_KEY=your-key CHECKMARX_TENANT=your-tenant TRANSPORT=http node dist/index.js
```

Then configure Claude Desktop to connect to `http://localhost:3000/mcp`.

### Docker

```bash
docker build -t checkmarx-mcp .

docker run -p 3000:3000 \
  -e CHECKMARX_API_KEY=your-key \
  -e CHECKMARX_TENANT=your-tenant \
  -e CHECKMARX_BASE_URL=https://eu.ast.checkmarx.net \
  -e CHECKMARX_IAM_URL=https://eu.iam.checkmarx.net \
  checkmarx-mcp
```

## Development

```bash
# Install dependencies
npm install

# Run in dev mode (stdio)
CHECKMARX_API_KEY=your-key CHECKMARX_TENANT=your-tenant npm run dev

# Build for production
npm run build

# Run tests
npm test

# Type check
npm run typecheck

# Lint & format
npm run lint
npm run format
```

## Example Prompts

### Quick security overview

> "Check Checkmarx connectivity, list my projects, and show a findings summary for the latest completed scan."

### Scan local code

> "Scan the current directory for vulnerabilities using Checkmarx."

### Scan a Git repository

> "Scan the main branch of https://github.com/org/repo with SAST and SCA."

### Triage critical findings

> "Show me all CRITICAL and HIGH findings from the latest scan on my-app project. For each SAST finding, show the data flow."

### Compare scan results

> "Compare findings between the two most recent scans on project my-api. What's new, what's fixed?"

### Fix a vulnerability

> "Get the full data flow for finding XYZ from scan ABC, then suggest a code fix based on the source and sink."

### SCA dependency audit

> "List all SCA findings for the latest scan. Group them by package and show which ones have a recommended fix version."

### Filter by state

> "Show me all findings marked as TO_VERIFY in my latest scan. Help me triage them as CONFIRMED or NOT_EXPLOITABLE."

### Infrastructure-as-Code review

> "List all KICS findings from the latest scan. Group by platform (Terraform, Dockerfile, K8s) and severity."

### Monitor scan progress

> "Trigger a SAST-only scan of the current directory, then poll until it completes and show the results."

### Scan a base image for CVEs

> "Scan nginx:1.27-alpine-slim and tell me what CVEs are in it. Prioritize HIGH and CRITICAL."

### Audit Dockerfile base images in a repo

> "Scan this repo including container security, then list the containers findings grouped by base image and recommend upgrades."

## Container Security

The MCP exposes the Checkmarx One Container Security engine in two flavors:

### Dockerfile-based (inside a repo/local scan)

Add `"containers"` to `scanTypes` when triggering a scan of code that contains a
`Dockerfile`. Checkmarx will resolve each `FROM` image, extract its package
inventory, and flag CVEs in those base-image layers.

```text
trigger_scan_local({
  directory: "/path/to/app",
  scanTypes: ["sast", "sca", "kics", "containers"]
})
```

By default Checkmarx resolves the images named in the uploaded files. To
analyse images the way a `cx` pipeline does, including images it can't pull
such as the one your pipeline builds, use `containersResolution: "local"` and
`containerImages` (see [Containers](#containers-resolve-images-locally)).

### Image-only (no Dockerfile required)

`trigger_scan_image` scans any public image reference by synthesizing a minimal
Docker context (`FROM <image>`) and uploading it. It works for any public
registry — Docker Hub, GHCR, public ECR, Quay.

```text
trigger_scan_image({ image: "nginx:1.27-alpine-slim" })
trigger_scan_image({ image: "ghcr.io/org/app:v1" })
trigger_scan_image({ image: "nginx@sha256:<digest>" })
```

For **private registries**, configure a Private Registry Integration in
Checkmarx One first. Local `docker pull` is not used by the MCP.

## Matching a `cx` pipeline scan

To check a fix before you push, a local scan should store the same findings as
the pipeline scan that runs `cx scan create`. The Checkmarx UI and the scan
counters show what a scan stores, so the scan itself has to match, not only
what you read back.

### SCA: resolve dependencies locally

A pipeline that runs `cx scan create --sca-resolver` resolves dependencies with
Checkmarx SCA Resolver on the build agent and uploads the result. Without it,
Checkmarx resolves the uploaded lock files in the cloud, dev dependencies
included, so the stored SCA results differ (for example 1148 packages instead
of 47).

Pass `scaResolution: "local"`, or set `CHECKMARX_SCA_RESOLVER` to make it the
default, and `trigger_scan_local` runs SCA Resolver the same way. Without the
variable, a per-call `"local"` runs it in Docker mode with the defaults below.

1. It copies the directory to a temp folder, skipping excluded folders.
2. It runs `ScaResolver offline -s <copy> -n <project name> -r <out>.json <scaResolverParams>`.
3. It zips the directory as usual and adds the resolver output as
   `.cxsca-results.json` at the zip root.

If the resolver fails or times out, the tool returns the error and the last 50
lines of resolver output, and no scan is created. It never falls back to cloud
resolution.

**Docker mode** (`CHECKMARX_SCA_RESOLVER=docker`) needs Docker running. It
downloads the linux64 build of SCA Resolver once to
`~/.cache/checkmarx-mcp/sca-resolver/<version>/`, checks it against the
published SHA-256, and runs it in `CHECKMARX_SCA_RESOLVER_IMAGE`. Use this on
macOS: the macOS build of SCA Resolver is x86_64 only. The image must contain
the package managers your projects use. The default Node image covers npm,
which is all SCA Resolver needs for `package-lock.json` (no `node_modules`).

**Native mode** (`CHECKMARX_SCA_RESOLVER=native`) runs the binary at
`CHECKMARX_SCA_RESOLVER_PATH` with the package managers on your `PATH`.

Pass the pipeline's `--sca-resolver-params` string unchanged as
`scaResolverParams`:

```text
trigger_scan_local({
  directory: "/path/to/app",
  branch: "feature/login-mcp",
  scanTypes: ["sast", "sca", "kics"],
  sastFilter: "!**\\node_modules,!**\\.git,!**\\dist",
  scaResolverParams: "--extract-archives zip,ear,war --extract-depth 1 --ignore-dev-dependencies --maven-parameters='-Dscope=runtime'"
})
```

The result reports `scaResolution`, the resolver mode and version, and the
number of resolved packages. Pass `scaResolution: "cloud"` to skip the resolver
for one scan. A scan resolved in the cloud returns a warning that it will not
match a pipeline scan that uses `cx --sca-resolver`.

`hideDevAndTestDependencies` on `list_findings` and `findings_summary` is
still useful for scans resolved in the cloud, but it only filters what you
read. The stored scan keeps the dev dependencies.

### Scan a commit instead of the working tree

A pipeline scans a fresh checkout. Your folder also has untracked files,
uncommitted changes and local build output. Pass `gitRef` (a commit, branch or
tag) to scan what a CI checkout of that commit sees: tracked files only, with
no `.git`, ignored or untracked files. The MCP checks the commit out to a temp
folder with a temporary git index, so your index and working tree don't
change. `.gitattributes` filters and line endings apply as in a checkout;
`export-ignore` does not, because CI checkouts keep those files. Submodules are
not included.

If the pipeline builds before it scans, add the build output from your working
tree with `extraPaths`. Paths are relative to `directory` and go through the
same zip filters as the rest:

```text
trigger_scan_local({
  directory: "/path/to/app",
  branch: "main-mcp",
  gitRef: "4f2c9e1",
  extraPaths: ["dist", "iac/generated"],
  scanTypes: ["sast", "sca", "kics", "containers"],
  scaResolution: "local",
  containerImages: ["registry.example.com/team/app:1.2.3"]
})
```

The result reports the commit the ref resolved to.

### Compare the scans

`compare_scans` compares a pipeline scan (`baseScanId`) with a local scan
(`compareScanId`) and lists what differs in `differences`:

- the engines that ran;
- per-engine counts by severity, and the findings only one scan has, matched
  by `similarityId`;
- SAST findings per file, and SAST LOC, file count and preset;
- the stored SCA packages with their direct, dev and test flags, read from the
  SCA `ScanReportJson` export as `cx` does.

An empty `differences` list means the scans match.

### Files and settings

- `trigger_scan_local` zips the same file types as the `cx` CLI (2.3.27) and
  skips only `node_modules`, `.git`, `.vs`, `.vscode` and `.idea`. Use
  `zipMode: "all"` to upload every file type instead.
- Local build output and caches, such as `dist/` or `.angular/`, are uploaded
  too, as `cx` would. If the pipeline scans a clean checkout, add them to
  `excludePatterns`, or set a matching `sastFilter`.
- Pass the same `sastFilter`, `scaFilter`, `kicsFilter`, `presetName` and
  `incremental` values the pipeline passes to `cx`.
- Use a separate branch label for manual scans, for example `<branch>-mcp`, so
  they don't mix into the real branch history.

### Containers: resolve images locally

When `containers` is in the scan types and the tenant flag
`CONTAINER_ENGINE_CLI_ENABLED` is on, `cx scan create` resolves containers on
the build agent before it zips the source:

1. It finds images in Dockerfiles, Docker Compose files and Helm charts, and
   adds the images from `--container-images`.
2. It analyses each image with syft (Checkmarx `containers-resolver`).
3. It adds `.checkmarx/containers/containers-resolution.json` to the zip. SAST
   scans that file too, so its image and layer digests can show up as
   `TruffleHog_HighEntropy_Strings` findings.

With `containersResolution: "local"`, `trigger_scan_local` does the same:

1. It reads `CONTAINER_ENGINE_CLI_ENABLED` as `cx` does. When the flag is off,
   an explicit `"local"` fails, because `cx` would not resolve locally either.
2. It copies the directory to a temp folder, skipping excluded folders, and
   runs the resolver on that copy. Your folder is never written to.
3. It adds the result to the zip as
   `.checkmarx/containers/containers-resolution.json`, replacing any file with
   that name in the folder. When `containers` is the only scan type, the zip
   holds only that file, as with `cx`.

Pass the pipeline's `--container-images` value as `containerImages`. Giving
`containerImages` selects local resolution:

```text
trigger_scan_local({
  directory: "/path/to/app",
  branch: "feature/login-mcp",
  scanTypes: ["sast", "sca", "kics", "containers"],
  scaResolution: "local",
  containerImages: ["registry.example.com/team/app:1.2.3"]
})
```

The result reports `containersResolution` and, per image, its origins
(`UserInput`, `Dockerfile`, `DockerCompose`, `Helm`), the files that name it
and its package count. Images the resolver could not analyse are listed in
`notAnalyzed` and in `warnings`.

The resolver reads images from the local Docker daemon first, then from the
registry. **Pull or build private images locally before you scan**, for
example `docker pull registry.example.com/team/app:1.2.3`. An image rebuilt
locally from the same Dockerfile has different digests, so only the
TruffleHog findings on those digests will differ from the pipeline scan.

Checkmarx ships no standalone resolver binary:

- **Docker mode** (default, or `CHECKMARX_CONTAINERS_RESOLVER=docker`) needs
  Docker running. The first scan builds the wrapper in
  [`containers-resolver/main.go`](containers-resolver/main.go) in a
  `golang:1.24` container, inside the `ast-cli` module at tag
  `CHECKMARX_CONTAINERS_RESOLVER_VERSION`, so it uses the same
  containers-resolver, syft and stereoscope versions as that `cx` release.
  The binary is cached in
  `~/.cache/checkmarx-mcp/containers-resolver/<version>/<platform>/`. The build
  takes a few minutes, longer under emulation on Apple Silicon. Scans run the
  binary in `golang:1.24` with `/var/run/docker.sock` mounted and the source
  copy mounted read-only.
- **Native mode** (`CHECKMARX_CONTAINERS_RESOLVER=native`) runs the binary at
  `CHECKMARX_CONTAINERS_RESOLVER_PATH`. Build it as the comment at the top of
  `main.go` shows. It needs a Docker or Podman daemon for local images.

Set `CHECKMARX_CONTAINERS_RESOLVER` to make local resolution the default for
every scan with `containers`. Without it, a scan with `containers` on a tenant
with the flag on returns a warning that it will differ from a `cx` scan.

## Troubleshooting

**"Invalid configuration" on startup** — Check that `CHECKMARX_API_KEY` and `CHECKMARX_TENANT` are set. See `.env.example` for all available options.

**"Auth failed: invalid_grant"** — Your API key may have expired. Generate a new one in Checkmarx One under IAM > API Keys.

**"Health check failed"** — Verify `CHECKMARX_BASE_URL` matches your region (US: `ast.checkmarx.net`, EU: `eu.ast.checkmarx.net`).

**Containers resolver build fails**: the first local container resolution clones `ast-cli` from GitHub and downloads Go modules in Docker. Check network access from Docker, and that `CHECKMARX_CONTAINERS_RESOLVER_VERSION` is an existing `ast-cli` tag.

**Scans stuck in "Queued"** — This is normal for large queues. Use `get_scan` to poll. Scans typically start within a few minutes.

## License

MIT
