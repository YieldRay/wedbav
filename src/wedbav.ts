import { Buffer } from "node:buffer";
import process from "node:process";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";
import { showRoutes } from "hono/dev";
import { logger } from "hono/logger";
import { getMimeType } from "hono/utils/mime";
import { ETAG, type FsSubset, type VStats } from "./abstract.ts";
import { handleCopyMoveRequest } from "./copy_move.ts";
import { renderEditor } from "./editor.ts";
import { type Bindings, env } from "./env.ts";
import { renderManager } from "./manager.ts";
import {
  convertToWebStream,
  getPathnameFromURL,
  isErrnoException,
  normalizePathLike,
  readBufferOrStream,
  removeSuffixSlash,
} from "./utils.ts";
import { davXML } from "./xml.ts";

export interface WedbavOptions {
  auth?: ((username: string, password: string) => boolean) | undefined;
  /**
   * The browser feature serves files and directories as a static file server. It only serves requests that look like they come from browsers (based on Accept and User-Agent header).
   * - "private": requires basic auth. If a directory does not contain an index.html, it renders a listing/manager HTML UI. This is the default value.
   * - "public": like "private", but does not require auth.
   * - "enabled": like "public" (no auth), but does not render the listing HTML UI — directories without an index.html return 404.
   * - "disabled": like "private" (requires auth), but does not render the listing HTML UI — directories without an index.html return 404.
   * @default {"private"}
   */
  browser?: "public" | "enabled" | "disabled" | "private" | undefined;
  port?: number | undefined;
  middleware?: MiddlewareHandler;
}

type Variables = {
  fs: FsSubset;
  options: WedbavOptions;
  url: URL;
  pathname: string;
};

export type WedbavContext = { Variables: Variables; Bindings: Bindings };

const SERVER_VERSION = displayVersion();

export function createHono(fs: FsSubset, options: WedbavOptions) {
  const app = new Hono<WedbavContext>();

  if (options.middleware) {
    app.use(options.middleware);
  }
  app.use(logger());

  app.use(async (c, next) => {
    let origin = c.req.header("origin");
    origin = origin === "null" ? "*" : origin;
    c.header("timing-allow-origin", origin);
    c.header("access-control-allow-origin", origin);
    c.header("access-control-allow-credentials", "true");

    if (c.req.method === "OPTIONS") {
      c.header("access-control-allow-methods", c.req.header("access-control-request-methods") || "*");
      c.header("access-control-allow-headers", c.req.header("access-control-request-headers") || "*");
      c.header("access-control-max-age", "86400");
      c.header("DAV", "1");
      return c.body(null, 204);
    } else {
      c.header("access-control-expose-headers", "*");
    }
    return next();
  });

  // variable middleware
  app.use("/*", async (c, next) => {
    c.set("fs", fs);
    c.set("options", options);
    c.set("url", new URL(c.req.url));
    c.set("pathname", getPathnameFromURL(c.req.url));
    c.header("server", SERVER_VERSION);
    return next();
  });

  const handleBrowserFeature = async (c: Context<WedbavContext>, renderList: boolean) => {
    const { pathname } = c.var;

    let filepath = pathname;

    // we auto append index.html for requests that look like from browsers (based on Accept and User-Agent header)
    // actually this logic is of no use, but just add it here
    // anyway, we will fallback to the webdav /GET logic, if there is no handleBrowserFeature function
    const requestHTML =
      c.req.header("accept")?.startsWith("text/html") || c.req.header("user-agent")?.startsWith("Mozilla/");
    if (requestHTML) {
      if (pathname === "/") filepath = "/index.html";
      else if (pathname.endsWith("/")) filepath += "index.html";
    }

    let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      stat = await fs.stat(filepath);
    } catch (err) {
      if (isErrnoException(err)) {
        // index.html does not exist
      } else throw err;
    }

    // when this is a directory
    if (!stat?.isFile()) {
      // do not render the directory listing HTML UI ("enabled" / "disabled" modes)
      if (!renderList) {
        return c.text("Not Found", 404);
      }

      // render an index/manager UI of the directory ("public" / "private" modes)
      const files = await fs.readdir(pathname, { withFileTypes: true }).catch((e) => {
        if (isErrnoException(e)) return false as const;
        throw e;
      });

      const dir = removeSuffixSlash(pathname) || "/";

      if (!files) {
        // root always shows an empty listing even if the backing directory doesn't exist yet
        if (pathname !== "/") return c.text("Not Found", 404);
        return c.html(await renderManager(fs, pathname, dir, []));
      }

      return c.html(await renderManager(fs, pathname, dir, files));
    }

    const etag = (stat as VStats)[ETAG];
    if (etag) {
      c.header("etag", etag);
    }

    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch) {
      if (ifNoneMatch === etag) {
        return c.body(null, 304);
      }
    } else {
      const ifModifiedSince = c.req.header("if-modified-since");
      if (ifModifiedSince) {
        const ims = new Date(ifModifiedSince);
        if (ims >= stat.mtime) {
          return c.body(null, 304);
        }
      }
    }

    try {
      const { body } = await readBufferOrStream(fs, filepath, stat);
      const contentType = getMimeType(filepath) || "application/octet-stream";

      return c.body(convertToWebStream(body), 200, {
        "last-modified": stat.mtime.toUTCString(),
        "content-length": stat.size.toString(),
        "content-type": contentType,
      });
    } catch (e) {
      if (isErrnoException(e)) {
        return c.text("Not Found", 404);
      }
      throw e;
    }
  };

  // browser feature, this part does not require auth ("public" / "enabled")
  app.get("/*", async (c, next) => {
    const { browser = "private" } = options;
    // "private"/"disabled" require auth: fall through to the auth middleware,
    // so all GET file requests are protected.
    if (browser === "private" || browser === "disabled") {
      return next();
    }

    // "public" renders the listing UI; "enabled" does not.
    const renderList = browser === "public";

    // Editor page: /path/to/file?edit (auth handled on save via PUT/MOVE)
    if (renderList) {
      const url = new URL(c.req.url);
      if (url.searchParams.has("edit") && !c.var.pathname.endsWith("/")) {
        return c.html(renderEditor(c.var.pathname));
      }
    }

    return handleBrowserFeature(c, renderList);
  });

  // basic auth
  app.use(
    "/*",
    basicAuth({
      verifyUser: (
        username,
        password,
        _c: Context<{
          Variables: Variables;
          // although we have typed the Bindings, but since it only works in Cloudflare Workers,
          // we actually DO NOT use it
          Bindings: Bindings;
        }>,
      ) => {
        if (typeof options.auth === "function") {
          return options.auth(username, password);
        }
        if (!env.WEDBAV_USERNAME) {
          if (!env.WEDBAV_PASSWORD) {
            return true;
          }
          return password === env.WEDBAV_PASSWORD;
        }
        return username === env.WEDBAV_USERNAME && password === env.WEDBAV_PASSWORD;
      },
    }),
  );

  // browser feature for authenticated modes ("private" / "disabled")
  app.get("/*", async (c, next) => {
    const { browser = "private" } = options;
    if (browser === "private" || browser === "disabled") {
      // "private" renders the listing UI; "disabled" does not.
      const renderList = browser === "private";

      // Editor page: /path/to/file?edit
      if (renderList) {
        const url = new URL(c.req.url);
        if (url.searchParams.has("edit") && !c.var.pathname.endsWith("/")) {
          return c.html(renderEditor(c.var.pathname));
        }
      }
      return handleBrowserFeature(c, renderList);
    }
    return next();
  });

  app.on("PROPFIND", "/*", async (c) => {
    const { pathname } = c.var;
    try {
      const stat = await fs.stat(pathname);
      if (stat.isDirectory()) {
        const files = await fs.readdir(pathname, { withFileTypes: true });
        const dav: Array<{
          path: string;
          contentlength: number;
          lastmodified: Date;
          isdir: boolean;
        }> = [];

        for (const file of files) {
          const path = `${removeSuffixSlash(normalizePathLike(pathname))}/${file.name}`;
          const stat = await fs.stat(path);
          dav.push({
            path,
            lastmodified: stat.mtime,
            contentlength: stat.size,
            isdir: file.isDirectory(),
          });
        }
        return c.body(davXML(stat.mtime, pathname, dav), 207, {
          "Content-Type": "text/xml; charset=UTF-8",
        });
      } else {
        // if pathname is a file, return its own info
        return c.body(davXML(stat.mtime, pathname, true), 207, {
          "Content-Type": "text/xml; charset=UTF-8",
        });
      }
    } catch (e) {
      // if the file or directory does not exist, return 404
      if (isErrnoException(e)) {
        // if is root directory, return empty list
        if (pathname === "/") {
          return c.body(davXML(new Date(), pathname, []), 207, {
            "Content-Type": "text/xml; charset=UTF-8",
          });
        }
        return c.text("Not Found", 404);
      }
      console.error(e);
      return c.text(String(e), 500);
    }
  });

  app.delete("/*", async (c) => {
    const { pathname } = c.var;
    await fs.rm(pathname, { recursive: true, force: true });
    return c.body(null, 204);
  });

  app.get("/*", async (c) => {
    const { pathname } = c.var;

    const name = pathname.split("/").pop()!;

    try {
      const stat = await fs.stat(pathname);
      if (stat.isDirectory()) {
        return c.text("Not Found", 404);
      }
      const { body } = await readBufferOrStream(fs, pathname, stat);
      return c.body(convertToWebStream(body), 200, {
        "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
        "Content-Length": stat.size.toString(),
        "Content-Type": "application/octet-stream",
      });
    } catch (e) {
      if (isErrnoException(e)) {
        return c.text("Not Found", 404);
      }
      throw e;
    }
  });

  app.put("/*", async (c) => {
    const { pathname } = c.var;
    const body = await c.req.arrayBuffer();
    await fs.writeFile(pathname, Buffer.from(body));
    return c.body("Created", 201);
  });

  app.on("PROPATCH", "/*", async (c) => {
    return c.body("Not Implemented", 501);
  });

  app.on("MKCOL", "/*", async (c) => {
    const { pathname } = c.var;
    await fs.mkdir(pathname, { recursive: true });
    return c.body("Created", 201);
  });

  app.on("COPY", "/*", (c) => handleCopyMoveRequest(c, "COPY"));

  app.on("MOVE", "/*", (c) => handleCopyMoveRequest(c, "MOVE"));

  app.use("*", async (c) => {
    return c.body("Method Not Allowed", 405, { Allow: "PROPFIND, MOVE, DELETE, GET, PUT, MKCOL" });
  });

  showRoutes(app, {
    verbose: true,
  });

  return app;
}

function displayVersion(): string {
  for (const k of ["deno", "bun", "node"]) {
    const v = process.versions[k];
    if (v) return `${k} v${v}`;
  }
  // Unknown runtime — never throw here: this runs on every response.
  return "wedbav";
}
