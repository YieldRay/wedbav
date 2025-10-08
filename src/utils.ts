import path from "node:path/posix";
import { createHash } from "node:crypto";
import type { PathLike } from "node:fs";

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
  let pathStr = String(pathLike);
  return path.normalize(pathStr);
}

// special character \%_ that need to be escaped in SQL LIKE queries
const sqlWildcardChars = new RegExp(String.raw`[\%_]`, "g");

/** Escape % and _ for usage in SQL LIKE expressions. */
export function encodePathForSQL(key: string) {
  // append '\\' before each wildcard character
  return key.replace(sqlWildcardChars, String.raw`\\$&`);
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && "syscall" in error && "path" in error;
}

export function getPathnameFromURL(url: string | URL) {
  return decodeURISafe(new URL(url).pathname);
}

export function decodeURISafe(uri: string): string {
  try {
    return decodeURI(uri);
  } catch {
    return uri;
  }
}

export function escapeXML(str: string) {
  const map: Record<string, string> = {
    ">": "&gt;",
    "<": "&lt;",
    "'": "&apos;",
    '"': "&quot;",
    "&": "&amp;",
  };
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    result += map[ch] || ch;
  }
  return result;
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
