import { Buffer } from "node:buffer";
import { Stats, Dirent, type PathLike } from "node:fs";
import { Readable } from "node:stream";
import type { FilesystemTable } from "./fs.ts";

export interface FsSubset {
  access(path: PathLike): Promise<void>;
  stat(path: PathLike): Promise<Stats>;
  copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void>;
  rename(oldPath: PathLike, newPath: PathLike): Promise<void>;
  rmdir(path: PathLike, options?: { recursive?: boolean | undefined }): Promise<void>;
  rm(path: PathLike, options?: { recursive?: boolean | undefined; force?: boolean | undefined }): Promise<void>;
  mkdir(path: PathLike, options?: { recursive?: boolean | undefined } | null): Promise<string | undefined>;
  readdir(
    path: PathLike,
    options?: {
      withFileTypes?: false;
      recursive?: boolean;
    } | null
  ): Promise<string[]>;
  readdir(
    path: PathLike,
    options: {
      withFileTypes: true;
      recursive?: boolean;
    }
  ): Promise<Dirent[]>;
  writeFile(file: PathLike, data: string | Uint8Array): Promise<void>;
  readFile(path: PathLike): Promise<Buffer>;
  readFile(path: PathLike, options: { encoding: string }): Promise<string>;
  createReadStream(path: PathLike): Readable;
}

export class VFSError extends Error {
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
    }
  ) {
    super(`${code}: ${message}, ${syscall} '${path}'`);
    this.name = "VFSError";
  }
}

export const FULL_PATH = Symbol("full_path");
export const IS_DIRECTORY = Symbol("is_directory");
export const ETAG = Symbol("etag");

export class VStats implements Stats {
  constructor(
    {
      created_at,
      modified_at,
      size,
      etag,
    }: Pick<FilesystemTable, "created_at" | "modified_at" | "size"> & { etag?: string },
    fullPath: string,
    isDirectory = false
  ) {
    (this as any)[IS_DIRECTORY] = isDirectory;
    (this as any)[FULL_PATH] = fullPath;
    (this as any)[ETAG] = etag;
    this.mode = isDirectory ? 16877 : 33206;
    this.birthtimeMs = created_at;
    this.atimeMs = modified_at;
    this.mtimeMs = modified_at;
    this.ctimeMs = created_at;
    this.atime = new Date(modified_at);
    this.mtime = new Date(modified_at);
    this.ctime = new Date(created_at);
    this.birthtime = new Date(created_at);
    this.size = size;
  }
  isFile = (): boolean => !(this as any)[IS_DIRECTORY];
  isDirectory = (): boolean => (this as any)[IS_DIRECTORY];
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
  constructor(prefix: string, fullPath: string, isDirectory = false) {
    (this as any)[FULL_PATH] = fullPath;
    (this as any)[IS_DIRECTORY] = isDirectory;
    const filePath = fullPath.replace(prefix, "");
    const segments = filePath.split("/");
    this.name = segments.pop()!;
    this.parentPath = segments.join("/") || "";
  }
  isFile = (): boolean => !(this as any)[IS_DIRECTORY];
  isDirectory = (): boolean => (this as any)[IS_DIRECTORY];
  isBlockDevice = (): boolean => false;
  isCharacterDevice = (): boolean => false;
  isSymbolicLink = (): boolean => false;
  isFIFO = (): boolean => false;
  isSocket = (): boolean => false;
  get path() {
    return this.parentPath;
  }
}
