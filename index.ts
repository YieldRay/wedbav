import process from "node:process";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { KyselyFs } from "./src/fs.ts";
import { createFetchHandler } from "./src/http.ts";
import { type WebdOptions } from "./src/webd.ts";

const dialect = process.env.DATABASE_URL_POSTGRES
  ? new PostgresJSDialect({
      postgres: postgres(process.env.DATABASE_URL_POSTGRES),
    })
  : new LibsqlDialect({
      url: process.env.LIBSQL_URL || "file:local.db",
      authToken: process.env.AUTH_TOKEN,
    });

const kyselyFs = new KyselyFs(dialect, {
  tableName: process.env.WEBD_TABLE,
  dbType: "sqlite",
});

const browser = process.env.WEBD_BROWSER as WebdOptions["browser"];
const options: WebdOptions = { browser };

const app = new Hono();
app.use(logger());
app.use("*", async (c, next) => createFetchHandler(kyselyFs, options)(c.req.raw));
/** https://vercel.com/docs/frameworks/backend/hono */
export default app;