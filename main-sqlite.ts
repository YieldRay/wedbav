import { LibsqlDialect } from "@libsql/kysely-libsql";
import { env } from "./src/env.ts";
import startServer from "./src/server.ts";

const url = env.LIBSQL_URL || "file:local.db";
const authToken = env.AUTH_TOKEN;

const dialect = new LibsqlDialect({
  url,
  authToken,
});

startServer(dialect, "sqlite");
