import type { Buffer } from "node:buffer";
import type { Dirent, PathLike, Stats } from "node:fs";
import type { Readable } from "node:stream";
import type { FilesystemTable } from "./fs.ts";

/**
 * A single entry within a directory, used by the batch helpers
 * {@link FsSubset._readDirMany} and {@link FsSubset._writeDirMany}.
 *
 * - `name` is relative to the directory (may contain `/` for nested entries).
 * - `isDirectory` marks the entry as a directory; directories carry no content.
 * - `content` is the file body (defaults to empty when omitted on write).
 */
export interface DirEntry {
  name: string;
  isDirectory?: boolean;
  content?: Uint8Array;
}

export interface FsSubset {
  access(path: PathLike): Promise<void>;
  stat(path: PathLike): Promise<Stats>;
  copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void>;
  rename(oldPath: PathLike, newPath: PathLike): Promise<void>;
  rmdir(path: PathLike, options?: { recursive?: boolean | undefined }): Promise<void>;
  unlink(path: PathLike): Promise<void>;
  rm(path: PathLike, options?: { recursive?: boolean | undefined; force?: boolean | undefined }): Promise<void>;
  mkdir(path: PathLike, options?: { recursive?: boolean | undefined } | null): Promise<string | undefined>;
  readdir(
    path: PathLike,
    options?: {
      withFileTypes?: false;
      recursive?: boolean;
    } | null,
  ): Promise<string[]>;
  readdir(
    path: PathLike,
    options: {
      withFileTypes: true;
      recursive?: boolean;
    },
  ): Promise<Dirent[]>;
  writeFile(file: PathLike, data: string | Uint8Array): Promise<void>;
  readFile(path: PathLike): Promise<Buffer>;
  createReadStream(path: PathLike): Readable;
  /**
   * Recursively read every entry under `dir` in a single query.
   * Returns one {@link DirEntry} per file and directory, with `name` relative to
   * `dir` (nested entries include `/`). Files carry `content`; directories carry
   * `isDirectory: true` and no content.
   * Throws `ENOTDIR`/`ENOENT` when `dir` is not an existing directory.
   */
  _readDirMany?(dir: PathLike): Promise<DirEntry[]>;
  /**
   * Write many entries into `dir` in a single transaction/query.
   * Each entry is written at `dir + entry.name`; `isDirectory` entries create a
   * directory row, others write `content` (empty when omitted).
   * Throws `EISDIR` when a file target collides with an existing directory.
   */
  _writeDirMany?(dir: PathLike, entries: DirEntry[]): Promise<void>;
}

export class VFSError extends Error implements NodeJS.ErrnoException {
  code: string;
  syscall: string;
  path: string;
  constructor(
    message: string,
    {
      code,
      syscall,
      path,
    }: {
      errno?: number;
      code: string;
      syscall: string;
      path: PathLike;
    },
  ) {
    super(`${code}: ${message}, ${syscall} '${path}'`);
    this.name = "VFSError";
    this.code = code;
    this.syscall = syscall;
    this.path = String(path);
  }
}

export const FULL_PATH = Symbol("full_path");
export const IS_DIRECTORY = Symbol("is_directory");
export const ETAG = Symbol("etag");

export class VStats implements Stats {
  [IS_DIRECTORY]: boolean;
  [FULL_PATH]: string;
  [ETAG]: string | undefined;
  constructor(
    {
      created_at,
      modified_at,
      size,
      etag,
    }: Pick<FilesystemTable, "created_at" | "modified_at" | "size"> & { etag?: string | null },
    fullPath: string,
    isDirectory = false,
  ) {
    this[IS_DIRECTORY] = isDirectory;
    this[FULL_PATH] = fullPath;
    this[ETAG] = etag || undefined;
    const cAt = Number(created_at);
    const mAt = Number(modified_at);
    this.mode = isDirectory ? 16877 : 33206;
    this.birthtimeMs = cAt;
    this.atimeMs = mAt;
    this.mtimeMs = mAt;
    this.ctimeMs = cAt;
    this.atime = new Date(mAt);
    this.mtime = new Date(mAt);
    this.ctime = new Date(cAt);
    this.birthtime = new Date(cAt);
    this.size = Number(size);
  }
  isFile = (): boolean => !this[IS_DIRECTORY];
  isDirectory = (): boolean => this[IS_DIRECTORY];
  isBlockDevice = (): boolean => false;
  isCharacterDevice = (): boolean => false;
  isSymbolicLink = (): boolean => false;
  isFIFO = (): boolean => false;
  isSocket = (): boolean => false;
  dev: number = 0;
  ino: number = 0;
  mode: number = 0;
  nlink: number = 1;
  uid: number = 0;
  gid: number = 0;
  rdev: number = 0;
  size: number = 0;
  blksize: number = 0;
  blocks: number = 0;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
}

export class VDirent implements Dirent {
  name: string;
  parentPath: string;
  [FULL_PATH]: string;
  [IS_DIRECTORY]: boolean;
  constructor(prefix: string, fullPath: string, isDirectory = false) {
    this[FULL_PATH] = fullPath;
    this[IS_DIRECTORY] = isDirectory;
    const filePath = fullPath.replace(prefix, "");
    const segments = filePath.split("/");
    this.name = segments.pop()!;
    this.parentPath = segments.join("/") || "";
  }
  isFile = (): boolean => !this[IS_DIRECTORY];
  isDirectory = (): boolean => this[IS_DIRECTORY];
  isBlockDevice = (): boolean => false;
  isCharacterDevice = (): boolean => false;
  isSymbolicLink = (): boolean => false;
  isFIFO = (): boolean => false;
  isSocket = (): boolean => false;
  get path() {
    return this.parentPath;
  }
}
