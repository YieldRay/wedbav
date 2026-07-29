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
import { handleZipDownload, handleZipUpload } from "./zip.ts";

/**
 * A feature access level:
 * - "private": the feature is enabled but requires basic auth.
 * - "public": the feature is enabled and does not require auth.
 * - "false" / false: the feature is disabled.
 */
export type FeatureMode = "public" | "private" | "false" | false;

export interface WedbavOptions {
  auth?: ((username: string, password: string) => boolean) | undefined;
  /**
   * The browser feature serves files as a static file server. It only serves
   * requests that look like they come from browsers (based on the Accept and
   * User-Agent headers).
   * - "private": serve files, but require basic auth. This is the default value.
   * - "public": serve files without auth.
   * - "false" / false: disable file serving; requests fall through to WebDAV semantics.
   * @default {"private"}
   */
  browser?: FeatureMode | undefined;
  /**
   * The directory auto-listing feature renders an HTML listing/manager UI for
   * directories that do not contain an index.html. It only takes effect when
   * `browser` is enabled (not "false"/false).
   * - "private": render the listing, but require basic auth.
   * - "public": render the listing without auth.
   * - "false" / false: do not render a listing; directories without an index.html return 404.
   *
   * When unset, `list` inherits the value of `browser`.
   * @default inherits `browser`
   */
  list?: FeatureMode | undefined;
  /**
   * The query-string key that activates a wedbav action (part of the `list`
   * feature). Actions are triggered by `?<actionQuery>=<verb>`:
   * - `?<actionQuery>=edit` — on a file opens the in-browser editor; on a
   *   directory forces the listing/manager UI even when it contains an index.html.
   * - `?<actionQuery>=download` — on a file forces an attachment download; on a
   *   directory streams the whole tree as a zip.
   * - `?<actionQuery>=extract` (PUT only) — unzips the request body into the
   *   target directory.
   *
   * Customize this when your own app already uses `?action` and you need to avoid
   * a conflict, e.g. `actionQuery: "wedbav-action"`.
   * @default {"action"}
   */
  actionQuery?: string | undefined;
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

type ResolvedMode = "public" | "private" | false;

/** Normalize a {@link FeatureMode} to `"public" | "private" | false`. */
function resolveMode(mode: FeatureMode | undefined, fallback: ResolvedMode): ResolvedMode {
  if (mode === undefined) return fallback;
  if (mode === false || mode === "false") return false;
  return mode;
}

/**
 * Resolve the two independent feature switches into their effective modes.
 * `list` inherits `browser` when unset, and is forced off when `browser` is off
 * (directory listing only makes sense when file serving is enabled).
 */
export function resolveBrowserFeatures(options: WedbavOptions): { browser: ResolvedMode; list: ResolvedMode } {
  const browser = resolveMode(options.browser, "private");
  const list = browser === false ? false : resolveMode(options.list, browser);
  return { browser, list };
}

export function createHono(fs: FsSubset, options: WedbavOptions) {
  const app = new Hono<WedbavContext>();

  const { browser: browserMode, list: listMode } = resolveBrowserFeatures(options);
  const actionQuery = options.actionQuery || "action";
  // Read the requested action verb, e.g. `?action=edit`. Empty string when absent.
  const getAction = (c: Context<WedbavContext>): string =>
    (listMode !== false && c.var.url.searchParams.get(actionQuery)) || "";

  const verifyCredentials = (username: string, password: string): boolean => {
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
  };

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

  // Enforce basic auth inline for a "private" feature. Returns a 401 Response
  // when credentials are missing/invalid, or undefined when access is granted.
  const enforceAuth = (c: Context<WedbavContext>): Response | undefined => {
    const header = c.req.header("Authorization");
    const [scheme, encoded] = header?.split(" ") ?? [];
    if (scheme?.toLowerCase() === "basic" && encoded) {
      const [username, ...rest] = Buffer.from(encoded, "base64").toString("utf-8").split(":");
      if (verifyCredentials(username ?? "", rest.join(":"))) {
        return undefined;
      }
    }
    return c.body("Unauthorized", 401, { "WWW-Authenticate": 'Basic realm="wedbav"' });
  };

  // Serve a single file (with ETag / conditional-request handling).
  const serveFile = async (c: Context<WedbavContext>, filepath: string, stat: Awaited<ReturnType<typeof fs.stat>>) => {
    // Files are backed by a live, editable DB — never a static asset — so no cache
    // (browser, proxy, or CDN) may store the body. `no-store` is the vendor-neutral
    // directive every compliant cache must honor; the rest are belt-and-suspenders
    // for intermediaries that mishandle `no-store` alone. This prevents a stale
    // edge copy from being served after an edit.
    c.header("cache-control", "no-store, no-cache, must-revalidate, max-age=0");

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

  // Render the directory listing / manager UI.
  const serveListing = async (c: Context<WedbavContext>) => {
    const { pathname } = c.var;
    const files = await fs.readdir(pathname, { withFileTypes: true }).catch((e) => {
      if (isErrnoException(e)) return false as const;
      throw e;
    });

    const dir = removeSuffixSlash(pathname) || "/";

    if (!files) {
      // root always shows an empty listing even if the backing directory doesn't exist yet
      if (pathname !== "/") return c.text("Not Found", 404);
      return c.html(await renderManager(fs, pathname, dir, [], actionQuery));
    }

    return c.html(await renderManager(fs, pathname, dir, files, actionQuery));
  };

  // Serve a single file as a forced download (Content-Disposition: attachment).
  const serveAttachment = async (c: Context<WedbavContext>, pathname: string) => {
    const name = pathname.split("/").pop() || "download";
    try {
      const stat = await fs.stat(pathname);
      if (stat.isDirectory()) return c.text("Not Found", 404);
      const { body } = await readBufferOrStream(fs, pathname, stat);
      return c.body(convertToWebStream(body), 200, {
        "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
        "Content-Length": stat.size.toString(),
        "Content-Type": "application/octet-stream",
      });
    } catch (e) {
      if (isErrnoException(e)) return c.text("Not Found", 404);
      throw e;
    }
  };

  // Browser feature: serve files (governed by `browserMode`) and, for directories
  // without an index.html, an optional listing UI (governed by `listMode`). File
  // serving and listing carry independent auth requirements.
  app.get("/*", async (c, next) => {
    if (browserMode === false) {
      // file serving disabled → fall through to WebDAV GET semantics.
      return next();
    }

    const { pathname } = c.var;

    // Actions (`?<actionQuery>=<verb>`) are part of the `list` feature and are
    // guarded by its auth level. Supported verbs: `edit`, `download`.
    const action = getAction(c);
    if (action === "edit" || action === "download") {
      if (listMode === "private") {
        const unauthorized = enforceAuth(c);
        if (unauthorized) return unauthorized;
      }

      const hasTrailingSlash = pathname.endsWith("/");
      let isDir = hasTrailingSlash;
      if (!isDir) {
        try {
          isDir = (await fs.stat(pathname)).isDirectory();
        } catch (err) {
          if (!isErrnoException(err)) throw err;
        }
      }

      if (isDir) {
        // Trailing slash keeps the listing's relative links resolvable.
        if (!hasTrailingSlash) {
          const redirect = new URL(c.req.url);
          redirect.pathname = `${redirect.pathname}/`;
          return c.redirect(redirect.pathname + redirect.search, 308);
        }
        // `download` zips the whole tree; `edit` opens the listing/manager.
        return action === "download" ? handleZipDownload(c, fs, pathname) : serveListing(c);
      }

      // File: `download` forces an attachment; `edit` opens the editor.
      if (action === "download") return serveAttachment(c, pathname);
      return c.html(renderEditor(pathname, actionQuery));
    }

    // Auto-append index.html for browser-like requests.
    let filepath = pathname;
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
        // index.html (or the file) does not exist
      } else throw err;
    }

    // Directory (no matching file / index.html) → listing feature.
    if (!stat?.isFile()) {
      if (listMode === false) {
        // listing disabled → directories without an index.html are Not Found.
        return c.text("Not Found", 404);
      }
      if (listMode === "private") {
        const unauthorized = enforceAuth(c);
        if (unauthorized) return unauthorized;
      }
      return serveListing(c);
    }

    // File → file-serving feature.
    if (browserMode === "private") {
      const unauthorized = enforceAuth(c);
      if (unauthorized) return unauthorized;
    }

    return serveFile(c, filepath, stat);
  });

  // basic auth for all remaining (non-browser) requests, e.g. WebDAV methods.
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
      ) => verifyCredentials(username, password),
    }),
  );

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

  app.get("/*", (c) => serveAttachment(c, c.var.pathname));

  app.put("/*", async (c) => {
    const { pathname } = c.var;
    // Zip extraction (`?<actionQuery>=extract`): unzip the body into this dir.
    if (c.var.url.searchParams.get(actionQuery) === "extract") {
      return handleZipUpload(c, fs, pathname);
    }
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
