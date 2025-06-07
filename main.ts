import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Dialect } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { KyselyFs } from "./src/fs.ts";
import { createServeHandler, createNodeServer } from "./src/http.ts";
import { type WebdOptions } from "./src/webd.ts";

// load all env
const port = Number(process.env["PORT"] || 3000);
const url = process.env["LIBSQL_URL"] || "file:local.db";
const authToken = process.env["AUTH_TOKEN"];
const tableName = process.env["WEBD_TABLE"];
export const username = process.env["WEBD_USERNAME"];
export const password = process.env["WEBD_PASSWORD"];
const browser = process.env["WEBD_BROWSER"] as WebdOptions["browser"];

if (import.meta.url.startsWith("file:")) {
  const modulePath = fileURLToPath(import.meta.url);
  if (process.argv[1] === modulePath) {
    const dialect = new LibsqlDialect({ url, authToken });
    await main(dialect);
  }
}

export async function main(dialect: Dialect, dbType?: "sqlite" | "mysql" | "pg") {
  const kyselyFs = new KyselyFs(dialect, { tableName, dbType });
  const options: WebdOptions = { browser };

  // start the server based on the environment
  if (typeof Deno === "object") {
    const handler = createServeHandler(kyselyFs, options);
    Deno.serve({ handler, port });
    // deno will automatically log the listening message
  } else if (typeof Bun === "object") {
    const fetch = createServeHandler(kyselyFs, options);
    Bun.serve({ port, fetch });
    console.log(`Listening on http://localhost:${port}`);
  } else {
    const server = createNodeServer(kyselyFs, options).listen(port);
    server.on("listening", () => console.log(`Listening on http://localhost:${port}`));
  }
}

declare global {
  const Bun: any;
}
