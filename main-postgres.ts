import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import { env } from "./src/env.ts";
import startServer from "./src/server.ts";

const dialect = new PostgresJSDialect({
  postgres: postgres(env.DATABASE_URL_POSTGRES!),
});

startServer(dialect, "pg");
