import { STATUS_CODES } from "node:http";
import path from "node:path/posix";
import { type FsSubset } from "./abstract.ts";
import { isErrnoException, removeSuffixSlash } from "./utils.ts";

export type CopyErrorStatus = 400 | 403 | 404 | 409 | 412 | 500 | 507;

export type CopyError = {
  href: string;
  status: CopyErrorStatus;
  description?: string;
};

type CopyOperationParams = {
  fs: FsSubset;
  sourcePath: string;
  destinationPath: string;
  depth: number;
  overwrite: boolean;
  providedSourceStat?: Awaited<ReturnType<FsSubset["stat"]>>;
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

export async function copyLikeOperation({
  fs,
  sourcePath,
  destinationPath,
  depth,
  overwrite,
  providedSourceStat,
}: CopyOperationParams): Promise<CopyOperationResult> {
  let sourceStat = providedSourceStat;
  if (!sourceStat) {
    try {
      sourceStat = await fs.stat(sourcePath);
    } catch (err) {
      if (isErrnoException(err)) {
        return { ok: false, status: 404, message: "Not Found" };
      }
      throw err;
    }
  }
  if (!sourceStat) {
    return { ok: false, status: 404, message: "Not Found" };
  }

  const sourceIsDirectory = sourceStat.isDirectory();
  const normalizedSource = normalizeDavPath(sourcePath);
  const normalizedDestination = normalizeDavPath(destinationPath);

  if (normalizedSource === normalizedDestination) {
    return {
      ok: false,
      status: 403,
      message: "Forbidden: source and destination are the same resource",
    };
  }

  if (
    sourceIsDirectory &&
    normalizedSource !== "/" &&
    normalizedDestination.startsWith(withTrailingSlash(normalizedSource))
  ) {
    return {
      ok: false,
      status: 403,
      message: "Forbidden: cannot copy a collection inside itself",
    };
  }

  if (normalizedDestination === "/") {
    return {
      ok: false,
      status: 403,
      message: "Forbidden: cannot overwrite root collection",
    };
  }

  const parentPath = getParentDavPath(normalizedDestination);
  if (parentPath && parentPath !== "/") {
    try {
      const parentStat = await fs.stat(withTrailingSlash(parentPath));
      if (!parentStat.isDirectory()) {
        return {
          ok: false,
          status: 409,
          message: "Conflict: destination parent is not a collection",
        };
      }
    } catch (err) {
      if (isErrnoException(err)) {
        return {
          ok: false,
          status: 409,
          message: "Conflict: destination parent does not exist",
        };
      }
      throw err;
    }
  }

  let destinationExists = false;
  try {
    await fs.stat(normalizedDestination);
    destinationExists = true;
  } catch (err) {
    if (!isErrnoException(err)) {
      throw err;
    }
  }

  if (destinationExists) {
    if (!overwrite) {
      return {
        ok: false,
        status: 412,
        message: "Precondition Failed: destination exists and overwrite is not allowed",
      };
    }
    try {
      await fs.rm(normalizedDestination, { recursive: true, force: true });
    } catch (err) {
      if (isErrnoException(err)) {
        return {
          ok: false,
          status: mapErrnoToStatus(err),
          message: "Failed to remove destination before copy",
        };
      }
      throw err;
    }
  }

  const errors: CopyError[] = [];

  if (sourceIsDirectory) {
    await copyDirectoryRecursive(fs, normalizedSource, normalizedDestination, depth, errors);
  } else {
    try {
      await fs.copyFile(normalizedSource, normalizedDestination);
    } catch (err) {
      if (isErrnoException(err)) {
        return {
          ok: false,
          status: mapErrnoToStatus(err),
          message: err.message,
        };
      }
      throw err;
    }
  }

  return {
    ok: true,
    destinationExisted: destinationExists,
    errors,
  };
}

async function copyDirectoryRecursive(
  fs: FsSubset,
  source: string,
  destination: string,
  depth: number,
  errors: CopyError[]
) {
  const sourceDir = withTrailingSlash(source);
  const destinationDir = withTrailingSlash(destination);

  try {
    await fs.mkdir(destinationDir, { recursive: false });
  } catch (err) {
    if (isErrnoException(err)) {
      if (err.code !== "EEXIST") {
        errors.push({
          href: destinationDir,
          status: mapErrnoToStatus(err),
          description: err.message,
        });
        return;
      }
    } else {
      throw err;
    }
  }

  if (depth === 0) return;

  const nextDepth = depth === Infinity ? Infinity : Math.max(depth - 1, 0);

  let entries: DirentLike[];
  try {
    entries = (await fs.readdir(sourceDir, { withFileTypes: true })) as unknown as DirentLike[];
  } catch (err) {
    if (isErrnoException(err)) {
      errors.push({
        href: destinationDir,
        status: mapErrnoToStatus(err),
        description: err.message,
      });
      return;
    }
    throw err;
  }

  for (const entry of entries) {
    const childSource = joinDavPath(sourceDir, entry.name, entry.isDirectory());
    const childDestination = joinDavPath(destinationDir, entry.name, entry.isDirectory());

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(fs, childSource, childDestination, nextDepth, errors);
    } else {
      try {
        await fs.copyFile(childSource, childDestination);
      } catch (err) {
        if (isErrnoException(err)) {
          errors.push({
            href: childDestination,
            status: mapErrnoToStatus(err),
            description: err.message,
          });
        } else {
          throw err;
        }
      }
    }
  }
}

function joinDavPath(parentDir: string, childName: string, isDir: boolean): string {
  const base = parentDir === "/" ? "/" : removeSuffixSlash(parentDir);
  let combined = path.join(base, childName);
  if (!combined.startsWith("/")) {
    combined = `/${combined}`;
  }
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
  return removeSuffixSlash(pathname) + "/";
}

export function mapErrnoToStatus(err: NodeJS.ErrnoException): CopyErrorStatus {
  switch (err.code) {
    case "EACCES":
    case "EPERM":
      return 403;
    case "EEXIST":
      return 412;
    case "ENOENT":
      return 404;
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

export function multiStatusXML(errors: CopyError[]) {
  const responses = errors
    .map(({ href, status, description }) => {
      const reason = STATUS_CODES[status] ?? "";
      const desc = description ? `\n    <d:responsedescription>${escapeXml(description)}</d:responsedescription>` : "";
      return /* xml */ `<d:response>
    <d:href>${encodeURI(href)}</d:href>
    <d:status>HTTP/1.1 ${status} ${reason}</d:status>${desc}
</d:response>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<d:multistatus xmlns:d="DAV:">\n${responses}\n</d:multistatus>`;
}

function escapeXml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
