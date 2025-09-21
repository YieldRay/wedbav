import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import startServer from "./src/server.ts";

const dialect = new PostgresJSDialect({
  postgres: postgres(process.env.DATABASE_URL_POSTGRES!),
});

startServer(dialect, "pg");
