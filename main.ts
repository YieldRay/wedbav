import process from "node:process";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { KyselyFs } from "./fs.ts";
import { createServeHandler, createNodeServer } from "./http.ts";
import { type WebdOptions } from "./webd.ts";

// load all env
const port = Number(process.env["PORT"] || 3000);
const url = process.env["LIBSQL_URL"] || "file:local.db";
const authToken = process.env["AUTH_TOKEN"];
const tableName = process.env["WEBD_TABLE"];
export const username = process.env["WEBD_USERNAME"];
export const password = process.env["WEBD_PASSWORD"];
const browser = process.env["WEBD_BROWSER"] as "list" | "enabled" | "disabled" | undefined;

// create the fs
const kyselyFs = new KyselyFs(new LibsqlDialect({ url, authToken }), { tableName });
// create the webdav adapter
const options: WebdOptions = { browser };
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

declare global {
  const Bun: any;
}
