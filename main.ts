import process from "node:process";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { SqliteFs } from "./fs.ts";
import { createServeHandler, createNodeServer } from "./http.ts";
import { type WebdOptions } from "./webd.ts";

const url = process.env["LIBSQL_URL"] || "file:local.db";
const authToken = process.env["AUTH_TOKEN"];
const table = process.env["WEBD_TABLE"];
const port = Number(process.env["PORT"] || 3000);

const sqliteFs = new SqliteFs(new LibsqlDialect({ url, authToken }), table);
const options: WebdOptions = { browser: process.env["WEBD_BROWSER"] as any };

if (typeof Deno === "object") {
  const handler = createServeHandler(sqliteFs, options);
  Deno.serve({ handler, port });
} else {
  console.log(`Listening on http://localhost:${port}`);
  createNodeServer(sqliteFs, options).listen(port);
}
