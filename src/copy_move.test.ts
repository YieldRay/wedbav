import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import {
  type CopyOperationResult,
  copyLikeOperation,
  multiStatusXML,
  normalizeDavPath,
  withTrailingSlash,
} from "./copy_move.ts";
import { createKyselyFs } from "./fs.ts";

function createFs() {
  const dialect = new LibsqlDialect({ url: ":memory:" });
  return createKyselyFs(dialect, { dbType: "sqlite" });
}

// Narrowing helpers so assertions read cleanly.
function assertOk(result: CopyOperationResult): asserts result is Extract<CopyOperationResult, { ok: true }> {
  assert.equal(result.ok, true, `expected ok result, got: ${JSON.stringify(result)}`);
}
function assertFail(result: CopyOperationResult): asserts result is Extract<CopyOperationResult, { ok: false }> {
  assert.equal(result.ok, false, `expected failure result, got: ${JSON.stringify(result)}`);
}

describe("normalizeDavPath", () => {
  const cases: [string, string][] = [
    ["", "/"],
    ["/", "/"],
    ["foo", "/foo"],
    ["/foo/", "/foo"],
    ["/foo//bar/", "/foo/bar"],
    ["/foo/./bar", "/foo/bar"],
    ["/foo/../bar", "/bar"],
    ["/a/b/c/", "/a/b/c"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => {
      assert.equal(normalizeDavPath(input), expected);
    });
  }
});

describe("withTrailingSlash", () => {
  it("keeps root as /", () => {
    assert.equal(withTrailingSlash("/"), "/");
  });
  it("adds a trailing slash", () => {
    assert.equal(withTrailingSlash("/foo"), "/foo/");
  });
  it("collapses multiple trailing slashes to one", () => {
    assert.equal(withTrailingSlash("/foo///"), "/foo/");
  });
});

describe("multiStatusXML", () => {
  it("renders a response element per error with encoded href", () => {
    const xml = multiStatusXML([{ href: "/@dst/file.txt", status: 409, description: "boom" }]);
    assert.ok(xml.includes("<d:multistatus"));
    assert.ok(xml.includes("<d:href>/%40dst/file.txt</d:href>"), xml);
    assert.ok(xml.includes("HTTP/1.1 409"), xml);
    assert.ok(xml.includes("<d:responsedescription>boom</d:responsedescription>"), xml);
  });

  it("escapes XML special characters in the description", () => {
    const xml = multiStatusXML([{ href: "/x", status: 500, description: "a & b < c" }]);
    assert.ok(xml.includes("a &amp; b &lt; c"), xml);
  });

  it("omits responsedescription when none is provided", () => {
    const xml = multiStatusXML([{ href: "/x", status: 403 }]);
    assert.ok(!xml.includes("<d:responsedescription>"), xml);
  });
});

describe("copyLikeOperation — COPY", () => {
  it("copies a single file", async () => {
    const fs = createFs();
    await fs.writeFile("/src.txt", "hello");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "COPY",
    });
    assertOk(result);
    assert.equal(result.destinationExisted, false);
    assert.equal((await fs.readFile("/dst.txt")).toString(), "hello");
    // source intact
    assert.equal((await fs.readFile("/src.txt")).toString(), "hello");
  });

  it("copies a directory tree recursively (depth Infinity)", async () => {
    const fs = createFs();
    await fs.writeFile("/a/b/c.txt", "c");
    await fs.writeFile("/a/d.txt", "d");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/a/",
      destinationPath: "/copy/",
      depth: Infinity,
      overwrite: false,
      type: "COPY",
    });
    assertOk(result);
    assert.equal((await fs.readFile("/copy/b/c.txt")).toString(), "c");
    assert.equal((await fs.readFile("/copy/d.txt")).toString(), "d");
    // source preserved
    assert.equal((await fs.readFile("/a/b/c.txt")).toString(), "c");
  });

  it("depth 0 copies only the collection, not its children", async () => {
    const fs = createFs();
    await fs.writeFile("/a/child.txt", "x");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/a/",
      destinationPath: "/shallow/",
      depth: 0,
      overwrite: false,
      type: "COPY",
    });
    assertOk(result);
    assert.equal((await fs.stat("/shallow")).isDirectory(), true);
    await assert.rejects(() => fs.stat("/shallow/child.txt"), "children must not be copied at depth 0");
  });

  it("returns 412 when destination exists and overwrite is false", async () => {
    const fs = createFs();
    await fs.writeFile("/src.txt", "new");
    await fs.writeFile("/dst.txt", "old");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "COPY",
    });
    assertFail(result);
    assert.equal(result.status, 412);
    // destination untouched
    assert.equal((await fs.readFile("/dst.txt")).toString(), "old");
  });

  it("overwrites the destination when overwrite is true", async () => {
    const fs = createFs();
    await fs.writeFile("/src.txt", "new");
    await fs.writeFile("/dst.txt", "old");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/dst.txt",
      depth: Infinity,
      overwrite: true,
      type: "COPY",
    });
    assertOk(result);
    assert.equal(result.destinationExisted, true);
    assert.equal((await fs.readFile("/dst.txt")).toString(), "new");
  });

  it("returns 404 when the source does not exist", async () => {
    const fs = createFs();
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/missing.txt",
      destinationPath: "/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "COPY",
    });
    assertFail(result);
    assert.equal(result.status, 404);
  });

  it("returns 403 when source and destination are the same", async () => {
    const fs = createFs();
    await fs.writeFile("/same.txt", "x");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/same.txt",
      destinationPath: "/same.txt",
      depth: Infinity,
      overwrite: true,
      type: "COPY",
    });
    assertFail(result);
    assert.equal(result.status, 403);
  });

  it("returns 403 when copying a collection into itself", async () => {
    const fs = createFs();
    await fs.writeFile("/a/f.txt", "x");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/a/",
      destinationPath: "/a/nested/",
      depth: Infinity,
      overwrite: true,
      type: "COPY",
    });
    assertFail(result);
    assert.equal(result.status, 403);
  });

  it("returns 403 when destination is the root collection", async () => {
    const fs = createFs();
    await fs.writeFile("/a/f.txt", "x");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/a/",
      destinationPath: "/",
      depth: Infinity,
      overwrite: true,
      type: "COPY",
    });
    assertFail(result);
    assert.equal(result.status, 403);
  });

  it("returns 409 when the destination parent does not exist", async () => {
    const fs = createFs();
    await fs.writeFile("/src.txt", "x");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/no/such/parent/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "COPY",
    });
    assertFail(result);
    assert.equal(result.status, 409);
  });
});

describe("copyLikeOperation — MOVE", () => {
  it("moves a single file (source removed)", async () => {
    const fs = createFs();
    await fs.writeFile("/src.txt", "data");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "MOVE",
    });
    assertOk(result);
    assert.equal((await fs.readFile("/dst.txt")).toString(), "data");
    await assert.rejects(() => fs.stat("/src.txt"), "source must be gone after MOVE");
  });

  it("moves a directory tree", async () => {
    const fs = createFs();
    await fs.writeFile("/a/b/c.txt", "c");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/a/",
      destinationPath: "/moved/",
      depth: Infinity,
      overwrite: false,
      type: "MOVE",
    });
    assertOk(result);
    assert.equal((await fs.readFile("/moved/b/c.txt")).toString(), "c");
    await assert.rejects(() => fs.stat("/a/b/c.txt"));
  });

  it("returns 412 when moving onto an existing destination without overwrite", async () => {
    const fs = createFs();
    await fs.writeFile("/src.txt", "new");
    await fs.writeFile("/dst.txt", "old");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "MOVE",
    });
    assertFail(result);
    assert.equal(result.status, 412);
    // both intact after refusal
    assert.equal((await fs.readFile("/src.txt")).toString(), "new");
    assert.equal((await fs.readFile("/dst.txt")).toString(), "old");
  });
});
