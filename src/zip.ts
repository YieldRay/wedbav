import { Buffer } from "node:buffer";
import { dirname } from "node:path/posix";
import { type Unzipped, unzipSync, type Zippable, zipSync } from "fflate";
import type { Context } from "hono";
import type { DirEntry, FsSubset } from "./abstract.ts";
import { convertToWebStream, isErrnoException, normalizePathLike, removeSuffixSlash } from "./utils.ts";

/**
 * Collect every entry (files and directories) under `dir` as a flat list of
 * {@link DirEntry} with names relative to `dir`.
 *
 * Fast path: the backing filesystem's optional {@link FsSubset._readDirMany}
 * reads the whole subtree in a single query. Otherwise we recurse with
 * `readdir` + `readFile`.
 */
async function collectEntries(fs: FsSubset, dir: string): Promise<DirEntry[]> {
  if (fs._readDirMany) {
    return fs._readDirMany(dir);
  }

  const dirKey = `${removeSuffixSlash(normalizePathLike(dir))}/`;
  const entries: DirEntry[] = [];

  const walk = async (rel: string): Promise<void> => {
    const abs = dirKey + rel; // rel ends with "/" or is ""
    const dirents = await fs.readdir(abs, { withFileTypes: true });
    for (const dirent of dirents) {
      const childRel = rel + dirent.name;
      if (dirent.isDirectory()) {
        entries.push({ name: childRel, isDirectory: true });
        await walk(`${childRel}/`);
      } else {
        const content = (await fs.readFile(`${dirKey}${childRel}`)) as unknown as Uint8Array;
        entries.push({ name: childRel, content });
      }
    }
  };

  await walk("");
  return entries;
}

/**
 * Zip the whole directory tree rooted at `dir` into a single archive. Empty
 * directories are preserved as zip directory entries. Returns the zip bytes.
 */
export async function zipDirectory(fs: FsSubset, dir: string): Promise<Uint8Array> {
  const entries = await collectEntries(fs, dir);

  const zippable: Zippable = {};
  for (const entry of entries) {
    if (entry.isDirectory) {
      // Trailing slash marks a directory entry in the zip.
      zippable[`${entry.name}/`] = new Uint8Array();
    } else {
      zippable[entry.name] = entry.content ?? new Uint8Array();
    }
  }

  return zipSync(zippable);
}

/**
 * Extract a zip archive into `dir`. Directory entries in the zip (names ending
 * in `/`) create directories; file entries are written relative to `dir`.
 *
 * Fast path: the optional {@link FsSubset._writeDirMany} writes the whole tree
 * in a single transaction. Otherwise we `mkdir` + `writeFile` per entry.
 *
 * Zip-slip is prevented: entries that escape `dir` (via `..` or absolute paths)
 * are rejected.
 */
export async function unzipInto(fs: FsSubset, dir: string, zip: Uint8Array): Promise<void> {
  const unzipped: Unzipped = unzipSync(zip);

  const entries: DirEntry[] = [];
  for (const [rawName, data] of Object.entries(unzipped)) {
    const isDirectory = rawName.endsWith("/");
    const name = sanitizeEntryName(rawName);
    if (name === undefined) {
      throw new Error(`unsafe zip entry path: ${rawName}`);
    }
    if (name === "") continue; // the archive root itself
    if (isDirectory) {
      entries.push({ name, isDirectory: true });
    } else {
      entries.push({ name, content: data });
    }
  }

  if (entries.length === 0) return;

  if (fs._writeDirMany) {
    await fs._writeDirMany(dir, entries);
    return;
  }

  // Fallback: create explicit directory entries first, then each file — always
  // ensuring the file's parent directory exists (many zips list file entries
  // without a preceding `dir/` entry, so we can't rely on explicit dir entries).
  const dirKey = `${removeSuffixSlash(normalizePathLike(dir))}/`;
  const dirEntries = entries.filter((e) => e.isDirectory).sort((a, b) => a.name.length - b.name.length);
  const fileEntries = entries.filter((e) => !e.isDirectory);

  const ensured = new Set<string>();
  const ensureDir = async (relDir: string): Promise<void> => {
    // relDir is "" (extraction root, already exists) or a "/"-less relative path.
    if (relDir === "" || relDir === "." || ensured.has(relDir)) return;
    ensured.add(relDir);
    await fs.mkdir(`${dirKey}${relDir}/`, { recursive: true });
  };

  for (const entry of dirEntries) {
    await ensureDir(entry.name);
  }
  for (const entry of fileEntries) {
    const parent = dirname(entry.name);
    await ensureDir(parent === "." ? "" : parent);
    await fs.writeFile(`${dirKey}${entry.name}`, Buffer.from(entry.content ?? new Uint8Array()));
  }
}

/**
 * Normalize a zip entry name to a safe path relative to the extraction root.
 * Returns `undefined` when the entry would escape the root (zip-slip), or an
 * empty string when the entry resolves to the root itself.
 */
function sanitizeEntryName(rawName: string): string | undefined {
  // Normalize separators and strip a leading slash (absolute path -> relative).
  const normalized = rawName.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Escapes the extraction root.
      return undefined;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

/**
 * Respond with a zip archive of the directory at `pathname` (recursively).
 * Returns 404 when the directory does not exist.
 */
export async function handleZipDownload(c: Context, fs: FsSubset, pathname: string): Promise<Response> {
  try {
    const zip = await zipDirectory(fs, pathname);
    const base = removeSuffixSlash(pathname).split("/").pop() || "archive";
    return c.body(convertToWebStream(zip), 200, {
      "Content-Disposition": `attachment; filename="${encodeURIComponent(base)}.zip"`,
      "Content-Length": zip.byteLength.toString(),
      "Content-Type": "application/zip",
    });
  } catch (e) {
    if (isErrnoException(e)) return c.text("Not Found", 404);
    throw e;
  }
}

/**
 * Extract the request body (a zip archive) into the directory at `pathname`.
 * Returns 400 on a malformed archive or an unsafe (zip-slip) entry path.
 */
export async function handleZipUpload(c: Context, fs: FsSubset, pathname: string): Promise<Response> {
  const body = new Uint8Array(await c.req.arrayBuffer());
  try {
    await unzipInto(fs, pathname, body);
  } catch (e) {
    if (isErrnoException(e)) throw e;
    return c.text(`Invalid zip: ${e instanceof Error ? e.message : String(e)}`, 400);
  }
  return c.body("Created", 201);
}
