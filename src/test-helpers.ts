import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibsqlDialect } from "@libsql/kysely-libsql";

// A unique temp-file SQLite DB per call. Unlike ":memory:" (where each pooled
// connection is an isolated database), a real file lets transactions see the
// schema/data, so tests exercise the same transactional path as production.
export function createTestDialect(): LibsqlDialect {
  const dir = mkdtempSync(join(tmpdir(), "wedbav-test-"));
  const file = join(dir, "db.sqlite");
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return new LibsqlDialect({ url: `file:${file}` });
}
