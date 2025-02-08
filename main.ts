import process from "node:process";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { SqliteFs } from "./fs.ts";
import { createServeHandler, createNodeServer } from "./http.ts";
import { type WebdOptions } from "./webd.ts";

const url = process.env["LIBSQL_URL"] || "file:local.db";
const authToken = process.env["AUTH_TOKEN"];

const sqliteFs = new SqliteFs(new LibsqlDialect({ url, authToken }));
const options: WebdOptions = { browser: "list" };

if (typeof Deno === "object") {
    const handler = createServeHandler(sqliteFs, options);
    Deno.serve(handler);
} else {
    console.log("Listening on http://localhost:8000");
    createNodeServer(sqliteFs, options).listen(8000);
}
