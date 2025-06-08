import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import { main } from "./src/index.ts";

const dialect = new PostgresJSDialect({
  postgres: postgres(process.env.DATABASE_URL_POSTGRES!),
});

main(dialect, "pg");
