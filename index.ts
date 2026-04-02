import "hono"; // for vercel
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { attachDatabasePool } from "@vercel/functions";
import { PostgresDialect } from "kysely";
import { Pool } from "pg";
import { env } from "./src/env.ts";
import { createKyselyFs } from "./src/fs.ts";
import { createHono, type WedbavOptions } from "./src/wedbav.ts";

const isPg = !!env.DATABASE_URL_POSTGRES;

const pool = new Pool({
  connectionString: env.DATABASE_URL_POSTGRES,
});

/** https://vercel.com/guides/connection-pooling-with-functions */
if (isPg) {
  attachDatabasePool(pool);
}

const dialect = isPg
  ? new PostgresDialect({ pool })
  : new LibsqlDialect({
      url: env.LIBSQL_URL || "file:local.db",
      authToken: env.AUTH_TOKEN,
    });

const kyselyFs = createKyselyFs(dialect, {
  tableName: env.WEDBAV_TABLE,
  dbType: isPg ? "pg" : "sqlite",
});

const browser = env.WEDBAV_BROWSER as WedbavOptions["browser"];
const options: WedbavOptions = { browser };

const app = createHono(kyselyFs, options);
/** https://vercel.com/docs/frameworks/backend/hono */
export default app;
