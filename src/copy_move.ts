import { STATUS_CODES } from "node:http";
import path from "node:path/posix";
import type { Context } from "hono";
import type { FsSubset } from "./abstract.ts";
import { encodePath, getPathnameFromURL, isErrnoException, mapErrnoToStatus, removeSuffixSlash } from "./utils.ts";
import type { WedbavContext } from "./wedbav.ts";
import { escapeXML } from "./xml.ts";

export type WebdavContext = Context<WedbavContext>;

export type CopyErrorStatus = 400 | 403 | 404 | 409 | 412 | 500 | 507;

export type CopyError = {
  href: string;
  status: CopyErrorStatus;
  description?: string;
};

type SourceStat = Awaited<ReturnType<FsSubset["stat"]>>;

type CopyOperationParams = {
  fs: FsSubset;
  sourcePath: string;
  destinationPath: string;
  depth: number;
  overwrite: boolean;
  providedSourceStat?: SourceStat;
  type: "COPY" | "MOVE";
};

type CopyOperationSuccess = {
  ok: true;
  destinationExisted: boolean;
  errors: CopyError[];
};

type CopyOperationFailure = {
  ok: false;
  status: CopyErrorStatus;
  message: string;
};

export type CopyOperationResult = CopyOperationSuccess | CopyOperationFailure;

type DirentLike = {
  name: string;
  isDirectory(): boolean;
};

/** Sentinel used to short-circuit out of the operation with a failure result. */
class OperationError extends Error {
  status: CopyErrorStatus;
  constructor(status: CopyErrorStatus, message: string) {
    super(message);
    this.name = "OperationError";
    this.status = status;
  }
}

/**
 * Re-throw unknown (non-errno) errors, otherwise convert an errno error into an
 * {@link OperationError} with the given status. Passing no status maps the errno
 * to an HTTP status automatically.
 */
function fail(err: unknown, status?: CopyErrorStatus, message?: string): never {
  if (!isErrnoException(err)) throw err;
  throw new OperationError(status ?? (mapErrnoToStatus(err) as CopyErrorStatus), message ?? err.message);
}

// ─── HTTP layer ──────────────────────────────────────────────────────────────

/** Resolve and validate the `Destination` header against the request URL. */
export function parseDestination(
  dest: string | undefined,
  requestURL: URL,
): { status: number; message: string } | string {
  if (!dest) {
    return { status: 400, message: "Bad Request: Destination header is required" };
  }
  const destURL = new URL(dest, requestURL);
  if (requestURL.origin !== destURL.origin) {
    return { status: 502, message: "Bad Gateway: Destination must be on the same origin" };
  }
  return getPathnameFromURL(destURL);
}

/** WebDAV `Depth` semantics for COPY. Defaults to Infinity when absent. */
export function resolveCopyDepth(depthHeader: string | undefined): number {
  return depthHeader === "0" ? 0 : Infinity;
}

export async function handleCopyMoveRequest(c: WebdavContext, type: "COPY" | "MOVE") {
  const { fs, pathname, url } = c.var;
  const overwriteHeader = c.req.header("Overwrite");
  const overwrite = overwriteHeader ? overwriteHeader.toUpperCase() !== "F" : true;

  const destination = parseDestination(c.req.header("Destination"), url);
  if (typeof destination !== "string") {
    return c.text(destination.message, destination.status as 400 | 502);
  }

  let sourceStat: SourceStat;
  try {
    sourceStat = await fs.stat(pathname);
  } catch (err) {
    if (isErrnoException(err)) return c.text("Not Found", 404);
    throw err;
  }

  const depthHeader = c.req.header("Depth");
  let depth = Infinity;
  if (type === "COPY") {
    depth = resolveCopyDepth(depthHeader);
  } else {
    // MOVE always acts on the whole subtree; validate the request first.
    if (normalizeDavPath(pathname) === "/") {
      return c.text("Forbidden: cannot move root collection", 403);
    }
    if (sourceStat.isDirectory() && depthHeader && depthHeader.toLowerCase() !== "infinity") {
      return c.text("Bad Request: Depth for MOVE on a collection must be 'infinity' or not present", 400);
    }
  }

  const result = await copyLikeOperation({
    fs,
    sourcePath: pathname,
    destinationPath: destination,
    depth,
    overwrite,
    providedSourceStat: sourceStat,
    type,
  });

  if (!result.ok) {
    return c.text(result.message, result.status);
  }

  if (result.errors.length) {
    // Propagate per-resource failures via multistatus so the client can react.
    return c.body(multiStatusXML(result.errors), 207, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  if (result.destinationExisted) {
    return c.body(null, 204);
  }
  return c.body("Created", 201, { Location: encodePath(destination) });
}

// ─── Core operation ────────────────────────────────────────────────────────

export async function copyLikeOperation(params: CopyOperationParams): Promise<CopyOperationResult> {
  try {
    return await runCopyLikeOperation(params);
  } catch (err) {
    if (err instanceof OperationError) {
      return { ok: false, status: err.status, message: err.message };
    }
    throw err;
  }
}

async function runCopyLikeOperation({
  fs,
  sourcePath,
  destinationPath,
  depth,
  overwrite,
  providedSourceStat,
  type,
}: CopyOperationParams): Promise<CopyOperationResult> {
  const sourceStat = providedSourceStat ?? (await statOrFail(fs, sourcePath));
  const sourceIsDirectory = sourceStat.isDirectory();

  const source = normalizeDavPath(sourcePath);
  const destination = normalizeDavPath(destinationPath);

  assertValidTargets(source, destination, sourceIsDirectory);
  await assertParentIsCollection(fs, destination);

  const destinationExisted = await clearDestinationIfNeeded(fs, destination, overwrite);

  const errors: CopyError[] = [];

  if (type === "MOVE") {
    const renameSource = sourceIsDirectory ? withTrailingSlash(source) : source;
    const renameDestination = sourceIsDirectory ? withTrailingSlash(destination) : destination;
    try {
      await fs.rename(renameSource, renameDestination);
    } catch (err) {
      fail(err);
    }
  } else if (sourceIsDirectory) {
    await copyDirectoryRecursive(fs, source, destination, depth, errors);
  } else {
    try {
      await fs.copyFile(source, destination);
    } catch (err) {
      fail(err);
    }
  }

  return { ok: true, destinationExisted, errors };
}

async function statOrFail(fs: FsSubset, pathname: string): Promise<SourceStat> {
  try {
    return await fs.stat(pathname);
  } catch (err) {
    fail(err, 404, "Not Found");
  }
}

/** Reject same-resource, self-nesting, and root-destination requests. */
function assertValidTargets(source: string, destination: string, sourceIsDirectory: boolean): void {
  if (source === destination) {
    throw new OperationError(403, "Forbidden: source and destination are the same resource");
  }
  if (sourceIsDirectory && source !== "/" && destination.startsWith(withTrailingSlash(source))) {
    throw new OperationError(403, "Forbidden: cannot copy a collection inside itself");
  }
  if (destination === "/") {
    throw new OperationError(403, "Forbidden: cannot overwrite root collection");
  }
}

/** Ensure the destination's parent exists and is a collection. */
async function assertParentIsCollection(fs: FsSubset, destination: string): Promise<void> {
  const parentPath = getParentDavPath(destination);
  if (!parentPath || parentPath === "/") return;

  let parentStat: SourceStat;
  try {
    parentStat = await fs.stat(withTrailingSlash(parentPath));
  } catch (err) {
    fail(err, 409, "Conflict: destination parent does not exist");
  }
  if (!parentStat.isDirectory()) {
    throw new OperationError(409, "Conflict: destination parent is not a collection");
  }
}

/**
 * Returns whether the destination already existed. When it did and overwrite is
 * allowed, the destination is removed so the copy/move can proceed cleanly.
 */
async function clearDestinationIfNeeded(fs: FsSubset, destination: string, overwrite: boolean): Promise<boolean> {
  const existed = await exists(fs, destination);
  if (!existed) return false;

  if (!overwrite) {
    throw new OperationError(412, "Precondition Failed: destination exists and overwrite is not allowed");
  }
  try {
    await fs.rm(destination, { recursive: true, force: true });
  } catch (err) {
    fail(err, undefined, "Failed to remove destination before copy");
  }
  return true;
}

async function exists(fs: FsSubset, pathname: string): Promise<boolean> {
  try {
    await fs.stat(pathname);
    return true;
  } catch (err) {
    if (isErrnoException(err)) return false;
    throw err;
  }
}

async function copyDirectoryRecursive(
  fs: FsSubset,
  source: string,
  destination: string,
  depth: number,
  errors: CopyError[],
): Promise<void> {
  const sourceDir = withTrailingSlash(source);
  const destinationDir = withTrailingSlash(destination);

  try {
    await fs.mkdir(destinationDir, { recursive: false });
  } catch (err) {
    // The destination was cleared beforehand, so any error here fails this subtree.
    return pushError(errors, destinationDir, err);
  }

  if (depth === 0) return;
  const nextDepth = depth === Infinity ? Infinity : Math.max(depth - 1, 0);

  let entries: DirentLike[];
  try {
    entries = (await fs.readdir(sourceDir, { withFileTypes: true })) as unknown as DirentLike[];
  } catch (err) {
    return pushError(errors, destinationDir, err);
  }

  for (const entry of entries) {
    const isDir = entry.isDirectory();
    const childSource = joinDavPath(sourceDir, entry.name, isDir);
    const childDestination = joinDavPath(destinationDir, entry.name, isDir);

    if (isDir) {
      await copyDirectoryRecursive(fs, childSource, childDestination, nextDepth, errors);
    } else {
      try {
        await fs.copyFile(childSource, childDestination);
      } catch (err) {
        pushError(errors, childDestination, err);
      }
    }
  }
}

/** Record a per-resource errno failure; re-throw anything that isn't an errno error. */
function pushError(errors: CopyError[], href: string, err: unknown): void {
  if (!isErrnoException(err)) throw err;
  errors.push({ href, status: mapErrnoToStatus(err) as CopyErrorStatus, description: err.message });
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function joinDavPath(parentDir: string, childName: string, isDir: boolean): string {
  const base = parentDir === "/" ? "/" : removeSuffixSlash(parentDir);
  let combined = path.join(base, childName);
  if (!combined.startsWith("/")) combined = `/${combined}`;
  return isDir ? withTrailingSlash(combined) : normalizeDavPath(combined);
}

function getParentDavPath(pathname: string): string | null {
  const normalized = normalizeDavPath(pathname);
  if (normalized === "/") return null;
  const parent = path.dirname(normalized);
  return parent === normalized ? null : parent;
}

export function normalizeDavPath(pathname: string): string {
  if (!pathname) return "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  if (pathname !== "/") pathname = removeSuffixSlash(path.normalize(pathname));
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  return pathname === "" ? "/" : pathname;
}

export function withTrailingSlash(pathname: string): string {
  if (pathname === "/") return "/";
  return `${removeSuffixSlash(pathname)}/`;
}

// ─── XML ─────────────────────────────────────────────────────────────────────

export function multiStatusXML(errors: CopyError[]): string {
  const responses = errors
    .map(({ href, status, description }) => {
      const reason = STATUS_CODES[status] ?? "";
      const desc = description
        ? /* xml */ `\n    <d:responsedescription>${escapeXML(description)}</d:responsedescription>`
        : "";
      return /* xml */ `<d:response>
    <d:href>${encodePath(href)}</d:href>
    <d:status>HTTP/1.1 ${status} ${reason}</d:status>${desc}
</d:response>`;
    })
    .join("\n");

  return /* xml */ `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
  ${responses}
</d:multistatus>`;
}
