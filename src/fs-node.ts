import * as fs from "node:fs";
import { link } from "@ricsam/linkfs";
import type { FsSubset } from "./abstract.ts";
import { memfs, type NestedDirectoryJSON } from "memfs";

type FS = typeof fs;

/**
 * This make sure FsSubset is compatible with nodejs fs/promises
 */
export function createNodeFs(fsModule = fs): FsSubset {
  return {
    access: fsModule.promises.access,
    stat: fsModule.promises.stat,
    copyFile: fsModule.promises.copyFile,
    rename: fsModule.promises.rename,
    rmdir: fsModule.promises.rmdir,
    unlink: fsModule.promises.unlink,
    rm: fsModule.promises.rm,
    mkdir: fsModule.promises.mkdir,
    readdir: fsModule.promises.readdir,
    writeFile: fsModule.promises.writeFile,
    readFile: fsModule.promises.readFile,
    createReadStream: fsModule.createReadStream,
  };
}

export function createLinkFs(rewrites: string[] | string[][]): FsSubset {
  const lfs = link(fs, rewrites);
  return createNodeFs(lfs);
}

export function createMemFs(json?: NestedDirectoryJSON) {
  const { fs } = memfs(json);
  return createNodeFs(fs as unknown as FS);
}
