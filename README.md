# WEDBAV

WEDBAV is a WebDAV implementation based on database.

Goal of this project is to create a filesystem based on a database with a single table, which store all files and directories, no need to explicit create a directory, similar to S3.

Supported databases: SQLite, Postgres, MySQL  
Supported runtimes: Node.js, Deno, Bun

Design Note:

- Uses Kysely as the ORM to support backend databases.
- Layered architecture: The WebDAV layer operates the fs API, and the database layer implements the fs API (the fs API interface is similar to Node.js's fs/promises module).

## Deployment

Set the environment variables as needed:

> If no environment variables are provided, a local SQLite file will be created and used as the database.

```bash
# fill this if you use postgres
DATABASE_URL_POSTGRES=postgresql://xxx

# fill this if you use libsql
LIBSQL_URL=libsql://xxx
AUTH_TOKEN=eyJhb

# optional
WEDBAV_USERNAME=admin
WEDBAV_PASSWORD=123456
WEDBAV_BROWSER=list
```

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YieldRay/wedbav)
