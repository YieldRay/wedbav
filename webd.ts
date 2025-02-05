import { parseBasicAuth } from "./auth";
import { ETAG, FsSubset, removeSuffixSlash } from "./fs";

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

export async function abstractWebd(
    fs: FsSubset,
    request: AbstractServer["request"],
    auth?: (username: string, password: string) => boolean
): Promise<AbstractServer["response"]> {
    const { pathname, headers, method, body } = request;
    console.log(`${new Date().toLocaleString()} ${method} ${pathname}`);
    if (method === "OPTIONS") {
        return {
            status: 200,
            headers: {
                Allow: "PROPFIND, MOVE, DELETE, GET, PUT",
                DAV: "1",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "PROPFIND, MOVE, DELETE, GET, PUT",
            },
        };
    }
    if (headers["user-agent"]?.startsWith("Mozilla/")) {
        const stat = await fs.stat(pathname);
        if (!stat.isFile()) {
            return { status: 404, body: "Not Found" };
        }
        const content = await fs.readFile(pathname);
        return {
            status: 200,
            headers: {
                etag: stat[ETAG],
                "last-modified": stat.mtime.toUTCString(),
                "content-length": content.byteLength.toString(),
                "content-type": "application/octet-stream",
            },
            body: content,
        };
    }

    if (auth) {
        const basic = parseBasicAuth(headers["authorization"] || "");
        if (!basic || !auth(basic.username, basic.password)) {
            return {
                status: 401,
                headers: {
                    "WWW-Authenticate": `Basic realm=""`,
                },
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
                        const path = file.parentPath + "/" + file.name;
                        const stat = await fs.stat(path);
                        dav.push({
                            path,
                            lastmodified: stat.mtime,
                            contentlength: stat.size,
                            isdir: stat.isDirectory(),
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
                return { status: 404, body: e.message };
            }
        }
        case "MOVE": {
            const destination = headers["destination"];
            if (!destination) {
                return { status: 400, body: "Destination header is not provided" };
            }
            try {
                await fs.rename(pathname, destination);
                return { status: 200 };
            } catch (e) {
                return { status: 404, body: e.message };
            }
        }
        case "DELETE": {
            try {
                await fs.rm(pathname);
                return { status: 204 };
            } catch (e) {
                return { status: 404, body: e.message };
            }
        }
        case "GET": {
            try {
                const name = pathname.split("/").pop()!;
                const data = await fs.readFile(pathname);
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
                await fs.writeFile(pathname, body ? Buffer.from(body) : Buffer.alloc(0));
                return { status: 201 };
            } catch (e) {
                return { status: 404, body: e.message };
            }
        }
        case "MKCOL": {
            // TODO: fix me
            await fs.writeFile(pathname + ".IS_DIR", Buffer.alloc(0));
            return { status: 201 };
        }
    }

    return {
        status: 405,
        headers: { Allow: "PROPFIND, PUT, GET" },
        body: "Method Not Allowed",
    };
}

function davXML(
    dir: string,
    files: Array<{ path: string; contentlength: number; lastmodified: Date; isdir: boolean }> = []
) {
    return /* xml */ `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<d:multistatus xmlns:d="DAV:">
<d:response>
    <d:href>${dir}</d:href>
    <d:propstat>
        <d:prop>
            <d:getcontenttype>httpd/unix-directory</d:getcontenttype>
            <d:displayname>${removeSuffixSlash(dir).split("/").pop() || "/"}</d:displayname>
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
    <d:href>${path + (isdir ? "/" : "")}</d:href>
    <d:propstat>
        <d:prop>
            <d:displayname>${path.split("/").pop()!}</d:displayname>
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
    // .split("\n")
    // .map((r) => r.trim())
    // .join("");
}
