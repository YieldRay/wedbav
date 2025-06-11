import type http from "node:http";
import { Buffer } from "node:buffer";
import { abstractWebd, type WebdOptions } from "./webd.ts";
import { type FsSubset } from "./abstract.ts";
import { Readable } from "node:stream";

/** NodeJS http server middleware type */
type NodeHandler = http.RequestListener<typeof http.IncomingMessage, typeof http.ServerResponse>;

export function createNodeHandler(fs: FsSubset, options?: WebdOptions): NodeHandler {
  return async (req, res) => {
    // convert node readable stream to Uint8Array
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks) as unknown as Uint8Array;

    const {
      status,
      statusText,
      headers,
      body: responseBody,
    } = await abstractWebd(
      fs,
      {
        pathname: decodeURISafe(req.url!),
        headers: req.headers as Record<string, string>,
        method: req.method!,
        body,
      },
      options
    );

    res.writeHead(status, statusText, headers);
    if (responseBody instanceof Readable) {
      responseBody.pipe(res);
    } else {
      res.end(responseBody);
    }
  };
}

export function createFetchHandler(fs: FsSubset, options?: WebdOptions) {
  return async (req: Request) => {
    const {
      status,
      statusText,
      headers,
      body: responseBody,
    } = await abstractWebd(
      fs,
      {
        pathname: getPathnameFromURL(req.url),
        headers: Object.fromEntries(req.headers),
        method: req.method,
        body: await req.bytes(),
      },
      options
    );

    return new Response((responseBody instanceof Readable ? Readable.toWeb(responseBody) : responseBody) as BodyInit, {
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
