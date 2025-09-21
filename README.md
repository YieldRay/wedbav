# webd-sqlite

A WebDAV implementation.

Goal of this project is to create a filesystem based on a database with a single table, which store all files and directories, no need to explicit create a directory, similar to S3.

Supported runtimes: Node.js, Deno, Bun

Design Note:

- Uses Kysely as the ORM to support backend databases.
- Layered architecture: The WebDAV layer operates the fs API, and the database layer implements the fs API (the fs API interface is similar to Node.js's fs/promises module).
