import { PostgresDialect } from "kysely";
import { Pool } from "pg";
import { env } from "./src/env.ts";
import startServer from "./src/server.ts";

const dialect = new PostgresDialect({
  pool: new Pool({
    connectionString: env.DATABASE_URL_POSTGRES,
  }),
});

startServer(dialect, "pg");
