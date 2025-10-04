import { Buffer } from "node:buffer";
import process from "node:process";
import { Readable } from "node:stream";
import { lookup } from "mrmime";
import { type FsSubset, type VStats, ETAG } from "./abstract.ts";
import { isErrnoException, normalizePathLike, removeSuffixSlash } from "./utils.ts";
import { handleCopyMoveRequest } from "./copy_move.ts";
import { getPathnameFromURL } from "./utils.ts";
import { createHonoAPI } from "./api.ts";
import type { Bindings } from "./env.ts";
import { Hono, type Context } from "hono";
import { html, raw } from "hono/html";
import { basicAuth } from "hono/basic-auth";
import { logger } from "hono/logger";
import { showRoutes } from "hono/dev";
import { cors } from "hono/cors";
import { generateSpecs, type GenerateSpecOptions } from "hono-openapi";

export interface WedbavOptions {
  auth?: (username: string, password: string) => boolean;
  /** @default {"disabled"} */
  browser?: "list" | "enabled" | "disabled";
}

type Variables = {
  fs: FsSubset;
  options: WedbavOptions;
  url: URL;
  pathname: string;
};

export type WedbavContext = { Variables: Variables; Bindings: Bindings };

export function createHono(fs: FsSubset, options: WedbavOptions) {
  const app = new Hono<WedbavContext>();

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

  const VERSION = 1;

  // the api openapi router, without auth
  const api = createHonoAPI(fs, {
    prefix: `/api/v${VERSION}` as const,
    readOnly: false,
  });

  const createAPIMetadata = (serverUrl: string): Partial<GenerateSpecOptions> => ({
    documentation: {
      info: {
        title: "wedbav API Reference",
        version: `${VERSION}.0.0` as const,
      },
      components: {
        securitySchemes: {
          basicAuth: {
            type: "http",
            scheme: "basic",
          },
        },
      },
      security: [
        {
          basicAuth: [],
        },
      ],
      servers: [
        {
          url: serverUrl,
          description: "Current server",
        },
      ],
    },
  });

  app.get("/openapi.json", async (c, next) => {
    if (!c.req.header("accept")?.startsWith("application/json")) return next();

    const spec = await generateSpecs(api, createAPIMetadata(c.var.url.origin));
    return c.json(spec);
  });

  app.get("/openapi", async (c, next) => {
    const requestHTML =
      c.req.header("accept")?.startsWith("text/html") || c.req.header("user-agent")?.startsWith("Mozilla/");

    if (!requestHTML) return next();

    const spec = await generateSpecs(api, createAPIMetadata(c.var.url.origin));
    return c.html(/*html*/ `<!doctype html>
<html>
  <head>
    <title>API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        content: \`${JSON.stringify(spec)}\`
      })
    </script>
  </body>
</html>`);
  });

  // browser feature, this part do not require auth
  app.get("/*", async (c, next) => {
    const { browser = "disabled" } = options;
    // if browser is disabled, or the request is not from a browser, skip

    const requestHTML =
      c.req.header("accept")?.startsWith("text/html") || c.req.header("user-agent")?.startsWith("Mozilla/");

    if (browser === "disabled" || !requestHTML) {
      return next();
    }
    // now, browser is either "list" or "enabled", and the request is from a browser
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
      const files = await fs.readdir(pathname, { withFileTypes: true }).catch((e) => {
        if (isErrnoException(e)) return false as const;
        throw e;
      });

      if (!files) {
        return c.text("Not Found", 404);
      }

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
      const { body } = await readBufferOrStream(fs, filepath);
      return c.body(convertToWebStream(body), 200, {
        "last-modified": stat.mtime.toUTCString(),
        "content-length": stat.size.toString(),
        "content-type": lookup(filepath) || "application/octet-stream",
      });
    } catch (e) {
      if (isErrnoException(e)) {
        return c.text("Not Found", 404);
      }
      throw e;
    }
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
          if (!c.env.WEDBAV_USERNAME) {
            return password === c.env.WEDBAV_PASSWORD;
          }
          return username === c.env.WEDBAV_USERNAME && password === c.env.WEDBAV_PASSWORD;
        },
      })
    );
  }

  // api routes
  app.route("/", api);

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
    return c.body(null, 204);
  });

  app.get("/*", async (c) => {
    const { pathname } = c.var;

    const name = pathname.split("/").pop()!;

    try {
      const { body, stat } = await readBufferOrStream(fs, pathname);
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
