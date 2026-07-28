import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FsSubset } from "./abstract.ts";
import { VFSError } from "./abstract.ts";
import {
  type CopyOperationResult,
  copyLikeOperation,
  multiStatusXML,
  normalizeDavPath,
  parseDestination,
  resolveCopyDepth,
  withTrailingSlash,
} from "./copy_move.ts";
import { createKyselyFs } from "./fs.ts";
import { createTestDialect } from "./test-helpers.ts";
import { createHono } from "./wedbav.ts";

function createFs() {
  return createKyselyFs(createTestDialect(), { dbType: "sqlite" });
}

// A ready Hono app backed by a fresh SQLite fs. auth: () => true avoids env 401s.
async function createApp() {
  const fs = createFs();
  await fs.ready();
  const app = createHono(fs, { browser: false, auth: () => true });
  return { app, fs };
}

function davReq(method: "COPY" | "MOVE", from: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${from}`, {
    method,
    headers: { Authorization: `Basic ${btoa("x:y")}`, ...headers },
  });
}

// Minimal FsSubset stub: every method throws unless explicitly overridden. Lets
// us drive the error branches of copyLikeOperation deterministically.
function stubFs(overrides: Partial<FsSubset>): FsSubset {
  const notImplemented = (name: string) => () => Promise.reject(new Error(`stubFs.${name} not implemented`));
  return {
    access: notImplemented("access"),
    stat: notImplemented("stat"),
    copyFile: notImplemented("copyFile"),
    rename: notImplemented("rename"),
    rmdir: notImplemented("rmdir"),
    unlink: notImplemented("unlink"),
    rm: notImplemented("rm"),
    mkdir: notImplemented("mkdir"),
    readdir: notImplemented("readdir"),
    writeFile: notImplemented("writeFile"),
    readFile: notImplemented("readFile"),
    createReadStream: () => {
      throw new Error("stubFs.createReadStream not implemented");
    },
    ...overrides,
  } as FsSubset;
}

function errno(code: string, syscall = "test", path = "/x") {
  return new VFSError("stub error", { code, syscall, path });
}

function onlyError(result: Extract<CopyOperationResult, { ok: true }>) {
  assert.equal(result.errors.length, 1);
  const first = result.errors[0];
  assert.ok(first, "expected a single per-resource error");
  return first;
}

type Stat = Awaited<ReturnType<FsSubset["stat"]>>;
const dirStat = { isDirectory: () => true, isFile: () => false } as unknown as Stat;
const fileStat = { isDirectory: () => false, isFile: () => true } as unknown as Stat;

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

describe("parseDestination", () => {
  const base = new URL("http://host/src.txt");

  it("returns 400 when the Destination header is missing", () => {
    const r = parseDestination(undefined, base);
    assert.deepEqual(r, { status: 400, message: "Bad Request: Destination header is required" });
  });

  it("returns 502 when the destination is on a different origin", () => {
    const r = parseDestination("http://other-host/dst.txt", base);
    assert.equal(typeof r, "object");
    assert.equal((r as { status: number }).status, 502);
  });

  it("resolves an absolute-path destination to a decoded pathname", () => {
    assert.equal(parseDestination("/a/b%20c.txt", base), "/a/b c.txt");
  });

  it("resolves a full-URL destination on the same origin", () => {
    assert.equal(parseDestination("http://host/moved.txt", base), "/moved.txt");
  });
});

describe("resolveCopyDepth", () => {
  it('maps "0" to 0', () => {
    assert.equal(resolveCopyDepth("0"), 0);
  });
  it("maps undefined to Infinity", () => {
    assert.equal(resolveCopyDepth(undefined), Infinity);
  });
  it('maps "infinity" and other values to Infinity', () => {
    assert.equal(resolveCopyDepth("infinity"), Infinity);
    assert.equal(resolveCopyDepth("1"), Infinity);
  });
});

describe("handleCopyMoveRequest (HTTP)", () => {
  it("400 when Destination header is missing", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/src.txt", "x");
    const res = await app.request(davReq("COPY", "/src.txt"));
    assert.equal(res.status, 400);
  });

  it("502 when Destination is on a different origin", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/src.txt", "x");
    const res = await app.request(davReq("COPY", "/src.txt", { Destination: "http://elsewhere/dst.txt" }));
    assert.equal(res.status, 502);
  });

  it("404 when the source does not exist", async () => {
    const { app } = await createApp();
    const res = await app.request(davReq("COPY", "/missing.txt", { Destination: "/dst.txt" }));
    assert.equal(res.status, 404);
  });

  it("propagates a non-errno error from the source stat (500)", async () => {
    // A genuine (non-filesystem) error must not be masked as 404.
    const fs = stubFs({
      stat: async () => {
        throw new Error("db exploded");
      },
    });
    const app = createHono(fs, { browser: false, auth: () => true });
    const res = await app.request(davReq("COPY", "/src.txt", { Destination: "/dst.txt" }));
    assert.equal(res.status, 500);
  });

  it("201 Created with a Location header for a fresh COPY", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/src.txt", "hi");
    const res = await app.request(davReq("COPY", "/src.txt", { Destination: "/dst.txt" }));
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("Location"), "/dst.txt");
    assert.equal((await fs.readFile("/dst.txt")).toString(), "hi");
  });

  it("204 when a COPY overwrites an existing destination", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/src.txt", "new");
    await fs.writeFile("/dst.txt", "old");
    const res = await app.request(davReq("COPY", "/src.txt", { Destination: "/dst.txt", Overwrite: "T" }));
    assert.equal(res.status, 204);
    assert.equal((await fs.readFile("/dst.txt")).toString(), "new");
  });

  it("412 when a COPY would overwrite but Overwrite: F", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/src.txt", "new");
    await fs.writeFile("/dst.txt", "old");
    const res = await app.request(davReq("COPY", "/src.txt", { Destination: "/dst.txt", Overwrite: "F" }));
    assert.equal(res.status, 412);
    assert.equal((await fs.readFile("/dst.txt")).toString(), "old");
  });

  it("COPY with Depth: 0 copies only the collection", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/dir/child.txt", "x");
    const res = await app.request(davReq("COPY", "/dir/", { Destination: "/shallow/", Depth: "0" }));
    assert.equal(res.status, 201);
    assert.equal((await fs.stat("/shallow")).isDirectory(), true);
    await assert.rejects(() => fs.stat("/shallow/child.txt"));
  });

  it("MOVE relocates a file and reports 201", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/src.txt", "data");
    const res = await app.request(davReq("MOVE", "/src.txt", { Destination: "/dst.txt" }));
    assert.equal(res.status, 201);
    assert.equal((await fs.readFile("/dst.txt")).toString(), "data");
    await assert.rejects(() => fs.stat("/src.txt"));
  });

  it("403 when MOVE targets the root collection", async () => {
    const { app } = await createApp();
    const res = await app.request(davReq("MOVE", "/", { Destination: "/dst/" }));
    assert.equal(res.status, 403);
  });

  it("400 when MOVE on a collection uses a non-infinity Depth", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/dir/f.txt", "x");
    const res = await app.request(davReq("MOVE", "/dir/", { Destination: "/moved/", Depth: "0" }));
    assert.equal(res.status, 400);
  });

  it("allows MOVE on a collection with Depth: infinity", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/dir/f.txt", "x");
    const res = await app.request(davReq("MOVE", "/dir/", { Destination: "/moved/", Depth: "Infinity" }));
    assert.equal(res.status, 201);
    assert.equal((await fs.readFile("/moved/f.txt")).toString(), "x");
  });

  it("returns a 207 multistatus body when a child copy fails", async () => {
    // Stub fs: the collection copies, but one child file fails to copy.
    const fs = stubFs({
      stat: async (p) => {
        const s = String(p);
        if (s === "/dir" || s === "/dir/") return dirStat;
        throw errno("ENOENT", "stat", s);
      },
      mkdir: async () => undefined,
      readdir: (async () => [{ name: "bad.txt", isDirectory: () => false }]) as unknown as FsSubset["readdir"],
      copyFile: async () => {
        throw errno("EACCES", "copyfile", "/copy/bad.txt");
      },
    });
    const app = createHono(fs, { browser: false, auth: () => true });
    const res = await app.request(davReq("COPY", "/dir/", { Destination: "/copy/", Overwrite: "T" }));
    assert.equal(res.status, 207);
    assert.match(res.headers.get("Content-Type") ?? "", /application\/xml/);
    const body = await res.text();
    assert.match(body, /<d:multistatus/);
    assert.match(body, /403/); // EACCES → 403
  });

  it("copyLikeOperation surfaces the failing child via errors[]", async () => {
    const fs = stubFs({
      stat: async (p) => {
        const s = String(p);
        if (s === "/dir" || s === "/dir/") return dirStat;
        throw errno("ENOENT", "stat", s);
      },
      mkdir: async () => undefined,
      readdir: (async () => [{ name: "bad.txt", isDirectory: () => false }]) as unknown as FsSubset["readdir"],
      copyFile: async () => {
        throw errno("EACCES", "copyfile", "/copy/bad.txt");
      },
    });
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/dir/",
      destinationPath: "/copy/",
      depth: Infinity,
      overwrite: true,
      type: "COPY",
    });
    assertOk(result);
    assert.equal(onlyError(result).status, 403); // EACCES → 403
  });
});

describe("copyLikeOperation — error branches", () => {
  it("stats the source itself when providedSourceStat is omitted", async () => {
    const fs = createFs();
    await fs.writeFile("/src.txt", "hi");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "COPY",
      // no providedSourceStat → forces the internal fs.stat(sourcePath) path
    });
    assertOk(result);
    assert.equal((await fs.readFile("/dst.txt")).toString(), "hi");
  });

  it("409 when the destination parent does not exist (fs-backed)", async () => {
    const fs = createFs();
    await fs.writeFile("/src.txt", "x");
    await fs.writeFile("/notadir", "iamafile");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/notadir/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "COPY",
    });
    assertFail(result);
    assert.equal(result.status, 409);
  });

  it("409 when the destination parent exists but is not a collection", async () => {
    // Parent stat resolves to a file → the "not a collection" branch.
    const fs = stubFs({
      stat: async (p) => {
        const s = String(p);
        if (s === "/src.txt") return fileStat;
        if (s === "/notadir/") return fileStat; // parent exists, but is a file
        throw errno("ENOENT", "stat", s);
      },
    });
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/notadir/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "COPY",
    });
    assertFail(result);
    assert.equal(result.status, 409);
    assert.match(result.message, /not a collection/);
  });

  it("maps an errno failure while removing the destination to an HTTP status", async () => {
    const fs = stubFs({
      stat: async () => fileStat, // source, parent, destination all "exist"
      rm: async () => {
        throw errno("EPERM", "rm", "/dst.txt");
      },
    });
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/dst.txt",
      depth: Infinity,
      overwrite: true,
      type: "COPY",
    });
    assertFail(result);
    assert.equal(result.status, 403); // EPERM → 403
    assert.equal(result.message, "Failed to remove destination before copy");
  });

  it("maps an errno failure from copyFile", async () => {
    const fs = stubFs({
      stat: async (p) => {
        if (String(p) === "/src.txt") return fileStat;
        throw errno("ENOENT", "stat", String(p)); // destination absent
      },
      copyFile: async () => {
        throw errno("ENOSPC", "copyfile", "/dst.txt");
      },
    });
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "COPY",
    });
    assertFail(result);
    assert.equal(result.status, 507); // ENOSPC → 507
  });

  it("maps an errno failure from rename (MOVE)", async () => {
    const fs = stubFs({
      stat: async (p) => {
        if (String(p) === "/src.txt") return fileStat;
        throw errno("ENOENT", "stat", String(p));
      },
      rename: async () => {
        throw errno("EISDIR", "rename", "/dst.txt");
      },
    });
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/src.txt",
      destinationPath: "/dst.txt",
      depth: Infinity,
      overwrite: false,
      type: "MOVE",
    });
    assertFail(result);
    assert.equal(result.status, 409); // EISDIR → 409
  });

  it("re-throws non-errno errors from the source stat", async () => {
    const fs = stubFs({
      stat: async () => {
        throw new Error("kaboom");
      },
    });
    await assert.rejects(
      () =>
        copyLikeOperation({
          fs,
          sourcePath: "/src.txt",
          destinationPath: "/dst.txt",
          depth: Infinity,
          overwrite: false,
          type: "COPY",
        }),
      /kaboom/,
    );
  });

  it("re-throws non-errno errors from the destination existence check", async () => {
    let calls = 0;
    const fs = stubFs({
      stat: async () => {
        calls++;
        if (calls === 1) return fileStat; // source stat OK (parent is root, skipped)
        throw new Error("existence-boom"); // destination existence check blows up
      },
    });
    await assert.rejects(
      () =>
        copyLikeOperation({
          fs,
          sourcePath: "/src.txt",
          destinationPath: "/dst.txt",
          depth: Infinity,
          overwrite: true,
          type: "COPY",
        }),
      /existence-boom/,
    );
  });

  it("records a multistatus error when the destination directory can't be created", async () => {
    const fs = stubFs({
      stat: async (p) => {
        const s = String(p);
        if (s === "/dir" || s === "/dir/") return dirStat;
        throw errno("ENOENT", "stat", s);
      },
      mkdir: async () => {
        throw errno("EEXIST", "mkdir", "/copy/");
      },
    });
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/dir/",
      destinationPath: "/copy/",
      depth: Infinity,
      overwrite: true,
      type: "COPY",
    });
    assertOk(result);
    assert.equal(onlyError(result).status, 400); // EEXIST → 400
  });

  it("records a multistatus error when the source directory can't be read", async () => {
    const fs = stubFs({
      stat: async (p) => {
        const s = String(p);
        if (s === "/dir" || s === "/dir/") return dirStat;
        throw errno("ENOENT", "stat", s);
      },
      mkdir: async () => undefined,
      readdir: (async () => {
        throw errno("ENOTDIR", "readdir", "/dir/");
      }) as unknown as FsSubset["readdir"],
    });
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/dir/",
      destinationPath: "/copy/",
      depth: Infinity,
      overwrite: true,
      type: "COPY",
    });
    assertOk(result);
    assert.equal(onlyError(result).status, 409); // ENOTDIR → 409
  });

  it("recurses into nested subdirectories, decrementing finite depth", async () => {
    const fs = createFs();
    await fs.writeFile("/a/b/c/deep.txt", "deep");
    const result = await copyLikeOperation({
      fs,
      sourcePath: "/a/",
      destinationPath: "/copy/",
      depth: 2, // /a -> /a/b -> stop before copying c's contents
      overwrite: false,
      type: "COPY",
    });
    assertOk(result);
    assert.equal((await fs.stat("/copy/b")).isDirectory(), true);
    await assert.rejects(() => fs.stat("/copy/b/c/deep.txt"), "depth 2 must not copy the third level's files");
  });
});
