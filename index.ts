import "hono"; // for vercel

import { attachDatabasePool } from "@vercel/functions";
import { env } from "./src/env.ts";
import { createKyselyFs } from "./src/fs.ts";
import { createHono, type WedbavOptions } from "./src/wedbav.ts";
import { dialectFromConnectionStringForVercel } from "./src/connection-string.ts";

const { dialect, pool, dbType } = dialectFromConnectionStringForVercel(env.WEDBAV_CONNECTION_STRING!);

/** https://vercel.com/guides/connection-pooling-with-functions */
if (dbType === "pg") {
  attachDatabasePool(pool);
}

const kyselyFs = createKyselyFs(dialect, {
  tableName: env.WEDBAV_TABLE,
  dbType,
});

const browser = env.WEDBAV_BROWSER as WedbavOptions["browser"];
const options: WedbavOptions = { browser };

const app = createHono(kyselyFs, options);
/** https://vercel.com/docs/frameworks/backend/hono */
export default app;
