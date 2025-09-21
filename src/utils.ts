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
