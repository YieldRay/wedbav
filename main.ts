import { SqliteDialect } from "kysely";
import SQLite from "better-sqlite3";
import { createFilesystemTableSQL, SqliteFs } from "./fs";
import { createNodeServer } from "./http";

const sqliteFs = new SqliteFs(
    new SqliteDialect({ database: new SQLite("./tmp.db").exec(createFilesystemTableSQL()) })
);

const server = createNodeServer(sqliteFs);

server.listen(8000, () => {
    console.log("Server running at http://localhost:8000/");
});
