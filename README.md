# WEDBAV

WEDBAV is a WebDAV server backed by a database. It stores an entire filesystem in a single database table, so you never explicitly create directories, similar to S3.

Supported databases: SQLite, PostgreSQL, MySQL

Supported runtimes: Node.js, Deno, Bun

```text
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

`createKyselyFs` accepts any [Kysely dialect](https://kysely.dev/docs/dialects): the four built-in ones (PostgreSQL, MySQL, MSSQL, SQLite) plus community dialects such as PlanetScale, Cloudflare D1, Neon, and libSQL. Install the dialect package for your database separately.

```ts
import { createKyselyFs, startServerFromFS } from "wedbav";
import { LibsqlDialect } from "@libsql/kysely-libsql";

// dbType "sqlite" applies to LibSQL since it is SQLite-compatible
const fs = createKyselyFs(new LibsqlDialect({ url: "file:data.db" }), { dbType: "sqlite" });
startServerFromFS(fs, { port: 3000, browser: "public" });
```

### Bring your own filesystem

You can pass any `FsSubset`-compatible filesystem, including the built-in adapters for the real filesystem or an in-memory filesystem:

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

const fs = createKyselyFs(
  new PostgresDialect({ pool: new Pool({ connectionString: "postgresql://user_here:password_here@host/db_name" }) }),
  { dbType: "pg" },
);
const webdavApp = createHono(fs, { browser: "public" });

// Mount at a sub-path in your existing Hono app
const app = new Hono();
app.route("/files", webdavApp);
```

### `WedbavOptions`

| Option    | Type                                        | Default             | Description                                                                                                                                                                          |
| --------- | ------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `port`    | `number`                                    | `3000` / `PORT` env | Port to listen on (used by `startServerFromFS`)                                                                                                                                      |
| `browser` | `"public" \| "private" \| "false" \| false` | `"private"`         | File-serving feature. `private` serves files behind basic auth; `public` serves them without auth; `false` disables it (requests fall through to WebDAV GET semantics).              |
| `list`    | `"public" \| "private" \| "false" \| false` | inherits `browser`  | Directory auto-listing UI. Same access levels as `browser`, applied independently. Only takes effect when `browser` is enabled; when disabled, dirs without `index.html` return 404. |
| `editQuery` | `string`                                  | `"edit"`            | Query key that activates the management UI: `?<editQuery>` opens the editor on a file, or forces the directory listing/manager on a directory (even when it has an `index.html`). Change it if your app already uses `?edit`. |
| `auth`    | `(user: string, pass: string) => boolean`   | env credentials     | Custom auth callback; falls back to `WEDBAV_USERNAME`/`WEDBAV_PASSWORD`                                                                                                              |

`browser` and `list` carry **independent** auth requirements. For example, `{ browser: "public", list: "private" }` serves files to anyone but requires auth to view the directory listing.

The management UI is reached via the `editQuery` (default `?edit`): on a file it opens the editor, and on a directory it forces the listing/manager page — useful for managing files in a directory that has an `index.html`. Since it is part of the `list` feature, it is disabled when `list` is `false` and follows `list`'s auth level.

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
WEDBAV_BROWSER=private     # public | private | false  (file serving)
WEDBAV_LIST=private        # public | private | false  (dir listing; defaults to WEDBAV_BROWSER)
WEDBAV_TABLE=filesystem    # custom table name
```
