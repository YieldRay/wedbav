# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev          # Node.js with watch mode (uses .env file)
pnpm dev:deno     # Deno with watch mode
pnpm dev:bun      # Bun with watch mode

# Build & Type checking
pnpm build        # Build via bun build.ts
pnpm build:lib    # Build library bundle via tsdown
pnpm type-check   # TypeScript type checking

# Linting & Formatting
pnpm lint         # Biome lint
pnpm format       # Biome format (writes)
pnpm check        # Biome format check (read-only)
```

```bash
# Testing
bun test src/*.test.ts   # Run all tests
bun test src/fs.test.ts  # Run a single test file
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
- **`src/fs.ts`** — `KyselyFs`: database filesystem. Single table `filesystem` with columns `path` (PK), `size`, `etag`, `content`, `meta`, timestamps. Directories end with `/`; implicit dirs are inferred from file paths (no row needed)
- **`src/wedbav.ts`** — `createHono()`: Hono app with WebDAV methods (PROPFIND, PUT, DELETE, GET, MKCOL, COPY, MOVE) and browser listing
- **`src/api.ts`** — `createHonoAPI()`: REST API router, all POST endpoints, OpenAPI docs at `/openapi.json`
- **`src/copy_move.ts`** — WebDAV COPY/MOVE handling with depth, overwrite, and multi-status XML responses
- **`src/server.ts`** — `startServer()` / `startServerFromFS()`: runtime detection (Deno/Bun/Node), server startup
- **`src/env.ts`** — All environment variables (`WEDBAV_USERNAME`, `WEDBAV_PASSWORD`, `PORT`, `WEDBAV_BROWSER`, `WEDBAV_TABLE`, `LIBSQL_URL`, `DATABASE_URL_POSTGRES`)
- **`src/fs-node.ts`** — Adapters: `createNodeFs()`, `createLinkFs()`, `createMemFs()` — wrap real/in-memory filesystems as `FsSubset`
- **`src/utils.ts`** — Shared helpers: `mapErrnoToStatus()`, `escapeXML()`, `createEtag()`, `encodePathForSQL()`, etc.
- **`src/index.ts`** — Library public API barrel; re-exports `createHono`, `createHonoAPI`, `createKyselyFs`, all adapters, and all abstract types
- **`index.ts`** — Vercel/production entry; detects LibSQL vs Postgres from env
- **`main.ts`** — Local dev entry; uses `createLinkFs` to serve `./tmp` at `/`

### Important Design Details

- **Implicit directories**: A file at `/a/b/c.txt` makes `/a/` and `/a/b/` exist without database rows. `KyselyFs` uses LIKE queries to infer these.
- **Streaming**: Files ≥ 1MB use `createReadStream()`; smaller files use buffer. The WebDAV GET handler checks `Content-Length` to decide.
- **ETags**: SHA256 of content, stored in the `etag` column. Conditional requests (`If-None-Match`, `If-Match`) are handled in `wedbav.ts`.
- **Browser mode**: Controlled by `WEDBAV_BROWSER` env (`disabled` | `list` | `enabled`). `list` shows directory listing; `enabled` also serves files inline.
- **Module system**: `"moduleResolution": "NodeNext"` + `"rewriteRelativeImportExtensions": true` — imports use `.ts` extensions in source.
- **Formatter**: Biome, 120-char line width, double quotes, spaces for indentation.
