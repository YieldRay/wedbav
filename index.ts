import "hono";
import process from "node:process";
import { PostgresDialect } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { KyselyFs } from "./src/fs.ts";
import { type WedbavOptions, createHono } from "./src/wedbav.ts";

const isPg = !!process.env.DATABASE_URL_POSTGRES;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL_POSTGRES,
});

/** https://vercel.com/guides/connection-pooling-with-functions */
if (isPg) {
  attachDatabasePool(pool);
}

const dialect = isPg
  ? new PostgresDialect({ pool })
  : new LibsqlDialect({
      url: process.env.LIBSQL_URL || "file:local.db",
      authToken: process.env.AUTH_TOKEN,
    });

const kyselyFs = new KyselyFs(dialect, {
  tableName: process.env.WEBD_TABLE,
  dbType: "sqlite",
});

const browser = process.env.WEBD_BROWSER as WedbavOptions["browser"];
const options: WedbavOptions = { browser };

const app = createHono(kyselyFs, options);
/** https://vercel.com/docs/frameworks/backend/hono */
export default app;
