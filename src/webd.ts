import { Buffer } from "node:buffer";
import process from "node:process";
import { styleText } from "node:util";
import type { Readable } from "node:stream";
import { lookup } from "mrmime";
import { type FsSubset, ETAG, VFSError } from "./abstract.ts";
import { normalizePathLike, removeSuffixSlash } from "./utils.ts";
import { getPathnameFromURL } from "./http.ts";
import { parseBasicAuth } from "./auth.ts";
import { username, password } from "./auth.ts";
import { html, raw } from "./html.ts";
import path from "node:path/posix";

type Nullable<T> = T | null | undefined;

interface AbstractServer {
  request: {
    pathname: string;
    headers: Record<string, string>;
    method: string;
    body?: Nullable<Uint8Array>;
  };
  response: {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: Nullable<Uint8Array | string | Readable>;
  };
}

export interface WebdOptions {
  auth?: (username: string, password: string) => boolean;
  /** @default {"enabled"} */
  browser?: "list" | "enabled" | "disabled";
}

function getAuthDefault() {
  const user = username || "";
  const pass = password || "";
  if (pass) {
    return (un: string, pw: string) => {
      return un === user && pw === pass;
    };
  }
}

export async function abstractWebd(
  fsSubset: FsSubset,
  request: AbstractServer["request"],
  { auth = getAuthDefault(), browser = "enabled" }: WebdOptions = {}
): Promise<AbstractServer["response"]> {
  let fs = new Proxy(fsSubset, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return function (this: any, ...args: any[]) {
          console.log(`fs.${String(prop)}`, ...args);
          return value.apply(this, args);
        };
      }
      return value;
    },
  });

  const { pathname, headers, method, body } = request;
  console.log(`${styleText(["bold"], new Date().toLocaleString())} ${styleText(["blue"], method)} ${pathname}`);
  if (method === "OPTIONS") {
    return {
      status: 200,
      headers: {
        Allow: "PROPFIND, MOVE, DELETE, GET, PUT, MKCOL",
        DAV: "1",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "PROPFIND, MOVE, DELETE, GET, PUT, MKCOL",
      },
    };
  }

  if (browser !== "disabled" && headers["user-agent"]?.startsWith("Mozilla/")) {
    let filepath = pathname;
    if (pathname === "/") filepath = "/index.html";
    else if (pathname.endsWith("/")) filepath += "index.html";

    // browser can only be "enabled" or "list"
    let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      stat = await fs.stat(filepath);
    } catch (err) {
      if (err instanceof VFSError) {
        // when err is VFSError, it means the file or directory does not exist
      } else throw err;
    }

    if (!stat?.isFile()) {
      if (browser !== "list")
        // when browser is "enabled", we return 404 if the file does not exist
        return { status: 404, body: "Not Found" };

      // here browser is "list" and the file does not exist, we return an index of the directory
      const files = await fs.readdir(pathname, { withFileTypes: true });
      if (files.length === 0)
        return {
          status: 404,
          headers: { "Content-Type": "text/html; charset=UTF-8" },
          body: html`<html>
            <head>
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              <title>404 Not Found</title>
            </head>
            <body>
              <center><h1>404 Not Found</h1></center>
              <hr />
              <center>${displayVersion()}</center>
            </body>
          </html>`,
        };
      const dir = removeSuffixSlash(pathname);
      return {
        status: 200,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
        body: html`<html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Index of ${dir}</title>
          </head>
          <body>
            <h1>Index of ${dir}</h1>
            <ul>
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
        </html>`,
      };
    }

    if (Reflect.has(headers, "if-none-match")) {
      if (headers["if-none-match"] === (stat as any)[ETAG]) {
        return { status: 304 };
      }
    } else {
      const ifModifiedSince = headers["if-modified-since"];
      if (ifModifiedSince) {
        const ims = new Date(ifModifiedSince);
        if (ims >= stat.mtime) {
          return { status: 304 };
        }
      }
    }

    const { body } = await readBufferOrStream(fs, filepath);
    return {
      status: 200,
      headers: {
        etag: (stat as any)[ETAG],
        "last-modified": stat.mtime.toUTCString(),
        "content-length": stat.size.toString(),
        "content-type": lookup(filepath) || "application/octet-stream",
      },
      body,
    };
  }

  console.log("Auth:", auth ? "enabled" : "disabled");

  if (auth) {
    const basic = parseBasicAuth(headers["authorization"] || "");
    if (!basic || !auth(basic.username, basic.password)) {
      return {
        status: 401,
        headers: { "WWW-Authenticate": `Basic realm=""` },
      };
    }
  }

  switch (method) {
    case "PROPFIND": {
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
          // console.log(davXML(pathname, dav));
          return {
            status: 207,
            statusText: "Multi-Status",
            body: davXML(stat.mtime, pathname, dav),
            headers: { "Content-Type": "text/xml; charset=UTF-8" },
          };
        } else {
          // if pathname is a file, return its own info
          return {
            status: 207,
            statusText: "Multi-Status",
            body: davXML(stat.mtime, pathname, true),
            headers: { "Content-Type": "text/xml; charset=UTF-8" },
          };
        }
      } catch (e) {
        // if the file or directory does not exist, return 404
        if (e instanceof VFSError) {
          // if is root directory, return empty list
          if (pathname === "/") {
            return {
              status: 207,
              statusText: "Multi-Status",
              body: davXML(new Date(), pathname, []),
              headers: { "Content-Type": "text/xml; charset=UTF-8" },
            };
          }
          return { status: 404, body: "Not Found" };
        }
        console.error(e);
        return { status: 500, body: String(e) };
      }
    }
    case "MOVE": {
      if (!Reflect.has(headers, "destination")) {
        return { status: 400, body: "Bad Request: Destination header is required" };
      }

      const destination = getPathnameFromURL(headers["destination"]);
      const overwrite = headers["overwrite"] !== "F"; // Default is T (true)

      // Prevent self-move
      if (normalizePathLike(pathname) === normalizePathLike(destination)) {
        return { status: 403, body: "Forbidden: Cannot move resource to itself" };
      }

      // Prevent circular moves (moving parent into child)
      const normalizedSrc = normalizePathLike(pathname);
      const normalizedDest = normalizePathLike(destination);
      if (normalizedDest.startsWith(normalizedSrc + "/")) {
        return { status: 409, body: "Conflict: Cannot move directory into itself" };
      }

      try {
        // Check if source exists
        const srcStat = await fs.stat(pathname);

        // Check destination and handle overwrite logic
        let destStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
        let destExists = false;
        try {
          destStat = await fs.stat(destination);
          destExists = true;
        } catch (error) {
          if (!(error instanceof VFSError)) {
            // If it's not a "not found" error, it's a real error
            throw error;
          }
          // Destination doesn't exist, check if parent directory exists
          const parentDir = path.dirname(destination);
          try {
            const parentStat = await fs.stat(parentDir);
            if (!parentStat.isDirectory()) {
              return { status: 409, body: "Conflict: Parent is not a directory" };
            }
          } catch {
            return { status: 409, body: "Conflict: Parent directory does not exist" };
          }
        }

        // Handle overwrite header
        if (destExists && !overwrite) {
          return { status: 412, body: "Precondition Failed: Destination exists and Overwrite is F" };
        }

        let finalDestination = destination;
        let resourceCreated = !destExists;

        if (srcStat.isDirectory()) {
          // Moving a directory
          if (destExists && destStat!.isDirectory()) {
            // Moving into existing directory - move source into destination
            finalDestination = path.join(destination, path.basename(pathname));
            resourceCreated = true;

            // Check if final destination exists
            try {
              await fs.stat(finalDestination);
              if (!overwrite) {
                return { status: 412, body: "Precondition Failed: Final destination exists and Overwrite is F" };
              }
              resourceCreated = false;
            } catch {}
          }

          if (!resourceCreated) {
            // Remove destination if it exists and we're overwriting
            try {
              await fs.rm(finalDestination, { recursive: true, force: true });
            } catch {}
          }

          await moveDir(fs, pathname, finalDestination);
        } else {
          // Moving a file
          if (destExists && destStat!.isDirectory()) {
            // Moving file into directory
            finalDestination = path.join(destination, path.basename(pathname));
            resourceCreated = true;

            // Check if final destination exists
            try {
              await fs.stat(finalDestination);
              if (!overwrite) {
                return { status: 412, body: "Precondition Failed: Final destination exists and Overwrite is F" };
              }
              resourceCreated = false;
            } catch {}
          }

          if (!resourceCreated) {
            // Remove destination if it exists and we're overwriting
            try {
              await fs.rm(finalDestination, { recursive: true, force: true });
            } catch {}
          }

          await fs.rename(pathname, finalDestination);
        }

        // Return appropriate status code
        return { status: resourceCreated ? 201 : 204 };
      } catch (e) {
        console.error("MOVE error:", e);
        if (e instanceof VFSError) {
          return { status: 404, body: "Not Found: Source resource does not exist" };
        }
        console.error(e);
        return { status: 500, body: String(e) };
      }
    }
    case "DELETE": {
      await fs.rm(pathname, { recursive: true, force: true });
      return { status: 204 };
    }
    case "GET": {
      try {
        const name = pathname.split("/").pop()!;
        const { body, stat } = await readBufferOrStream(fs, pathname);
        return {
          status: 200,
          body,
          headers: {
            "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
            "Content-Length": stat.size.toString(),
            "Content-Type": "application/octet-stream",
          },
        };
      } catch {
        return { status: 204 };
      }
    }
    case "PUT": {
      try {
        await fs.writeFile(pathname, body ? (Buffer.from(body) as unknown as Uint8Array) : new Uint8Array(0));
        return { status: 201 };
      } catch (e) {
        console.error(e);
        return { status: 500, body: String(e) };
      }
    }
    case "PROPATCH": {
      return {
        status: 405,
        headers: { Allow: "PROPFIND, MOVE, DELETE, GET, PUT, MKCOL" },
        body: "PROPATCH is not implemented",
      };
    }
    case "MKCOL": {
      await fs.mkdir(pathname, { recursive: true });
      return { status: 201, statusText: "Created" };
    }
  }

  return {
    status: 405,
    headers: { Allow: "PROPFIND, MOVE, DELETE, GET, PUT, MKCOL" },
    body: "Method Not Allowed",
  };
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

async function moveDir(fs: FsSubset, src: string, dest: string) {
  const srcBase = removeSuffixSlash(normalizePathLike(src));
  const destBase = removeSuffixSlash(normalizePathLike(dest));

  // Try atomic rename first (most efficient)
  try {
    await fs.rename(srcBase, destBase);
    return;
  } catch (error) {
    // If atomic rename fails, fall back to recursive move
    // This happens when moving across different filesystems or when destination exists
  }

  // Check if destination exists
  let destStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
  try {
    destStat = await fs.stat(destBase);
  } catch {}

  if (!destStat) {
    // Destination doesn't exist, but atomic rename failed
    // This could be cross-filesystem move - do recursive copy+delete
    await recursiveMoveDir(fs, srcBase, destBase);
    return;
  }

  if (!destStat.isDirectory()) {
    // Destination exists but is not a directory - this should have been handled by caller
    throw new Error("Destination exists and is not a directory");
  }

  // Destination is an existing directory - move contents into it
  await recursiveMoveDir(fs, srcBase, destBase, true);
}

async function recursiveMoveDir(fs: FsSubset, src: string, dest: string, mergeIntoExisting = false) {
  const entries = await fs.readdir(src, { withFileTypes: true });

  if (!mergeIntoExisting) {
    // Create destination directory
    await fs.mkdir(dest, { recursive: true });
  }

  // Process all entries
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // Try atomic rename for subdirectory first
      try {
        await fs.rename(srcPath, destPath);
      } catch {
        // Fall back to recursive move
        await recursiveMoveDir(fs, srcPath, destPath);
        // Clean up source directory after successful move
        try {
          await fs.rmdir(srcPath);
        } catch {
          // Use recursive remove as fallback
          await fs.rm(srcPath, { recursive: true, force: true });
        }
      }
    } else {
      // Move file - remove destination if it exists, then rename
      try {
        await fs.rm(destPath, { force: true });
      } catch {}

      try {
        await fs.rename(srcPath, destPath);
      } catch {
        // If rename fails, try copy+delete (cross-filesystem move)
        const buffer = await fs.readFile(srcPath);
        await fs.writeFile(destPath, buffer);
        await fs.rm(srcPath, { force: true });
      }
    }
  }

  // Remove source directory after moving all contents
  try {
    await fs.rmdir(src);
  } catch {
    // Use recursive remove as fallback
    await fs.rm(src, { recursive: true, force: true });
  }
}

function displayVersion() {
  for (const k of ["deno", "bun", "node"]) {
    const v = process.versions[k];
    if (v) return `${k} v${v}`;
  }
  throw new Error("unreachable");
}
