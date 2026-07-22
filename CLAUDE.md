# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev          # Node.js with watch mode (uses .env file)
pnpm dev:deno     # Deno with watch mode
pnpm dev:bun      # Bun with watch mode

# Build & Type checking
pnpm build        # Build library and app bundles via tsdown
pnpm type-check   # TypeScript type checking

# Linting & Formatting
pnpm lint         # Biome lint
pnpm format       # Biome format (writes)
pnpm check        # Biome format check (read-only)
```

```bash
# Testing
pnpm test                        # Run all tests (node --test src/*.test.ts)
node --test src/fs.test.ts       # Run a single test file
```

## Architecture

**WEDBAV** is a WebDAV server backed by a database. The core idea: store a filesystem in a single database table (similar to S3), then expose it over WebDAV and REST.

### Layers

```
HTTP Clients (WebDAV / REST / Browser)
        ↓
Hono app — createHono() in wedbav.ts
  CORS, Basic Auth, WebDAV handlers, browser listing
        ↓
REST API — createHonoAPI() in api.ts
  POST-based JSON endpoints with Zod validation + OpenAPI
        ↓
FsSubset interface — abstract.ts
  Node.js fs/promises-compatible abstraction
        ↓
KyselyFs — fs.ts
  Database-backed implementation (implicit/explicit dirs, ETags, streaming)
        ↓
Kysely ORM → SQLite / PostgreSQL / MySQL
```

### Key Files

- **`src/abstract.ts`** — `FsSubset` interface, `VFSError`, `VStats`, `VDirent`; defines the filesystem contract
- **`src/fs.ts`** — `KyselyFs`: database filesystem. Single table `filesystem` with columns `path` (PK), `size`, `etag`, `content`, timestamps. Directories end with `/`; implicit dirs are inferred from file paths (no row needed). Multi-row mutations (`rename`, `rmdir`, `copyFile`) run inside a transaction via the private `_transaction()` helper, which swaps `_executor` so nested `$xxx` builders join the same transaction
- **`src/wedbav.ts`** — `createHono()`: Hono app with WebDAV methods (PROPFIND, PUT, DELETE, GET, MKCOL, COPY, MOVE), browser listing, and OpenAPI docs
- **`src/api.ts`** — `createHonoAPI()`: REST API router, all POST endpoints, OpenAPI docs at `/openapi.json`. `/copy` delegates to `copyLikeOperation` in `copy_move.ts` (single source of truth for recursive copy)
- **`src/copy_move.ts`** — WebDAV COPY/MOVE handling with depth, overwrite, and multi-status XML responses; also powers the REST `/copy` endpoint
- **`src/manager.ts`** — `renderManager()`: HTML directory-listing/file-manager page (upload, mkdir, rename, delete) for browser modes
- **`src/editor.ts`** — `renderEditor()`: CodeMirror-based in-browser file editor page (`?edit`)
- **`src/xml.ts`** — `escapeXML()` and WebDAV multistatus XML builders (`davXML`)
- **`src/connection-string.ts`** — Resolves a `WEDBAV_CONNECTION_STRING` into a Kysely dialect + `dbType`. `dialectFromConnectionString` for standard runtimes, `dialectFromConnectionStringForVercel` for Vercel (returns the `pg` pool for connection pooling)
- **`src/server.ts`** — `startServer()` / `startServerFromFS()`: runtime detection (Deno/Bun/Node), server startup
- **`src/env.ts`** — All environment variables (`WEDBAV_USERNAME`, `WEDBAV_PASSWORD`, `PORT`, `WEDBAV_BROWSER`, `WEDBAV_TABLE`, `WEDBAV_CONNECTION_STRING`)
- **`src/fs-node.ts`** — Adapters: `createNodeFs()`, `createLinkFs()`, `createMemFs()` — wrap real/in-memory filesystems as `FsSubset`
- **`src/utils.ts`** — Shared helpers: `mapErrnoToStatus()`, `createEtag()`, `encodePathForSQL()`, `decodeURISafe()`, `encodePath()`, etc.
- **`src/index.ts`** — Library public API barrel; re-exports `createHono`, `createHonoAPI`, `createKyselyFs`, all adapters, and all abstract types
- **`index.ts`** — Vercel/production entry; requires `WEDBAV_CONNECTION_STRING`, uses `dialectFromConnectionStringForVercel`
- **`main.ts`** — Local dev entry; resolves the dialect from `WEDBAV_CONNECTION_STRING` (defaults to `:memory:`) and calls `startServer()`
- **`main-dev.ts`** — Alternate dev entry; uses `createLinkFs` to serve the local `./tmp` directory at `/`

### Important Design Details

- **Implicit directories**: A file at `/a/b/c.txt` makes `/a/` and `/a/b/` exist without database rows. `KyselyFs` uses LIKE queries to infer these.
- **Streaming**: Files ≥ 1MB use `createReadStream()`; smaller files use buffer. The WebDAV GET handler checks `Content-Length` to decide.
- **ETags**: SHA256 of content, stored in the `etag` column. Conditional requests (`If-None-Match`, `If-Match`) are handled in `wedbav.ts`.
- **Browser mode**: Controlled by `WEDBAV_BROWSER` env (`disabled` | `public` | `list` | `enabled` | `private`). `public` (or `list`) shows directory listing; `private` is the same but requires auth; `enabled` also serves files inline.
- **Auth semantics (INTENTIONAL)**: Basic Auth in `wedbav.ts`. If neither `WEDBAV_USERNAME` nor `WEDBAV_PASSWORD` is set, the server is intentionally **public** (any credentials accepted) — "no env means public". If only `WEDBAV_PASSWORD` is set, only the password is checked (any username). Do not "fix" this as a bug.
- **Browser page assets (INTENTIONAL)**: The manager/editor/OpenAPI HTML pages load JS/CSS from `esm.sh` / `raw.esm.sh` at runtime. This is deliberate — `esm.sh` is trusted here. Do not "fix" this as a CDN-injection issue.
- **Module system**: `"moduleResolution": "NodeNext"` + `"rewriteRelativeImportExtensions": true` — imports use `.ts` extensions in source.
- **Formatter**: Biome, 120-char line width, double quotes, spaces for indentation.
