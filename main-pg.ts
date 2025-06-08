import { Pool } from "pg";
import { PostgresDialect } from "kysely";
import { main } from "./src/index.ts";

const dialect = new PostgresDialect({
  pool: new Pool({
    connectionString: process.env.DATABASE_URL_POSTGRES,
  }),
});

main(dialect, "pg");
