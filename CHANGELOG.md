# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-04

### Added

- **Local SCA resolution in `trigger_scan_local`** (#3). With
  `CHECKMARX_SCA_RESOLVER=docker` or `native`, the MCP runs Checkmarx SCA
  Resolver on the directory and uploads its result as `.cxsca-results.json`,
  as `cx scan create --sca-resolver` does. The scan then stores the same SCA
  packages and findings as the pipeline scan, instead of the cloud resolution
  of the lock files (which includes dev dependencies). New parameters:
  `scaResolution` (`"local"` or `"cloud"`) and `scaResolverParams` (the
  `cx --sca-resolver-params` string). A resolver failure stops the scan; there
  is no fallback to cloud resolution. Docker mode downloads the linux64 build
  once to `~/.cache/checkmarx-mcp/sca-resolver/<version>/` and checks its
  SHA-256.
- `hideDevAndTestDependencies` on `list_findings` and `findings_summary`. It
  sends `exclude-result-types=DEV_AND_TEST`, as
  `cx results show --sca-hide-dev-test-dependencies` does. It filters what is
  read, not what the scan stores. (#3)
- `zipMode` on `trigger_scan_local`. The default, `"cx"`, zips the same file
  types as `cx scan create` (CLI 2.3.27 include list) and skips only
  `node_modules`, `.git`, `.vs`, `.vscode` and `.idea`. `"all"` keeps the old
  behaviour. (#3)
- `sastFilter`, `scaFilter`, `kicsFilter`, `presetName` and `incremental` on
  `trigger_scan_local`, sent the same way `cx scan create` sends them. (#3)
- `findings_summary` returns `scaPackages`, the number of SCA packages stored
  on the scan, and `statusCounters` / `stateCounters` per engine. (#3)

### Changed

- `trigger_scan_local` now zips only the file types `cx` uploads by default, so
  a local scan reports the same SAST findings as a `cx` pipeline scan of the
  same commit. Files such as `.mjs`, `.scss` and `.md` are no longer uploaded,
  and folders such as `iac/` are scanned again. Pass `zipMode: "all"` for the
  previous behaviour. (#3)
- No SCA config value is sent when `sca` and `containers` are requested
  together. `cx` drops `enableContainersScan: false`, so sending it made MCP
  scans differ from pipeline scans. (#3)
- `findings_summary` no longer returns the top-level `counters` and
  `statusCounters` arrays. They were always empty (see Fixed). (#3)

### Fixed

- `findings_summary` was always empty: it read `counters` and `totalCounter`,
  but `/api/scan-summary` returns `scansSummaries[]` with per-engine
  `*Counters` objects. (#3)
- `list_findings` ignored `type`, because `/api/results` does not filter by
  type. The filter now runs in the MCP and `totalCount` is recounted. (#3)
- `list_findings` paging and `get_finding_details` skipped results:
  `/api/results` reads `offset` as a page index, not an item offset. Results
  are now fetched by page, as `cx` does, and `offset` / `limit` are applied in
  the MCP. (#3)

## [0.2.0] - Unreleased

### Added

- **Container Security engine** as a first-class scan type. `"containers"` is
  now accepted anywhere `scanTypes` is (i.e. `trigger_scan_git` and
  `trigger_scan_local`) and in `list_findings({ type: [...] })`.
- **`trigger_scan_image` tool** for scanning arbitrary public container image
  references (Docker Hub, GHCR, public ECR, Quay) without a Dockerfile. The
  MCP synthesizes an in-memory `FROM <image>` Docker context and uploads it.
- Containers-aware finding shaping in `list_findings`: surfaces image name/tag,
  base image, layer ID, package name/version, recommended version/image, and
  CVE / CVSS details.
- `findings_summary` now returns a reshaped payload with `perEngine` counters
  plus top-level `containersCounters` / `scaContainersCounters` for easier LLM
  consumption. The original `counters` and `statusCounters` arrays are preserved.
- Permissive image-reference validation in `trigger_scan_image` supporting
  `name:tag`, `registry/ns/name:tag`, and digest-pinned refs (`name@sha256:...`).

### Changed

- `buildScanConfig` automatically emits `enableContainersScan: "false"` on the
  SCA engine when both `sca` and `containers` are requested, per Checkmarx docs,
  so the two engines don't double-report base-image packages.
- `ScanConfig.value` widened from `Record<string, string>` to
  `Record<string, unknown>` to allow future per-engine overrides.
- `trigger_scan_local` default excludes now also skip `**/out-tsc/**`
  alongside `dist/`, `build/`, etc.

### Notes

- Defaults remain `["sast", "sca", "kics"]`; Container Security is opt-in.
- Private-registry resolution is out of scope. Configure a Private Registry
  Integration in Checkmarx One for non-public images.
