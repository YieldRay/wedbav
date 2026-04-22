import { createHash } from "node:crypto";
import type { PathLike, Stats } from "node:fs";
import path from "node:path/posix";
import { Readable } from "node:stream";
import type { FsSubset } from "./abstract.ts";

export async function createEtag(content: Uint8Array) {
  // async for future use
  const hash = createHash("sha256");
  hash.update(content);
  const etag = `"${hash.digest("hex")}"`;
  return etag;
}

export function removeSuffixSlash(input: string) {
  while (input.endsWith("/")) {
    input = input.replace(/\/$/, "");
  }
  return input;
}

export function normalizePathLike(pathLike: PathLike): string {
  const pathStr = String(pathLike);
  return path.normalize(pathStr);
}

// special character \%_ that need to be escaped in SQL LIKE queries
// biome-ignore lint/complexity/useRegexLiterals: String.raw here improves readability
const sqlWildcardChars = new RegExp(String.raw`[\%_]`, "g");

/** Escape % and _ for usage in SQL LIKE expressions. */
export function encodePathForSQL(key: string) {
  // append '\\' before each wildcard character
  return key.replace(sqlWildcardChars, String.raw`\\$&`);
}

export function getPathnameFromURL(url: string | URL) {
  return decodeURISafe(new URL(url).pathname);
}

export function decodeURISafe(uri: string): string {
  // Decode each segment individually so %2F within a segment doesn't collapse path separators
  return uri
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}

/** Percent-encode each path segment (preserving `/` separators) for use in URLs and WebDAV hrefs. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && "syscall" in error && "path" in error;
}

export function mapErrnoToStatus(error: NodeJS.ErrnoException) {
  switch (error.code) {
    case "EACCES":
    case "EPERM":
      return 403;
    case "ENOENT":
      return 404;
    case "EEXIST":
      return 400;
    case "ENOTDIR":
    case "EISDIR":
    case "ENOTEMPTY":
      return 409;
    case "EINVAL":
      return 400;
    case "ENOSPC":
    case "EFBIG":
      return 507;
    default:
      return 500;
  }
}

const THRESHOLD = 1024 * 1024; // 1MB
export async function readBufferOrStream(fs: FsSubset, pathname: string, stat?: Stats) {
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

export function convertToWebStream(body: Readable | Uint8Array<ArrayBufferLike>) {
  if (body instanceof Readable) {
    return Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>;
  } else {
    return body as unknown as Uint8Array<ArrayBuffer>;
  }
}
