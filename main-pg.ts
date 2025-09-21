import { PostgresDialect } from "kysely";
import { Pool } from "pg";
import startServer from "./src/server.ts";

const dialect = new PostgresDialect({
  pool: new Pool({
    connectionString: process.env.DATABASE_URL_POSTGRES,
  }),
});

startServer(dialect, "pg");
