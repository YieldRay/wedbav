import { serve } from "@hono/node-server";
import type { Dialect } from "kysely";
import type { FsSubset } from "./abstract.ts";
import { env } from "./env.ts";
import { createKyselyFs } from "./fs.ts";
import { createHono, type WedbavOptions } from "./wedbav.ts";

// load all env
const port = Number(env.PORT || 3000);
const tableName = env.WEDBAV_TABLE;
const browser = env.WEDBAV_BROWSER as WedbavOptions["browser"];

export default async function startServer(
  dialect: Dialect,
  dbType?: "sqlite" | "mysql" | "pg",
  options: Partial<WedbavOptions> = {},
) {
  const kyselyFs = createKyselyFs(dialect, { tableName, dbType });
  startServerFromFS(kyselyFs, options);
}

export function startServerFromFS(fs: FsSubset, options: Partial<WedbavOptions> = {}) {
  if (!options.browser) {
    options.browser = browser;
  }

  const app = createHono(fs, options);
  const resolvedPort = options.port ?? port;

  // start the server based on the runtime
  if (typeof Deno === "object") {
    Deno.serve({ handler: app.fetch, port: resolvedPort });
    // deno will automatically log the listening message
  } else if (typeof Bun === "object") {
    Bun.serve({ port: resolvedPort, fetch: app.fetch });
    console.log(`Listening on http://localhost:${resolvedPort}`);
  } else {
    serve({
      fetch: app.fetch,
      port: resolvedPort,
    });
    console.log(`Listening on http://localhost:${resolvedPort}`);
  }
}
