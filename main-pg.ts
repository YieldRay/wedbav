import { PostgresDialect } from "kysely";
import { Pool } from "pg";
import startServer from "./src/server.ts";
import { env } from "./src/env.ts";

const dialect = new PostgresDialect({
  pool: new Pool({
    connectionString: env.DATABASE_URL_POSTGRES,
  }),
});

startServer(dialect, "pg");
