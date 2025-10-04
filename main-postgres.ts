import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import startServer from "./src/server.ts";
import { env } from "./src/env.ts";

const dialect = new PostgresJSDialect({
  postgres: postgres(env.DATABASE_URL_POSTGRES!),
});

startServer(dialect, "pg");
