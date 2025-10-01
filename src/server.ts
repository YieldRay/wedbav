import process from "node:process";
import { createServer } from "node:http";
import type { Dialect } from "kysely";

import { KyselyFs } from "./fs.ts";
import { createFetchHandler, createNodeHandler } from "./http.ts";
import { type WedbavOptions } from "./wedbav.ts";

// load all env
const port = Number(process.env.PORT || 3000);
const tableName = process.env.WEDBAV_TABLE;
const browser = process.env.WEDBAV_BROWSER as WedbavOptions["browser"];

export default async function startServer(dialect: Dialect, dbType?: "sqlite" | "mysql" | "pg") {
  const kyselyFs = new KyselyFs(dialect, { tableName, dbType });
  const options: WedbavOptions = { browser };

  // start the server based on the runtime
  //@ts-ignore
  if (typeof Deno === "object") {
    const handler = createFetchHandler(kyselyFs, options);
    //@ts-ignore
    Deno.serve({ handler, port });
    // deno will automatically log the listening message
  } else if (typeof Bun === "object") {
    const fetch = createFetchHandler(kyselyFs, options);
    Bun.serve({ port, fetch });
    console.log(`Listening on http://localhost:${port}`);
  } else {
    const middleware = createNodeHandler(kyselyFs, options);
    const server = createServer(middleware).listen(port);
    server.on("listening", () => console.log(`Listening on http://localhost:${port}`));
  }
}
