import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { abstractWebd } from "./webd.ts";
import { FsSubset } from "./fs.ts";

export function createNodeServer(fs: FsSubset) {
    return createServer(async (req, res) => {
        // convert node readable stream to Uint8Array
        const chunks: Uint8Array[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks) as unknown as Uint8Array;

        const {
            status,
            statusText,
            headers,
            body: responseBody,
        } = await abstractWebd(fs, {
            pathname: decodeURISafe(req.url!),
            headers: req.headers as Record<string, string>,
            method: req.method!,
            body,
        });
        res.writeHead(status, statusText, headers);
        res.end(responseBody);
    });
}

export function createServeHandler(fs: FsSubset) {
    return async (req: Request) => {
        const {
            status,
            statusText,
            headers,
            body: responseBody,
        } = await abstractWebd(fs, {
            pathname: getPathnameFromURL(req.url),
            headers: Object.fromEntries(req.headers),
            method: req.method,
            body: await req.arrayBuffer(),
        });
        return new Response(responseBody, {
            status,
            statusText,
            headers: new Headers(headers),
        });
    };
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
