# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
