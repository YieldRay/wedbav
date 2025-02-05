import { createServer } from "node:http";
import { abstractWebd } from "./webd";
import { FsSubset } from "./fs";

export function createNodeServer(fs: FsSubset) {
    return createServer(async (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        // convert node readable stream to ArrayBuffer
        const chunks: Uint8Array[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = new Uint8Array(Buffer.concat(chunks));
        const {
            status,
            statusText,
            headers,
            body: responseBody,
        } = await abstractWebd(fs, {
            pathname: decodeURISafe(url.pathname),
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
        const url = new URL(req.url);
        const {
            status,
            statusText,
            headers,
            body: responseBody,
        } = await abstractWebd(fs, {
            pathname: decodeURISafe(url.pathname),
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

function decodeURISafe(uri: string): string {
    try {
        return decodeURI(uri);
    } catch {
        return uri;
    }
}
