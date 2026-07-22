import { existsSync, mkdirSync } from "node:fs";
import path from "node:path/posix";
import { fileURLToPath } from "node:url";
import { createLinkFs } from "./src/fs-node.ts";
import { startServerFromFS } from "./src/server.ts";
import { env } from "./src/env.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(path.dirname(__filename));

const dir = path.join(__dirname, "tmp");
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const fs = createLinkFs(["/", dir]);
startServerFromFS(fs, {
  middleware: async (c, next) => {
    //! vscode client that can be used for smoke testing the webdav and wedbav api.
    //! comment these lines out to test the rendered html page.
    if (c.req.method === "GET" && c.req.path === "/") {
      const url = new URL("https://wedbav-vscode.yieldray.fun/");
      url.searchParams.set("username", env.WEDBAV_USERNAME || "");
      url.searchParams.set("password", env.WEDBAV_PASSWORD || "");
      url.searchParams.set("endpoint", new URL(c.req.url).origin);
      return c.redirect(url);
    }
    return next();
  },
});
