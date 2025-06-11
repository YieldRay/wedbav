import process from "node:process";
import { createServer } from "node:http";
import type { Dialect } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { KyselyFs } from "./fs.ts";
import { createFetchHandler, createNodeHandler } from "./http.ts";
import { type WebdOptions } from "./webd.ts";

// load all env
const port = Number(process.env.PORT || 3000);
const url = process.env.LIBSQL_URL || "file:local.db";
const authToken = process.env.AUTH_TOKEN;
const tableName = process.env.WEBD_TABLE;
export const username = process.env.WEBD_USERNAME;
export const password = process.env.WEBD_PASSWORD;
const browser = process.env.WEBD_BROWSER as WebdOptions["browser"];

export async function main(dialect?: Dialect, dbType?: "sqlite" | "mysql" | "pg") {
  dialect ||= new LibsqlDialect({ url, authToken });
  const kyselyFs = new KyselyFs(dialect, { tableName, dbType });
  const options: WebdOptions = { browser };

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
