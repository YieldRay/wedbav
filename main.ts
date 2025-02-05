import { LibsqlDialect } from "@libsql/kysely-libsql";
import { SqliteFs } from "./fs";
import { createNodeServer } from "./http";

const sqliteFs = new SqliteFs(
    new LibsqlDialect({
        url: "file:local.db",
        // authToken: "<token>", // optional
    })
);

const server = createNodeServer(sqliteFs);

server.listen(8000, () => {
    console.log("Server running at http://localhost:8000/");
});
