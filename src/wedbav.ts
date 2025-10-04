import { Buffer } from "node:buffer";
import process from "node:process";
import { Readable } from "node:stream";
import { lookup } from "mrmime";
import { type FsSubset, type VStats, ETAG } from "./abstract.ts";
import { isErrnoException, normalizePathLike, removeSuffixSlash } from "./utils.ts";
import { copyLikeOperation, mapErrnoToStatus, multiStatusXML, normalizeDavPath } from "./copy_move.ts";
import type { Bindings } from "./env.ts";
import { Hono, type Context } from "hono";
import { html, raw } from "hono/html";
import { basicAuth } from "hono/basic-auth";
import { logger } from "hono/logger";
import { showRoutes } from "hono/dev";
import { cors } from "hono/cors";

export interface WedbavOptions {
  auth?: (username: string, password: string) => boolean;
  /** @default {"disabled"} */
  browser?: "list" | "enabled" | "disabled";
}

export function createHono(fs: FsSubset, options: WedbavOptions) {
  type Variables = {
    fs: FsSubset;
    options: WedbavOptions;
    url: URL;
    pathname: string;
  };

  const app = new Hono<{ Variables: Variables; Bindings: Bindings }>();

  app.use(logger());

  app.use(cors());

  // variable middleware
  app.use("/*", async (c, next) => {
    c.set("fs", fs);
    c.set("options", options);
    c.set("url", new URL(c.req.url));
    c.set("pathname", getPathnameFromURL(c.req.url));
    c.header("server", displayVersion());
    return next();
  });

  // browser feature
  app.get("/*", async (c, next) => {
    const { browser = "disabled" } = options;
    // if browser is disabled, or the request is not from a browser, skip
    if (browser === "disabled" || !c.req.header("user-agent")?.startsWith("Mozilla/")) {
      return next();
    }

    const { pathname } = c.var;

    let filepath = pathname;
    if (pathname === "/") filepath = "/index.html";
    else if (pathname.endsWith("/")) filepath += "index.html";

    // browser can only be "enabled" or "list"
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
      // do not list directory
      if (options.browser !== "list") {
        return c.text("Not Found", 404);
      }

      // here browser is "list" and the file does not exist, we return an index of the directory
      const files = await fs.readdir(pathname, { withFileTypes: true });
      const dir = removeSuffixSlash(pathname);

      return c.html(`<html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Index of ${dir}</title>
          </head>
          <body>
            <h1>Index of ${dir}</h1>
            <ul>
              ${dir !== "" && dir !== "/" ? `<li><a href="../">../</a></li>` : ""}
              ${raw(
                files
                  .filter((file) => file.isDirectory())
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((file) => html`<li><a href="./${file.name}/">${file.name}/</a></li>`)
                  .join("\n")
              )}
              ${raw(
                files
                  .filter((file) => file.isFile())
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((file) => html`<li><a href="./${file.name}">${file.name}</a></li>`)
                  .join("\n")
              )}
            </ul>
          </body>
        </html>`);
    }

    const etag = (stat as VStats)[ETAG];
    if (etag) {
      c.header("etag", etag);
    }

    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch) {
      if (ifNoneMatch === etag) {
        return c.status(304);
      }
    } else {
      const ifModifiedSince = c.req.header("if-modified-since");
      if (ifModifiedSince) {
        const ims = new Date(ifModifiedSince);
        if (ims >= stat.mtime) {
          return c.status(304);
        }
      }
    }

    const { body } = await readBufferOrStream(fs, filepath);
    return c.body(convertToWebStream(body), 200, {
      "last-modified": stat.mtime.toUTCString(),
      "content-length": stat.size.toString(),
      "content-type": lookup(filepath) || "application/octet-stream",
    });
  });

  // basic auth
  if (options.auth) {
    app.use(
      "/*",
      basicAuth({
        verifyUser: (
          username,
          password,
          c: Context<{
            Variables: Variables;
            Bindings: Bindings;
          }>
        ) => {
          if (typeof options.auth === "function") {
            return options.auth(username, password);
          }
          return username === c.env.WEDBAV_USERNAME && password === c.env.WEDBAV_PASSWORD;
        },
      })
    );
  }

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
          const path = removeSuffixSlash(normalizePathLike(pathname)) + "/" + file.name;
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
    return c.status(204);
  });

  app.get("/*", async (c) => {
    const { pathname } = c.var;

    const name = pathname.split("/").pop()!;
    const { body, stat } = await readBufferOrStream(fs, pathname);
    return c.body(convertToWebStream(body), 200, {
      "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
      "Content-Length": stat.size.toString(),
      "Content-Type": "application/octet-stream",
    });
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

  app.on("COPY", "/*", async (c) => {
    const { pathname } = c.var;
    const depth = c.req.header("Depth") === "0" ? 0 : Infinity;
    const overwrite = c.req.header("Overwrite") !== "F"; // Overwrite is "T" by default
    const dest = c.req.header("Destination");
    if (!dest) {
      return c.text("Bad Request: Destination header is required", 400);
    }
    const destURL = new URL(dest, c.req.url);
    if (c.var.url.origin !== destURL.origin) {
      return c.text("Bad Gateway: Destination must be same origin", 502);
    }
    const destPathname = getPathnameFromURL(destURL);

    const result = await copyLikeOperation({
      fs,
      sourcePath: pathname,
      destinationPath: destPathname,
      depth,
      overwrite,
    });

    if (!result.ok) {
      return c.text(result.message, result.status);
    }

    if (result.errors.length) {
      return c.body(multiStatusXML(result.errors), 207, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }

    const status = result.destinationExisted ? 204 : 201;
    if (status === 201) {
      return c.body("Created", 201, {
        Location: encodeURI(destPathname),
      });
    }
    return c.status(204);
  });

  app.on("MOVE", "/*", async (c) => {
    const { pathname } = c.var;
    const depth = c.req.header("Depth") === "0" ? 0 : Infinity;
    const overwrite = c.req.header("Overwrite") !== "F"; // Overwrite is "T" by default
    const dest = c.req.header("Destination");
    if (!dest) {
      return c.text("Bad Request: Destination header is required", 400);
    }
    const destURL = new URL(dest, c.req.url);
    if (c.var.url.origin !== destURL.origin) {
      return c.text("Bad Gateway: Destination must be same origin", 502);
    }
    const destPathname = getPathnameFromURL(destURL);

    let sourceStat: Awaited<ReturnType<FsSubset["stat"]>>;
    try {
      sourceStat = await fs.stat(pathname);
    } catch (err) {
      if (isErrnoException(err)) {
        return c.text("Not Found", 404);
      }
      throw err;
    }

    if (normalizeDavPath(pathname) === "/") {
      return c.text("Forbidden: cannot move root collection", 403);
    }

    if (sourceStat.isDirectory() && depth === 0) {
      return c.text("Bad Request: Depth:0 is not allowed when moving a collection", 400);
    }

    const result = await copyLikeOperation({
      fs,
      sourcePath: pathname,
      destinationPath: destPathname,
      depth,
      overwrite,
      providedSourceStat: sourceStat,
    });

    if (!result.ok) {
      return c.text(result.message, result.status);
    }

    if (result.errors.length) {
      return c.body(multiStatusXML(result.errors), 207, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }

    try {
      await fs.rm(normalizeDavPath(pathname), {
        recursive: sourceStat.isDirectory(),
        force: false,
      });
    } catch (err) {
      if (isErrnoException(err)) {
        return c.text("Failed to remove source after move", mapErrnoToStatus(err));
      }
      throw err;
    }

    const status = result.destinationExisted ? 204 : 201;
    if (status === 201) {
      return c.body("Created", 201, {
        Location: encodeURI(destPathname),
      });
    }
    return c.status(204);
  });

  app.use("*", async (c) => {
    return c.body("Method Not Allowed", 405, { Allow: "PROPFIND, MOVE, DELETE, GET, PUT, MKCOL" });
  });

  showRoutes(app, {
    verbose: true,
  });

  return app;
}

export function getPathnameFromURL(url: string | URL) {
  return decodeURISafe(new URL(url).pathname);
}

function decodeURISafe(uri: string): string {
  try {
    return decodeURI(uri);
  } catch {
    return uri;
  }
}

function getNameFromRawPath(path: string) {
  return removeSuffixSlash(path).split("/").pop() || "/";
}

const THRESHOLD = 1024 * 1024; // 1MB
async function readBufferOrStream(fs: FsSubset, pathname: string, stat?: { size: number }) {
  stat ??= await fs.stat(pathname);
  if (stat.size > THRESHOLD) {
    const stream = fs.createReadStream(pathname);
    return {
      body: stream,
      stat,
    };
  } else {
    const buffer = (await fs.readFile(pathname)) as unknown as Uint8Array;
    return {
      body: buffer,
      stat,
    };
  }
}

function davXML(
  date: Date,
  dir: string,
  filesOrThisIsFile: Array<{ path: string; contentlength: number; lastmodified: Date; isdir: boolean }> | true = []
) {
  const files = filesOrThisIsFile === true ? [] : filesOrThisIsFile;
  const isDir = filesOrThisIsFile !== true;

  return /* xml */ `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<d:multistatus xmlns:d="DAV:">
${davXMLSingleResponse(dir, 0, date, isDir)}
${files
  .map(({ path, contentlength, lastmodified, isdir }) => davXMLSingleResponse(path, contentlength, lastmodified, isdir))
  .join("\n")}    
</d:multistatus>`;
}

function davXMLSingleResponse(path: string, contentlength: number, lastmodified: Date, isdir: boolean) {
  return /* xml */ `<d:response>
    <d:href>${encodeURI(path + (isdir ? "/" : ""))}</d:href>
    <d:propstat>
        <d:prop>
            <d:displayname>${getNameFromRawPath(path)}</d:displayname>
            <d:getcontentlength>${contentlength}</d:getcontentlength>
            <d:getlastmodified>${lastmodified.toUTCString()}</d:getlastmodified>
            <d:resourcetype>${isdir ? "<d:collection/>" : ""}</d:resourcetype>${
    isdir
      ? "<d:getcontenttype>httpd/unix-directory</d:getcontenttype>"
      : "<d:getcontenttype>application/octet-stream</d:getcontenttype>"
  }
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
</d:response>`;
}

function displayVersion(): string {
  for (const k of ["deno", "bun", "node"]) {
    const v = process.versions[k];
    if (v) return `${k} v${v}`;
  }
  throw new Error("unreachable");
}

function convertToWebStream(body: Readable | Uint8Array<ArrayBufferLike>) {
  if (body instanceof Readable) {
    return Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>;
  } else {
    return body as unknown as Uint8Array<ArrayBuffer>;
  }
}
