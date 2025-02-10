import { Buffer } from "node:buffer";
import process from "node:process";
import { lookup } from "mrmime";
import { parseBasicAuth } from "./auth.ts";
import { type FsSubset, ETAG, normalizePathLike, removeSuffixSlash } from "./fs.ts";
import { getPathnameFromURL } from "./http.ts";
import { html } from "./html.ts";

type Nullable<T> = T | null | undefined;

interface AbstractServer {
    request: {
        pathname: string;
        headers: Record<string, string>;
        method: string;
        body?: Nullable<ArrayBuffer>;
    };
    response: {
        status: number;
        statusText?: string;
        headers?: Record<string, string>;
        body?: Nullable<ArrayBuffer | string>;
    };
}

export interface WebdOptions {
    auth?: (username: string, password: string) => boolean;
    /** @default {"enabled"} */
    browser?: "list" | "enabled" | "disabled";
}

function getAuthDefault() {
    const username = process.env["WEBD_USERNAME"];
    const password = process.env["WEBD_PASSWORD"];
    if (username && password) {
        return (un: string, pw: string) => un === username && pw === password;
    }
}

export async function abstractWebd(
    fs: FsSubset,
    request: AbstractServer["request"],
    { auth = getAuthDefault(), browser = "enabled" }: WebdOptions = {}
): Promise<AbstractServer["response"]> {
    const { pathname, headers, method, body } = request;
    console.log(`${new Date().toLocaleString()} ${method} ${pathname}`);
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
        const p = pathname.endsWith("/") ? `${pathname}/index.html` : pathname;
        const stat = await fs.stat(p);
        if (!stat.isFile()) {
            if (browser !== "list") return { status: 404, body: "Not Found" };
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
                body: html`<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Index of ${dir}</title></head>
                <body><h1>Index of ${dir}</h1>
                    <ul>
                    ${files
                        .filter((file) => file.isDirectory())
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((file) => `<li><a href="./${file.name}/">${file.name}/</a></li>`)
                        .join("\n")}
                    </ul>
                    ${files
                        .filter((file) => file.isFile())
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((file) => `<li><a href="./${file.name}">${file.name}</a></li>`)
                        .join("\n")}
                    </ul>
                    </body></html>`,
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

        const content = (await fs.readFile(p)) as unknown as Uint8Array;
        return {
            status: 200,
            headers: {
                etag: (stat as any)[ETAG],
                "last-modified": stat.mtime.toUTCString(),
                "content-length": content.length.toString(),
                "content-type": lookup(p) || "application/octet-stream",
            },
            body: content,
        };
    }

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
                        const path = normalizePathLike(pathname) + "/" + file.name;
                        const stat = await fs.stat(path);
                        dav.push({
                            path,
                            lastmodified: stat.mtime,
                            contentlength: stat.size,
                            isdir: file.isDirectory(),
                        });
                    }
                    return {
                        status: 207,
                        statusText: "Multi-Status",
                        body: davXML(pathname, dav),
                        headers: { "Content-Type": "text/xml; charset=UTF-8" },
                    };
                } else {
                    return {
                        status: 207,
                        statusText: "Multi-Status",
                        body: davXML(pathname),
                        headers: { "Content-Type": "text/xml; charset=UTF-8" },
                    };
                }
            } catch (e) {
                return { status: 404, body: String(e) };
            }
        }
        case "MOVE": {
            if (!Reflect.has(headers, "destination")) {
                return { status: 400, body: "Destination header is not provided" };
            }
            const destination = getPathnameFromURL(headers["destination"]);
            try {
                await fs.rename(pathname, destination);
                return { status: 200 };
            } catch (e) {
                return { status: 404, body: String(e) };
            }
        }
        case "DELETE": {
            await fs.rm(pathname, { recursive: true, force: true });
            return { status: 204 };
        }
        case "GET": {
            try {
                const name = pathname.split("/").pop()!;
                const data = (await fs.readFile(pathname)) as unknown as Uint8Array;
                return {
                    status: 200,
                    body: data,
                    headers: {
                        "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
                    },
                };
            } catch {
                return { status: 204 };
            }
        }
        case "PUT": {
            try {
                await fs.writeFile(
                    pathname,
                    body ? (Buffer.from(body) as unknown as Uint8Array) : new Uint8Array(0)
                );
                return { status: 201 };
            } catch (e) {
                return { status: 404, body: String(e) };
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
            await fs.writeFile(pathname + ".DIR_STRUT_FILE", new Uint8Array(0));
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

function davXML(
    dir: string,
    files: Array<{ path: string; contentlength: number; lastmodified: Date; isdir: boolean }> = []
) {
    return /* xml */ `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<d:multistatus xmlns:d="DAV:">
<d:response>
    <d:href>${encodeURI(dir)}</d:href>
    <d:propstat>
        <d:prop>
            <d:getcontenttype>httpd/unix-directory</d:getcontenttype>
            <d:displayname>${getNameFromRawPath(dir)}</d:displayname>
            <d:resourcetype>
                <d:collection/>
            </d:resourcetype>
            <d:getcontentlength>0</d:getcontentlength>
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
</d:response>
${files
    .map(
        ({ path, contentlength, lastmodified, isdir }) => /*xml*/ `
<d:response>
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
</d:response>`
    )
    .join("\n")}    
</d:multistatus>`;
}

function displayVersion() {
    for (const k of ["deno", "bun", "node"]) {
        const v = process.versions[k];
        if (v) return `${k} v${v}`;
    }
    throw new Error("unreachable");
}
