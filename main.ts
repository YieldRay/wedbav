import { createServer } from "node:http";
import { abstractWebd } from "./webd";
import sqliteFs from "./fs";

function decodeURIComponentSafe(uri: string): string {
    try {
        return decodeURIComponent(uri);
    } catch {
        return uri;
    }
}

const server = createServer(async (req, res) => {
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
    } = await abstractWebd(sqliteFs, {
        pathname: decodeURIComponentSafe(url.pathname),
        headers: req.headers as Record<string, string>,
        method: req.method!,
        body,
    });
    res.writeHead(status, statusText, headers);
    res.end(responseBody);
    console.log(status, responseBody);
});

server.listen(8000, () => {
    console.log("Server running at http://localhost:8000/");
});
