# webd-sqlite

A webdav implementation, the goal is to create a filesystem based on database with single table (and only represent file, no directory, like S3)

supported runtimes: node/deno/bun

design note: use Kysely as orm to support backend databases, no extra http library is required
