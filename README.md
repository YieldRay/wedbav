# webd-sqlite

A webdav implementation, the goal is to create a filesystem based on database with single table (and only represent file, no directory, like S3)

Supported runtimes: node/deno/bun

Design Note: use kysely as the ORM to support backend databases, no extra http library required
