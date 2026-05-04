# WEDBAV

WEDBAV is a WebDAV server backed by a database. It stores an entire filesystem in a single database table — no need to explicitly create directories, similar to S3.

Supported databases: SQLite, PostgreSQL, MySQL  
Supported runtimes: Node.js, Deno, Bun

```
  HTTP Clients (WebDAV · REST · Browser)
            │
  ┌─────────▼──────────────────────────────────┐
  │  Hono  ─  Middleware (CORS · auth · logger) │
  │  WebDAV handlers  │  REST API  │  Browser   │
  └─────────┬──────────────────────────────────┘
            │
  ┌─────────▼──────────────────────────────────┐
  │         FsSubset Interface                  │
  │  stat · readdir · readFile · writeFile …    │
  └─────────┬──────────────────────────────────┘
            │
  ┌─────────▼──────────────────────────────────┐
  │         KyselyFs                            │
  │  implicit/explicit dirs · etag · streaming  │
  └─────────┬──────────────────────────────────┘
            │
  ┌─────────▼──────────────────────────────────┐
  │  Kysely ORM  →  PostgreSQL / SQLite / MySQL │
  │                                             │
  │  "filesystem" table                         │
  │   path(PK) · size · etag · content · meta  │
  └─────────────────────────────────────────────┘
```

## Library usage

Install:

```bash
npm install wedbav
```

### Database-backed filesystem

`createKyselyFs` accepts any [Kysely dialect](https://kysely.dev/docs/dialects) — the four built-in ones (PostgreSQL, MySQL, MSSQL, SQLite) as well as community dialects for PlanetScale, Cloudflare D1, Neon, libSQL, and many more. Install the dialect package for your database separately.

```ts
import { createKyselyFs, startServerFromFS } from "wedbav";
import { LibsqlDialect } from "@libsql/kysely-libsql";

// dbType "sqlite" applies to LibSQL since it is SQLite-compatible
const fs = createKyselyFs(new LibsqlDialect({ url: "file:data.db" }), { dbType: "sqlite" });
startServerFromFS(fs, { port: 3000, browser: "list" });
```

### Bring your own filesystem

Any `FsSubset`-compatible filesystem can be passed — including the built-in adapters for the real filesystem or an in-memory filesystem:

```ts
import { createNodeFs, createLinkFs, createMemFs, startServerFromFS } from "wedbav";

// Serve the real filesystem (rooted at /)
startServerFromFS(createNodeFs(), { port: 3000 });

// Serve a specific local directory as the WebDAV root
startServerFromFS(createLinkFs(["/", "/home/user/files"]), { port: 3000 });

// Serve an in-memory filesystem
startServerFromFS(createMemFs({ "/hello.txt": "hello world" }), { port: 3000 });
```

### Hono integration

Use `createHono` to get a Hono app you can mount inside an existing server:

```ts
import { Hono } from "hono";
import { createKyselyFs, createHono } from "wedbav";
import { PostgresDialect } from "kysely";
import { Pool } from "pg";

const fs = createKyselyFs(new PostgresDialect({ pool: new Pool({ connectionString: "..." }) }), { dbType: "pg" });
const webdavApp = createHono(fs, { browser: "list" });

// Mount at a sub-path in your existing Hono app
const app = new Hono();
app.route("/files", webdavApp);
```

### `WedbavOptions`

| Option    | Type                                                         | Default             | Description                                                                                                                                           |
| --------- | ------------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`    | `number`                                                     | `3000` / `PORT` env | Port to listen on (used by `startServerFromFS`)                                                                                                       |
| `browser` | `"disabled" \| "public" \| "list" \| "enabled" \| "private"` | `"disabled"`        | `public` shows directory listing; `list` is alias to `public`; `enabled` also serves files inline; `private` is like `public` but requires basic auth |
| `auth`    | `(user: string, pass: string) => boolean`                    | env credentials     | Custom auth callback; falls back to `WEDBAV_USERNAME`/`WEDBAV_PASSWORD`                                                                               |

## Self-hosted deployment

Set environment variables as needed:

> If no database env is set, in-memory SQLite (`:memory:`) is used.

```bash
# PostgreSQL
WEDBAV_CONNECTION_STRING=postgresql://user:pass@host/db

# LibSQL / Turso
WEDBAV_CONNECTION_STRING=libsql://authToken:eyJhbXXXXXX@your-db.turso.io

# SQLite (file-based)
WEDBAV_CONNECTION_STRING=file:/path/to/database.db

# Optional
PORT=3000
WEDBAV_USERNAME=admin
WEDBAV_PASSWORD=secret
WEDBAV_BROWSER=public      # disabled | public | list | enabled | private
WEDBAV_TABLE=filesystem    # custom table name
```

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YieldRay/wedbav)
