import { LibsqlDialect } from "@libsql/kysely-libsql";
import startServer from "./src/server.ts";

const url = process.env.LIBSQL_URL || "file:local.db";
const authToken = process.env.AUTH_TOKEN;

const dialect = new LibsqlDialect({
  url,
  authToken,
});

startServer(dialect, "sqlite");
