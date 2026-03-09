# Architecture — OpenClaw Design Tools

## Overview

OpenClaw Design Tools is a plugin that provides design tooling for AI agents:

- **Design Catalog** — Artifact management with versioned entries and status lifecycle
- **Design Vision** — Visual analysis via Gemini (future)
- **Stitch Native Tools** — Google Stitch API integration

## Architecture

```
┌─────────────────────────────────────────────┐
│              OC Plugin Layer                 │
│  src/index.ts → src/adapter.ts              │
│  (reads config, registers tools)            │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│              Pure TS Core                    │
│  src/core/                                  │
│  ├── stitch-client.ts   (HTTP JSON-RPC)     │
│  ├── catalog-manager.ts (JSON read/write)   │
│  ├── file-manager.ts    (download + paths)  │
│  └── types.ts           (shared types)      │
└─────────────────────────────────────────────┘
```

### Design Principles

1. **Pure TS core + thin OC adapter** — All business logic lives in `src/core/`. The adapter layer (`src/adapter.ts`, `src/index.ts`) only maps OC's plugin API to the core interfaces. This keeps the core testable and portable.

2. **No external dependencies for core** — The core uses only Node.js built-ins and web APIs (`fetch`). No MCP SDK, no mcporter.

3. **Atomic writes** — CatalogManager uses temp-file-then-rename for crash safety.

4. **Path traversal protection** — FileDownloadManager validates all paths before any I/O.

5. **Typed errors** — Every error class carries context (status codes, RPC codes) for actionable diagnostics.

## StitchClient

Direct HTTP JSON-RPC 2.0 client for `https://stitch.googleapis.com/mcp`.

- Auth: `X-Goog-Api-Key` header
- Timeout: configurable (default 60s) via AbortController
- Retry: ONLY on 429, exponential backoff (1s, 2s, 4s), max 3 retries
- Error hierarchy: StitchAuthError, StitchPermissionError, StitchRateLimitError, StitchTimeoutError, StitchNetworkError, StitchParseError, StitchRpcError

## CatalogManager

Manages `{project}/design-artifacts/catalog.json`.

- Schema: `{ version: 1, entries: CatalogEntry[] }`
- Status lifecycle: draft → review → approved → implemented (+ rejected → draft)
- Concurrent write safety via serialization queue
- Atomic writes: `.catalog.json.tmp` → `catalog.json`

## FileDownloadManager

Downloads files from URLs to the local filesystem.

- Auto-creates directories
- Path traversal protection (rejects `..`, absolute paths, URL-encoded sequences)
- Content-type validation
- Cleanup partial downloads on failure
- Configurable overwrite behavior

## Plugin Registration

The plugin registers with OpenClaw via the standard plugin API:

1. `src/index.ts` exports a `register(api)` function
2. Config is read via `api.pluginConfig` (dot-separated keys)
3. API key sourced from config (`stitch.apiKey`) or env (`STITCH_API_KEY`)
4. Core classes initialized per session via tool factory
5. Currently 0 tools — infrastructure only (tools added in later objectives)

## Catalog Version

Current version: 1. When schema changes require migration, bump `CURRENT_CATALOG_VERSION` and add migration logic to `CatalogManager.read()`.
