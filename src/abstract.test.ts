import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ETAG, FULL_PATH, IS_DIRECTORY, VDirent, VFSError, VStats } from "./abstract.ts";

describe("VFSError", () => {
  it("is an instance of Error", () => {
    const err = new VFSError("test", { code: "ENOENT", syscall: "stat", path: "/foo" });
    assert.ok(err instanceof Error);
  });

  it("has name VFSError", () => {
    const err = new VFSError("test", { code: "ENOENT", syscall: "stat", path: "/foo" });
    assert.equal(err.name, "VFSError");
  });

  it("sets code, syscall, path", () => {
    const err = new VFSError("no such file", { code: "ENOENT", syscall: "stat", path: "/foo" });
    assert.equal(err.code, "ENOENT");
    assert.equal(err.syscall, "stat");
    assert.equal(err.path, "/foo");
  });

  it("formats message correctly", () => {
    const err = new VFSError("no such file or directory", { code: "ENOENT", syscall: "stat", path: "/foo" });
    assert.ok(err.message.includes("ENOENT"));
    assert.ok(err.message.includes("stat"));
    assert.ok(err.message.includes("/foo"));
  });

  it("converts PathLike path to string", () => {
    const err = new VFSError("test", { code: "ENOENT", syscall: "stat", path: Buffer.from("/buf") });
    assert.equal(typeof err.path, "string");
  });
});

describe("VStats", () => {
  const baseArgs = { created_at: 1000, modified_at: 2000, size: 42 };

  it("isFile() returns true for file", () => {
    const s = new VStats(baseArgs, "/foo");
    assert.equal(s.isFile(), true);
    assert.equal(s.isDirectory(), false);
  });

  it("isDirectory() returns true for directory", () => {
    const s = new VStats(baseArgs, "/foo/", true);
    assert.equal(s.isDirectory(), true);
    assert.equal(s.isFile(), false);
  });

  it("stores size", () => {
    const s = new VStats(baseArgs, "/foo");
    assert.equal(s.size, 42);
  });

  it("stores timestamps as ms and Date", () => {
    const s = new VStats(baseArgs, "/foo");
    assert.equal(s.birthtimeMs, 1000);
    assert.equal(s.mtimeMs, 2000);
    assert.ok(s.birthtime instanceof Date);
    assert.ok(s.mtime instanceof Date);
  });

  it("stores FULL_PATH symbol", () => {
    const s = new VStats(baseArgs, "/foo/bar");
    assert.equal(s[FULL_PATH], "/foo/bar");
  });

  it("stores IS_DIRECTORY symbol", () => {
    const s = new VStats(baseArgs, "/foo/", true);
    assert.equal(s[IS_DIRECTORY], true);
  });

  it("stores ETAG symbol when provided", () => {
    const s = new VStats({ ...baseArgs, etag: '"abc"' }, "/foo");
    assert.equal(s[ETAG], '"abc"');
  });

  it("ETAG is undefined when not provided", () => {
    const s = new VStats(baseArgs, "/foo");
    assert.equal(s[ETAG], undefined);
  });

  it("other type checks return false", () => {
    const s = new VStats(baseArgs, "/foo");
    assert.equal(s.isBlockDevice(), false);
    assert.equal(s.isCharacterDevice(), false);
    assert.equal(s.isSymbolicLink(), false);
    assert.equal(s.isFIFO(), false);
    assert.equal(s.isSocket(), false);
  });
});

describe("VDirent", () => {
  it("extracts name from full path", () => {
    const d = new VDirent("/parent/", "/parent/file.txt");
    assert.equal(d.name, "file.txt");
  });

  it("extracts name for directory entry", () => {
    const d = new VDirent("/parent/", "/parent/subdir", true);
    assert.equal(d.name, "subdir");
  });

  it("isFile() returns true for file", () => {
    const d = new VDirent("/parent/", "/parent/file.txt");
    assert.equal(d.isFile(), true);
    assert.equal(d.isDirectory(), false);
  });

  it("isDirectory() returns true for directory", () => {
    const d = new VDirent("/parent/", "/parent/subdir", true);
    assert.equal(d.isDirectory(), true);
    assert.equal(d.isFile(), false);
  });

  it("stores FULL_PATH symbol", () => {
    const d = new VDirent("/parent/", "/parent/file.txt");
    assert.equal(d[FULL_PATH], "/parent/file.txt");
  });

  it("path getter returns parentPath", () => {
    const d = new VDirent("/root/", "/root/a/b.txt");
    assert.equal(d.path, d.parentPath);
  });

  it("other type checks return false", () => {
    const d = new VDirent("/parent/", "/parent/file.txt");
    assert.equal(d.isBlockDevice(), false);
    assert.equal(d.isCharacterDevice(), false);
    assert.equal(d.isSymbolicLink(), false);
    assert.equal(d.isFIFO(), false);
    assert.equal(d.isSocket(), false);
  });
});
