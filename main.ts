import path from "node:path/posix";
import { fileURLToPath } from "node:url";
import { createLinkFs } from "./src/fs-node.ts";
import { startServerFromFS } from "./src/server.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(path.dirname(__filename));

const dir = path.join(__dirname, "tmp");
const fs = createLinkFs(["/", dir]);
startServerFromFS(fs);
