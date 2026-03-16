# checkmarx-mcp

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
| `trigger_scan_local` | Zip and upload a local directory for scanning |
| `findings_summary` | Severity breakdown by scanner type |
| `list_findings` | List findings with severity/type/state filters |
| `get_finding_details` | Full finding data flow (SAST) or CVE chain (SCA) |

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

### Claude Code

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "checkmarx": {
      "command": "node",
      "args": ["/path/to/checkmarx-mcp/dist/index.js"],
      "env": {
        "CHECKMARX_API_KEY": "your-api-key",
        "CHECKMARX_TENANT": "your-tenant"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "checkmarx": {
      "command": "node",
      "args": ["/path/to/checkmarx-mcp/dist/index.js"],
      "env": {
        "CHECKMARX_API_KEY": "your-api-key",
        "CHECKMARX_TENANT": "your-tenant"
      }
    }
  }
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
bun install

# Run in dev mode (stdio)
CHECKMARX_API_KEY=your-key CHECKMARX_TENANT=your-tenant bun run dev

# Build for production
bun run build

# Run tests
bun test

# Type check
bun run typecheck

# Lint & format
bun run lint
bun run format
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

## Troubleshooting

**"Invalid configuration" on startup** — Check that `CHECKMARX_API_KEY` and `CHECKMARX_TENANT` are set. See `.env.example` for all available options.

**"Auth failed: invalid_grant"** — Your API key may have expired. Generate a new one in Checkmarx One under IAM > API Keys.

**"Health check failed"** — Verify `CHECKMARX_BASE_URL` matches your region (US: `ast.checkmarx.net`, EU: `eu.ast.checkmarx.net`).

**Scans stuck in "Queued"** — This is normal for large queues. Use `get_scan` to poll. Scans typically start within a few minutes.

## License

MIT
