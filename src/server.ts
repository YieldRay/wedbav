import type { Dialect } from "kysely";
import { serve } from "@hono/node-server";
import { KyselyFs } from "./fs.ts";
import { type WedbavOptions, createHono } from "./wedbav.ts";
import { env } from "./env.ts";
import type { FsSubset } from "./abstract.ts";

// load all env
const port = Number(env.PORT || 3000);
const tableName = env.WEDBAV_TABLE;
const browser = env.WEDBAV_BROWSER as WedbavOptions["browser"];

export default async function startServer(dialect: Dialect, dbType?: "sqlite" | "mysql" | "pg") {
  const kyselyFs = new KyselyFs(dialect, { tableName, dbType });
  startServerFromFS(kyselyFs);
}

export function startServerFromFS(fs: FsSubset) {
  const options: WedbavOptions = { browser };

  const app = createHono(fs, options);

  // start the server based on the runtime
  //@ts-ignore
  if (typeof Deno === "object") {
    //@ts-ignore
    Deno.serve({ handler: app.fetch, port });
    // deno will automatically log the listening message
  } else if (typeof Bun === "object") {
    Bun.serve({ port, fetch: app.fetch });
    console.log(`Listening on http://localhost:${port}`);
  } else {
    serve({
      fetch: app.fetch,
      port,
    });
    console.log(`Listening on http://localhost:${port}`);
  }
}
