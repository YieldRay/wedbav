import { Buffer } from "node:buffer";
import { dirname, relative } from "node:path/posix";
import { Stats, Dirent, type PathLike } from "node:fs";
import { styleText } from "node:util";
import { Readable } from "node:stream";
import { type Dialect, Kysely, sql } from "kysely";
import { FULL_PATH, VDirent, VFSError, VStats, type FsSubset } from "./abstract.ts";
import { createEtag, normalizePathLike, removeSuffixSlash, encodePathForSQL } from "./utils.ts";

const DEFAULT_TABLE_NAME = "filesystem" as const;
type DEFAULT_TABLE_NAME = typeof DEFAULT_TABLE_NAME;

interface Database {
  [DEFAULT_TABLE_NAME]: FilesystemTable;
}

export interface FilesystemTable {
  // if path ends with /, it must be a explicit directory
  // if there is an explicit directory, its path must end with /
  // implicit directories DO NOT have rows
  path: string;
  created_at: number;
  modified_at: number;
  size: number;
  etag: string;
  content: Uint8Array | null;
  meta: string | null;
}

export class KyselyFs implements FsSubset {
  /** DO NOT use it directly, use $xxx */
  private readonly _tableName: string;
  private readonly _db: Kysely<Database>;
  private readonly _dbType: "sqlite" | "mysql" | "pg";
  private get $insert() {
    return this._db.insertInto(this._tableName as DEFAULT_TABLE_NAME);
  }
  private get $select() {
    return this._db.selectFrom(this._tableName as DEFAULT_TABLE_NAME);
  }
  private get $delete() {
    return this._db.deleteFrom(this._tableName as DEFAULT_TABLE_NAME);
  }
  private get $update() {
    return this._db.updateTable(this._tableName as DEFAULT_TABLE_NAME);
  }

  constructor(
    dialect: Dialect,
    options: {
      /** @default DEFAULT_TABLE_NAME */
      tableName?: string;
      /** @default "sqlite" */
      dbType?: "sqlite" | "mysql" | "pg";
    }
  ) {
    const { tableName = DEFAULT_TABLE_NAME, dbType = "sqlite" } = options;
    this._tableName = tableName;
    this._dbType = dbType;
    const db = new Kysely<Database>({
      dialect,
      log({ level, query, queryDurationMillis, ...event }) {
        if (level === "error") {
          console.error(styleText(["red"], `[${level}]`), `in ${queryDurationMillis}ms`);
        } else {
          console.log(styleText(["green"], `[${level}]`), `in ${queryDurationMillis}ms`);
        }
        console.log(styleText(["magenta"], query.sql), query.parameters.length ? query.parameters : "");
        if (level === "error") console.error(event);
        console.log();
      },
    });
    this._db = db;

    // create the table if not exists
    db.schema
      .createTable(tableName)
      .ifNotExists()
      .addColumn("path", "varchar(4096)", (col) => col.primaryKey())
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("modified_at", "bigint", (col) => col.notNull())
      .addColumn("size", "integer", (col) => col.notNull())
      .addColumn("etag", "varchar(1024)", (col) => col.notNull())
      .addColumn("content", this._dbType === "pg" ? "bytea" : "blob")
      .addColumn("meta", "text")
      .execute();
  }

  private async _getFileStats(fileKey: string) {
    console.assert(!fileKey.endsWith("/"), "fileKey must not end with /");
    const file = await this.$select
      .select(["created_at", "modified_at", "size", "etag"])
      .where("path", "=", fileKey)
      .executeTakeFirst();
    if (file) return new VStats(file, fileKey);
  }
  private async _getExplicitDirStats(dirKey: string) {
    console.assert(dirKey.endsWith("/"), "dirKey must end with /");
    const dir = await this.$select.select(["created_at", "modified_at"]).where("path", "=", dirKey).executeTakeFirst();
    if (dir) return new VStats({ created_at: dir.created_at, modified_at: dir.modified_at, size: 0 }, dirKey, true);
  }
  private async _getImplicitDirStats(dirKey: string) {
    console.assert(dirKey.endsWith("/"), "dirKey must end with /");
    const dirAgg = await this.$select
      .select(({ fn }) => [
        fn.min("created_at").as("created_at"),
        fn.max("modified_at").as("modified_at"),
        sql<number>`0`.as("size"),
      ])
      .where("path", "like", `${encodePathForSQL(dirKey)}%`)
      .where((eb) => eb("path", "!=", dirKey))
      .executeTakeFirst();

    if (
      // created_at is null when there are no files in the directory
      dirAgg?.created_at
    )
      return new VStats(dirAgg, dirKey, true);
  }

  private async _getDirStats(dirKey: string) {
    if (dirKey === "") return this._getImplicitDirStats("/");

    console.assert(dirKey.endsWith("/"), "dirKey must end with /");
    // First, check explicit directory row
    const explicitDir = await this._getExplicitDirStats(dirKey);
    if (explicitDir) return explicitDir;
    // Then, check implicit directory from children
    const implicitDir = await this._getImplicitDirStats(dirKey);
    if (implicitDir) return implicitDir;
  }

  async access(path: PathLike): Promise<void> {
    await this.stat(path);
  }

  async stat(path: PathLike): Promise<Stats> {
    const key = normalizePathLike(path);
    const isDir = key.endsWith("/");

    // key is a dir key
    if (isDir) {
      const dirKey = removeSuffixSlash(key) + "/";
      const dir = await this._getDirStats(dirKey);
      if (dir) return dir;

      // although it's a dir key, we still need to check if it's a file for compatibility
      // const fileKey = removeSuffixSlash(key);
      // const file = await this._getFileStats(fileKey);
      // if (file) return file;

      throw new VFSError("no such file or directory", {
        syscall: "stat",
        code: "ENOENT",
        path,
      });
    }

    // key is a file key for now, but we still need to check if it's a dir!

    // try file first
    const file = await this._getFileStats(key);
    if (file) return file;

    // then try directory
    const dirKey = key + "/";
    const dir = await this._getDirStats(dirKey);
    if (dir) return dir;

    throw new VFSError("no such file or directory", {
      syscall: "stat",
      code: "ENOENT",
      path,
    });
  }

  async copyFile(src: PathLike, dest: PathLike): Promise<void> {
    const srcKey = normalizePathLike(src);
    if (srcKey.endsWith("/")) {
      throw new VFSError("Cannot copy directory to file", { syscall: "copyfile", code: "EINVAL", path: dest });
    }

    const destKey = normalizePathLike(dest);
    if (destKey.endsWith("/")) {
      throw new VFSError("Cannot copy file to directory", { syscall: "copyfile", code: "EISDIR", path: dest });
    }

    // we should check if dest is a directory
    const destDirKey = destKey + "/";
    if (await this._getDirStats(destDirKey)) {
      throw new VFSError("Cannot copy file to directory", { syscall: "copyfile", code: "EISDIR", path: dest });
    }

    // now we can safely copy the file
    const file = await this.$select.selectAll().where("path", "=", srcKey).executeTakeFirst();
    if (!file) {
      throw new VFSError("no such file or directory", {
        syscall: "copyfile",
        code: "ENOENT",
        path: src,
      });
    }

    const now = Date.now();
    await this.$insert
      .values({
        path: destKey,
        created_at: now,
        modified_at: now,
        size: file.size,
        content: file.content,
        etag: file.etag,
      })
      .onConflict((oc) =>
        oc.column("path").doUpdateSet({
          modified_at: now,
          size: file.size,
          content: file.content,
          etag: file.etag,
        })
      )
      .execute();
  }

  /**
   * Asynchronously rename file at oldPath to the pathname provided as newPath. In the case that newPath already exists, it will be overwritten.
   * If there is a directory at newPath, an error will be raised instead.
   */
  async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
    const oldKey = normalizePathLike(oldPath);
    const isDir = oldKey.endsWith("/");
    const newKey = normalizePathLike(newPath);

    if (isDir) {
      const oldDirKey = oldKey;
      const newDirKey = removeSuffixSlash(newKey) + "/";
      const explicitDir = await this._getExplicitDirStats(oldKey);
      if (explicitDir) {
        if (await this._getExplicitDirStats(newDirKey)) {
          throw new VFSError("file exists", { syscall: "rename", code: "EEXIST", path: newPath });
        }
        await this.$update.set({ path: newDirKey, modified_at: Date.now() }).where("path", "=", oldKey).execute();
      }
      // implicit directories cannot be renamed, we should rename all children instead
      const allFiles = await this.$select
        .select(["path"])
        .where("path", "like", `${encodePathForSQL(oldDirKey)}%`)
        .execute();
      //? this is not atomic, we just implement it loosely
      for (const { path: oldPath } of allFiles) {
        const newPath = oldPath.replace(oldDirKey, newDirKey);
        await this.$update.set({ path: newPath, modified_at: Date.now() }).where("path", "=", oldPath).execute();
      }
      return;
    }

    const oldFileKey = oldKey;
    const newFileKey = newKey;
    const file = await this._getFileStats(oldFileKey);
    if (!file) {
      throw new VFSError("no such file or directory", {
        syscall: "rename",
        code: "ENOENT",
        path: oldFileKey,
      });
    }

    // check if newKey is a directory
    const newDirKey = newFileKey + "/";
    if (await this._getDirStats(newDirKey)) {
      throw new VFSError("illegal operation on a directory", { syscall: "rename", code: "EISDIR", path: newPath });
    }
    // check if newFileKey is an existing file
    const existingFile = await this._getFileStats(newFileKey);
    if (existingFile) {
      throw new VFSError("file already exists", {
        syscall: "rename",
        code: "EEXIST",
        path: newPath,
      });
    }

    await this.$update.set({ path: newFileKey, modified_at: Date.now() }).where("path", "=", oldFileKey).execute();
  }

  async rmdir(path: PathLike, options?: { recursive?: boolean }): Promise<void> {
    const fileKey = removeSuffixSlash(normalizePathLike(path));
    const dirKey = fileKey + "/";
    const recursive = options?.recursive ?? false;

    if (await this._getFileStats(fileKey)) {
      throw new VFSError("not a directory", { syscall: "rmdir", code: "ENOTDIR", path });
    }

    if (!recursive) {
      // when not recursive, we should check if there are any children
      const hasChildren = await this.$select
        .select("path")
        .where("path", "like", `${encodePathForSQL(dirKey)}%`)
        .executeTakeFirst();
      if (hasChildren) {
        throw new VFSError("directory not empty", { syscall: "rmdir", code: "ENOTEMPTY", path });
      }
    }

    // remove the explicit dir
    await this.$delete.where("path", "=", dirKey).execute();

    // remove the implicit dir
    await this.$delete.where("path", "like", `${encodePathForSQL(dirKey)}%`).execute();
  }

  async unlink(path: PathLike): Promise<void> {
    const key = normalizePathLike(path);
    if (key.endsWith("/")) {
      throw new VFSError("illegal operation on a directory", { syscall: "unlink", code: "EISDIR", path });
    }
    await this.$delete.where("path", "=", key).execute();
  }

  async rm(path: PathLike, options?: { recursive?: boolean | undefined; force?: boolean | undefined }): Promise<void> {
    const recursive = options?.recursive ?? false;
    const force = options?.force ?? false;

    const key = normalizePathLike(path);
    const fileKey = removeSuffixSlash(key);
    const dirKey = fileKey + "/";

    try {
      const stat = await this.stat(path);
      if (stat.isDirectory()) {
        return this.rmdir(dirKey, { recursive });
      }

      // it's a file
      await this.unlink(fileKey);
    } catch {
      if (force) return;
      throw new VFSError("no such file or directory", { syscall: "rm", code: "ENOENT", path });
    }
  }

  /**
   * @returns Upon success, fulfills with undefined if recursive is false, or the first directory path created if recursive is true.
   */
  async mkdir(path: PathLike, options?: { recursive?: boolean | undefined } | null): Promise<string | undefined> {
    const recursive = options?.recursive ?? false;
    const fileKey = removeSuffixSlash(normalizePathLike(path));
    const dirKey = fileKey + "/";

    if (await this._getFileStats(fileKey)) {
      throw new VFSError("file exists", { syscall: "mkdir", code: "EEXIST", path });
    }

    if (await this._getDirStats(dirKey)) {
      throw new VFSError("file exists", { syscall: "mkdir", code: "EEXIST", path });
    }

    if (!recursive) {
      // check if parent dir exists
      const parentDirKey = dirname(dirKey) + "/";
      if (
        parentDirKey !== "./" &&
        // ./ means root dir, which always exists
        !(await this._getDirStats(parentDirKey))
      ) {
        throw new VFSError("no such file or directory", { syscall: "mkdir", code: "ENOENT", path });
      }
    }

    const now = Date.now();
    await this.$insert
      .values({
        path: dirKey,
        created_at: now,
        modified_at: now,
        size: 0,
        etag: "",
        content: null,
        meta: null,
      })
      .execute();

    if (recursive) {
      return dirKey; // dummy
    }
    return undefined;
  }

  async readdir(path: PathLike, options?: { withFileTypes?: false; recursive?: boolean }): Promise<string[]>;
  async readdir(path: PathLike, options: { withFileTypes: true; recursive?: boolean }): Promise<Dirent[]>;
  async readdir(
    path: PathLike,
    options?: { withFileTypes?: boolean; recursive?: boolean }
  ): Promise<string[] | Dirent[]> {
    const withFileTypes = options?.withFileTypes || false;
    const recursive = options?.recursive || false;

    const dirKey = removeSuffixSlash(normalizePathLike(path)) + "/";

    const allFiles = await this.$select
      .select(["path", "created_at", "modified_at", "size"])
      .where("path", "like", `${encodePathForSQL(dirKey)}%`)
      .execute(); // recursive

    // Collect full paths for files and directories to return.
    const fileSet = new Set<string>();
    const dirSet = new Set<string>();

    for (const entry of allFiles) {
      const fullPath = entry.path;
      if (fullPath === dirKey) continue; // skip the directory itself if explicitly stored

      const isDir = fullPath.endsWith("/");
      const rel = relative(dirKey, fullPath);

      if (recursive) {
        // Return every entry under dirKey
        if (isDir) dirSet.add(removeSuffixSlash(fullPath));
        else fileSet.add(fullPath);

        // Add all ancestor directories by scanning the relative path
        const relNoSlash = removeSuffixSlash(rel);
        if (relNoSlash) {
          let idx = -1;
          while ((idx = relNoSlash.indexOf("/", idx + 1)) !== -1) {
            const dirRel = relNoSlash.slice(0, idx);
            if (dirRel) dirSet.add(dirKey + dirRel);
          }
        }
        continue;
      }

      // Non-recursive: only immediate children
      if (isDir) {
        // Immediate child directory name is the first segment
        const first = rel.split("/")[0] || "";
        if (first) dirSet.add(removeSuffixSlash(dirKey + first));
      } else {
        if (rel.includes("/")) {
          // Nested file -> synthesize top-level dir entry
          const first = rel.split("/")[0];
          if (first) dirSet.add(removeSuffixSlash(dirKey + first));
        } else {
          // Immediate file
          fileSet.add(dirKey + rel);
        }
      }
    }

    // Build VDirent list (order not guaranteed; sort for stability)
    const dirents: VDirent[] = [
      ...Array.from(dirSet)
        .sort()
        .map((d) => new VDirent(dirKey, d, true)),
      ...Array.from(fileSet)
        .sort()
        .map((f) => new VDirent(dirKey, f)),
    ] satisfies Dirent[];

    if (withFileTypes) {
      return dirents;
    }
    // Return names relative to dirKey (may include subpaths if recursive)
    const result = dirents.map((d) => d[FULL_PATH].replace(dirKey, "") as string);
    return result;
  }

  async writeFile(file: PathLike, data: string | Uint8Array): Promise<void> {
    const fileKey = removeSuffixSlash(normalizePathLike(file));

    // check if the explicit dir exists
    const dirKey = fileKey + "/";
    if (await this._getExplicitDirStats(dirKey)) {
      throw new VFSError("illegal operation on a directory", { syscall: "writeFile", code: "EISDIR", path: file });
    }

    const now = Date.now();
    const content = Buffer.from(data);
    const size = content.byteLength;
    const etag = await createEtag(content);

    await this.$insert
      .values({
        path: fileKey,
        created_at: now,
        modified_at: now,
        size: size,
        content: content,
        etag,
      })
      .onConflict((oc) =>
        oc.column("path").doUpdateSet({
          modified_at: now,
          size: size,
          content: content,
          etag,
        })
      )
      .execute();
  }

  async readFile(path: PathLike): Promise<Buffer>;
  async readFile(path: PathLike, options: { encoding: string }): Promise<string>;
  async readFile(path: PathLike, options?: { encoding?: string }): Promise<Buffer | string> {
    const fileKey = removeSuffixSlash(normalizePathLike(path));
    const encoding = options?.encoding;
    const file = await this.$select.select("content").where("path", "=", fileKey).executeTakeFirst();

    if (!file || !file.content) {
      throw new VFSError("no such file or directory", {
        syscall: "readFile",
        code: "ENOENT",
        path,
      });
    }

    if (encoding) return new TextDecoder(encoding).decode(file.content);
    return Buffer.from(file.content);
  }

  createReadStream(path: PathLike): Readable {
    const fileKey = removeSuffixSlash(normalizePathLike(path));
    const select = this.$select.select.bind(this.$select);
    let offset = 1; // SQLite BLOBs are 1-indexed

    const stream = new Readable({
      async read(size) {
        const part = await select(
          //! substr is supported by SQLite, MySQL, and PostgreSQL
          sql<Uint8Array>`substr(content, ${offset}, ${size})`.as("content")
        )
          .where("path", "=", fileKey)
          .executeTakeFirst();

        if (!part || !part.content) {
          this.push(null);
        } else {
          this.push(Buffer.from(part.content));
          offset += size;
        }
      },
      highWaterMark: 1024 * 1024, // 1MB chunks, each chunk may be once query to SQLite
      objectMode: false,
    });

    return stream;
  }
}
