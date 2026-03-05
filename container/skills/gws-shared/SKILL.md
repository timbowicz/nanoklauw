---
name: gws-shared
description: "Google Workspace CLI: authentication, global flags, and output formatting. Read this before using any gws-* skill."
allowed-tools: Bash(gws:*)
---

# gws — Shared Reference

## Authentication

gws is pre-configured with OAuth credentials. Check availability:

```bash
gws auth status 2>&1 | grep -q "authenticated" && echo "READY" || echo "NOT AVAILABLE"
```

If not available, Google Workspace is not enabled for this installation. Do not attempt to authenticate manually.

## CLI Syntax

```bash
gws <service> <resource> [sub-resource] <method> [flags]
```

## Global Flags

| Flag | Description |
|------|-------------|
| `--format <FORMAT>` | Output format: `json` (default), `table`, `yaml`, `csv` |
| `--dry-run` | Validate locally without calling the API |

## Method Flags

| Flag | Description |
|------|-------------|
| `--params '{"key": "val"}'` | URL/query parameters |
| `--json '{"key": "val"}'` | Request body |
| `-o, --output <PATH>` | Save binary responses to file |
| `--upload <PATH>` | Upload file content (multipart) |
| `--page-all` | Auto-paginate (NDJSON output) |
| `--page-limit <N>` | Max pages (default: 10) |
| `--page-delay <MS>` | Delay between pages in ms (default: 100) |

## Discovery

```bash
gws <service> --help            # Browse resources and methods
gws schema <service>.<resource>.<method>  # Inspect parameters, types, defaults
```

## Security Rules

- Never output secrets (API keys, tokens) directly
- Always confirm with user before executing write/delete commands
- Prefer `--dry-run` for destructive operations
