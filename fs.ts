import { Dialect, Kysely, sql } from "kysely";
import { Buffer } from "node:buffer";
import { Stats, Dirent, PathLike } from "node:fs";
import { normalize } from "node:path/posix";
import { createHash } from "node:crypto";

const DEFAULT_TABLE_NAME = "filesystem";
type DEFAULT_TABLE_NAME = typeof DEFAULT_TABLE_NAME;

interface Database {
    [DEFAULT_TABLE_NAME]: FilesystemTable;
}

interface FilesystemTable {
    path: string;
    created_at: number;
    modified_at: number;
    size: number;
    etag: string;
    content: Uint8Array | null;
    meta: string | null;
}

export interface FsSubset {
    access(path: PathLike): Promise<void>;
    stat(path: PathLike): Promise<Stats>;
    copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void>;
    rename(oldPath: PathLike, newPath: PathLike): Promise<void>;
    rmdir(path: PathLike, options?: { recursive?: boolean | undefined }): Promise<void>;
    rm(
        path: PathLike,
        options?: { recursive?: boolean | undefined; force?: boolean | undefined }
    ): Promise<void>;
    mkdir(
        path: PathLike,
        options?: { recursive?: boolean | undefined } | null
    ): Promise<string | undefined>;
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
}

class VFSError extends Error {
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

const FULL_PATH = Symbol("full_path");
const IS_DIRECTORY = Symbol("is_directory");
export const ETAG = Symbol("etag");

class VStats implements Stats {
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

class VDirent implements Dirent {
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

export class SqliteFs implements FsSubset {
    /** DO NOT use it directly, use $xxx */
    private _db: Kysely<Database>;
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

    constructor(dialect: Dialect, private _tableName = DEFAULT_TABLE_NAME) {
        const db = new Kysely<Database>({ dialect });
        this._db = db;

        // create the table if not exists
        db.schema
            .createTable(_tableName)
            .ifNotExists()
            .addColumn("path", "char(4096)", (col) => col.primaryKey())
            .addColumn("created_at", "integer", (col) => col.notNull())
            .addColumn("modified_at", "integer", (col) => col.notNull())
            .addColumn("size", "integer", (col) => col.notNull())
            .addColumn("etag", "char(1024)", (col) => col.notNull())
            .addColumn("content", "blob")
            .addColumn("meta", "text")
            .execute();
    }

    async access(path: PathLike): Promise<void> {
        const pathStr = normalizePathLike(path);
        const first = await this.$select
            .select("path")
            .where("path", "=", pathStr)
            .executeTakeFirst();
        if (!first)
            throw new VFSError("no such file or directory", {
                syscall: "access",
                code: "ENOENT",
                path,
            });
    }

    async stat(path: PathLike): Promise<Stats> {
        const pathStr = normalizePathLike(path);
        const file = await this.$select
            .select(["created_at", "modified_at", "size", "etag"])
            .where("path", "=", pathStr)
            .executeTakeFirst();
        if (file) return new VStats(file, pathStr);

        // check for directory
        const dir = await this.$select
            .select([
                sql<number>`MIN(created_at)`.as("created_at"),
                sql<number>`MAX(modified_at)`.as("modified_at"),
                sql<number>`0`.as("size"),
            ])
            .where("path", "like", `${encodePathForSQL(pathStr)}/%`)
            .executeTakeFirst();
        if (dir) return new VStats(dir, pathStr, true);

        throw new VFSError("no such file or directory", {
            syscall: "stat",
            code: "ENOENT",
            path,
        });
    }

    async copyFile(src: PathLike, dest: PathLike): Promise<void> {
        const srcPath = normalizePathLike(src);
        const destPath = normalizePathLike(dest);
        const file = await this.$select.selectAll().where("path", "=", srcPath).executeTakeFirst();

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
                path: destPath,
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
                })
            )
            .execute();
    }

    async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
        const oldPathStr = normalizePathLike(oldPath);
        const newPathStr = normalizePathLike(newPath);

        // check if oldPathStr exists
        const file = await this.$select
            .select("path")
            .where("path", "=", oldPathStr)
            .executeTakeFirst();
        if (!file) {
            throw new VFSError("no such file or directory", {
                syscall: "rename",
                code: "ENOENT",
                path: oldPath,
            });
        }

        //  check if newPathStr exists
        const exists = await this.$select
            .select("path")
            .where("path", "=", newPathStr)
            .executeTakeFirst();
        if (exists) {
            throw new VFSError("file already exists", {
                syscall: "rename",
                code: "EEXIST",
                path: newPath,
            });
        }

        // rename
        await this.$update
            .set({ path: newPathStr, modified_at: Date.now() })
            .where("path", "=", oldPathStr)
            .execute();
    }

    async rmdir(path: PathLike, options?: { recursive?: boolean }): Promise<void> {
        const pathStr = normalizePathLike(path);
        const recursive = options?.recursive ?? false;

        if (recursive) {
            await this.$delete.where("path", "like", `${encodePathForSQL(pathStr)}/%`).execute();
            return;
        }

        // check if the directory is empty
        const hasChildren = await this.$select
            .select("path")
            .where("path", "like", `${encodePathForSQL(pathStr)}/%`)
            .executeTakeFirst();

        if (hasChildren) {
            throw new VFSError("directory not empty", {
                syscall: "rmdir",
                code: "ENOTEMPTY",
                path,
            });
        }

        // check if the path is a file
        const fileExists = await this.$select
            .select("path")
            .where("path", "=", pathStr)
            .executeTakeFirst();

        if (fileExists) {
            throw new VFSError("Not a directory", {
                syscall: "rmdir",
                code: "ENOTDIR",
                path,
            });
        }

        // check if the directory exists
        const dirExists = await this.$select
            .select("path")
            .where("path", "like", `${encodePathForSQL(pathStr)}/%`)
            .executeTakeFirst();

        if (!dirExists) {
            throw new VFSError("no such file or directory", {
                syscall: "rmdir",
                code: "ENOENT",
                path,
            });
        }
    }

    async rm(
        path: PathLike,
        options?: { recursive?: boolean | undefined; force?: boolean | undefined }
    ): Promise<void> {
        const pathStr = normalizePathLike(path);
        const recursive = options?.recursive ?? false;
        const force = options?.force ?? false;

        try {
            // remove the file
            await this.$delete.where("path", "=", pathStr).execute();
            if (recursive) {
                // remove all dirs
                await this.$delete
                    .where("path", "like", `${encodePathForSQL(pathStr)}/%`)
                    .execute();
            }
        } catch (e) {
            if (!force) {
                throw e;
            }
        }
    }

    async mkdir(
        path: PathLike,
        options?: { recursive?: boolean | undefined } | null
    ): Promise<string | undefined> {
        const pathStr = normalizePathLike(path);
        const recursive = options?.recursive ?? false; // unused

        // since we don't store directories explicitly, we just need to check if the path exists as a prefix
        const exists = await this.$select
            .select("path")
            .where("path", "=", pathStr)
            .where((eb) =>
                eb("path", "=", pathStr).or("path", "like", `${encodePathForSQL(pathStr)}/%`)
            )
            .executeTakeFirst();

        if (exists) {
            throw new VFSError("file already exists", {
                syscall: "mkdir",
                code: "EEXIST",
                path,
            });
        }

        return undefined; // no path created, as we don't store directories
    }

    async readdir(
        path: PathLike,
        options?: { withFileTypes?: false; recursive?: boolean }
    ): Promise<string[]>;
    async readdir(
        path: PathLike,
        options: { withFileTypes: true; recursive?: boolean }
    ): Promise<Dirent[]>;
    async readdir(
        path: PathLike,
        options?: { withFileTypes?: boolean; recursive?: boolean }
    ): Promise<string[] | Dirent[]> {
        const withFileTypes = options?.withFileTypes || false;
        const recursive = options?.recursive || false;

        const pathStr = normalizePathLike(path);
        const currentDir = pathStr + "/";
        const allFiles = await this.$select
            .select(["path", "created_at", "modified_at", "size"])
            .where("path", "like", `${encodePathForSQL(currentDir)}%`)
            .execute(); // recursive

        const files: typeof allFiles = [];
        const dirs = new Set<string>();

        for (const file of allFiles) {
            const relativePath = file.path.replace(currentDir, "");
            if (relativePath.includes("/")) {
                if (recursive) {
                    // add all if recursive
                    let d = relativePath;
                    while (d.includes("/")) {
                        // remove last segment
                        d = d.split("/").slice(0, -1).join("/");
                        dirs.add(currentDir + d);
                    }
                    files.push(file);
                } else {
                    // only add top level
                    const slashCount = (relativePath.match(/\//g) || []).length;
                    if (slashCount === 0) {
                        // no slash, must be a file
                        files.push(file);
                    } else if (slashCount) {
                        // dir1/dir2/dir3 -> dir1
                        dirs.add(relativePath.replace(/\/.+$/, ""));
                    }
                }
            } else {
                // flat file, just add
                files.push(file);
            }
        }

        const result = [
            ...files.map((f) => new VDirent(currentDir, f.path)),
            ...Array.from(dirs).map((d) => new VDirent(currentDir, d, true)),
        ];

        if (withFileTypes) {
            return result;
        } else {
            return result.map((d) => (d as any)[FULL_PATH].replace(currentDir, ""));
        }
    }

    async writeFile(file: PathLike, data: string | Uint8Array): Promise<void> {
        const filePath = normalizePathLike(file);
        const now = Date.now();
        const content = typeof data === "string" ? new TextEncoder().encode(data) : data;
        const size = content.byteLength;
        const etag = await createEtag(content);

        // we may need to check if the directory exists
        // but as we don't store directories explicitly, we can skip it for now

        await this.$insert
            .values({
                path: filePath,
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
        const filePath = normalizePathLike(path);
        const encoding = options?.encoding;
        const file = await this.$select
            .select("content")
            .where("path", "=", filePath)
            .executeTakeFirst();

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
}

export function removeSuffixSlash(input: string) {
    while (input.endsWith("/")) {
        input = input.replace(/\/$/, "");
    }
    return input;
}

export function normalizePathLike(path: PathLike): string {
    let pathStr = String(path);
    pathStr = normalize(pathStr);
    return removeSuffixSlash(pathStr);
}

function encodePathForSQL(pathStr: string) {
    return pathStr.replace(/[\\%_]/g, "\\$&");
}

export async function createEtag(content: Uint8Array) {
    // async for future use
    const hash = createHash("sha256");
    hash.update(content);
    const etag = `"${hash.digest("hex")}"`;
    console.log({ etag });
    return etag;
}
