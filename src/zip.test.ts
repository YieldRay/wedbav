import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unzipSync, zipSync } from "fflate";
import { createKyselyFs } from "./fs.ts";
import { createMemFs } from "./fs-node.ts";
import { createTestDialect } from "./test-helpers.ts";
import { createHono } from "./wedbav.ts";
import { unzipInto, zipDirectory } from "./zip.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array | undefined) => new TextDecoder().decode(u ?? new Uint8Array());
const AUTH = `Basic ${btoa("test:test")}`;

async function createApp() {
  const fs = createKyselyFs(createTestDialect(), { dbType: "sqlite" });
  await fs.ready();
  const app = createHono(fs, { browser: "public", auth: () => true });
  return { app, fs };
}

describe("zipDirectory / unzipInto (library)", () => {
  it("zips a directory tree including empty directories", async () => {
    const { fs } = await createApp();
    await fs.writeFile("/proj/a.txt", enc("AAA"));
    await fs.writeFile("/proj/sub/b.txt", enc("BBB"));
    await fs.mkdir("/proj/empty", { recursive: true });

    const zip = await zipDirectory(fs, "/proj/");
    const unz = unzipSync(zip);

    assert.deepEqual(Object.keys(unz).sort(), ["a.txt", "empty/", "sub/", "sub/b.txt"]);
    assert.equal(dec(unz["a.txt"]), "AAA");
    assert.equal(dec(unz["sub/b.txt"]), "BBB");
  });

  it("round-trips a tree through zip → unzip into a new dir", async () => {
    const { fs } = await createApp();
    await fs.writeFile("/src/one.txt", enc("1"));
    await fs.writeFile("/src/deep/two.txt", enc("2"));

    const zip = await zipDirectory(fs, "/src/");
    await unzipInto(fs, "/dest/", zip);

    assert.equal(await fs.readFile("/dest/one.txt", { encoding: "utf-8" }), "1");
    assert.equal(await fs.readFile("/dest/deep/two.txt", { encoding: "utf-8" }), "2");
  });

  it("creates empty directory entries on unzip", async () => {
    const { fs } = await createApp();
    const zip = zipSync({ "keep/": new Uint8Array(), "f.txt": enc("x") });
    await unzipInto(fs, "/out/", zip);

    assert.equal((await fs.stat("/out/keep/")).isDirectory(), true);
    assert.equal(await fs.readFile("/out/f.txt", { encoding: "utf-8" }), "x");
  });

  it("rejects zip-slip entries (parent traversal)", async () => {
    const { fs } = await createApp();
    const zip = zipSync({ "../escape.txt": enc("nope") });
    await assert.rejects(() => unzipInto(fs, "/out/", zip), /unsafe zip entry/);
  });

  it("rejects zip-slip entries (absolute path escaping via ..)", async () => {
    const { fs } = await createApp();
    const zip = zipSync({ "a/../../escape.txt": enc("nope") });
    await assert.rejects(() => unzipInto(fs, "/out/", zip), /unsafe zip entry/);
  });
});

// A memfs-backed FsSubset has no _writeDirMany/_readDirMany, so it exercises the
// mkdir+writeFile / readdir+readFile fallback paths in zip.ts.
describe("unzipInto fallback (no batch helpers)", () => {
  it("creates missing parent directories for nested files (no explicit dir entries)", async () => {
    const fs = createMemFs({ "/out": null });
    // Only file entries, no "nested/" directory entry — regression for ENOENT.
    const zip = zipSync({ "top.txt": enc("T"), "nested/deep/y.txt": enc("Y") });
    await unzipInto(fs, "/out/", zip);

    assert.equal(dec(await fs.readFile("/out/top.txt")), "T");
    assert.equal(dec(await fs.readFile("/out/nested/deep/y.txt")), "Y");
  });

  it("handles explicit directory entries and empty dirs", async () => {
    const fs = createMemFs({ "/out": null });
    const zip = zipSync({ "keep/": new Uint8Array(), "a/b.txt": enc("B") });
    await unzipInto(fs, "/out/", zip);

    assert.equal((await fs.stat("/out/keep")).isDirectory(), true);
    assert.equal(dec(await fs.readFile("/out/a/b.txt")), "B");
  });

  it("zipDirectory falls back to recursive readdir+readFile", async () => {
    const fs = createMemFs({ "/src": { "one.txt": "1", deep: { "two.txt": "2" } } });
    const zip = await zipDirectory(fs, "/src/");
    const unz = unzipSync(zip);
    assert.equal(dec(unz["one.txt"]), "1");
    assert.equal(dec(unz["deep/two.txt"]), "2");
  });
});

describe("zip HTTP handlers (?action=download / ?action=extract)", () => {
  it("GET /dir/?action=download returns a zip archive", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/docs/a.txt", enc("AAA"));
    await fs.writeFile("/docs/sub/b.txt", enc("BBB"));

    const res = await app.request("/docs/?action=download");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition") ?? "", /filename="docs\.zip"/);

    const unz = unzipSync(new Uint8Array(await res.arrayBuffer()));
    assert.equal(dec(unz["a.txt"]), "AAA");
    assert.equal(dec(unz["sub/b.txt"]), "BBB");
  });

  it("GET /file?action=download forces an attachment download", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/doc.txt", enc("hello"));
    const res = await app.request("/doc.txt?action=download");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="doc\.txt"/);
    assert.equal(await res.text(), "hello");
  });

  it("GET download on a missing directory returns 404", async () => {
    const { app } = await createApp();
    const res = await app.request("/nope/?action=download");
    assert.equal(res.status, 404);
  });

  it("PUT /dir/?action=extract unzips the body", async () => {
    const { app, fs } = await createApp();
    const zip = zipSync({ "x.txt": enc("XXX"), "nested/y.txt": enc("YYY"), "d/": new Uint8Array() });

    const res = await app.request("/dest/?action=extract", {
      method: "PUT",
      headers: { "Content-Type": "application/zip", Authorization: AUTH },
      body: zip,
    });
    assert.equal(res.status, 201);
    assert.equal(await fs.readFile("/dest/x.txt", { encoding: "utf-8" }), "XXX");
    assert.equal(await fs.readFile("/dest/nested/y.txt", { encoding: "utf-8" }), "YYY");
    assert.equal((await fs.stat("/dest/d/")).isDirectory(), true);
  });

  it("PUT extract with a zip-slip entry returns 400", async () => {
    const { app } = await createApp();
    const zip = zipSync({ "../escape.txt": enc("nope") });
    const res = await app.request("/dest/?action=extract", {
      method: "PUT",
      headers: { "Content-Type": "application/zip", Authorization: AUTH },
      body: zip,
    });
    assert.equal(res.status, 400);
  });

  it("PUT extract with a malformed archive returns 400", async () => {
    const { app } = await createApp();
    const res = await app.request("/dest/?action=extract", {
      method: "PUT",
      headers: { "Content-Type": "application/zip", Authorization: AUTH },
      body: enc("not a zip"),
    });
    assert.equal(res.status, 400);
  });

  it("GET download is auth-gated when list is private", async () => {
    const fs = createKyselyFs(createTestDialect(), { dbType: "sqlite" });
    await fs.ready();
    await fs.writeFile("/docs/a.txt", enc("A"));
    const app = createHono(fs, { browser: "public", list: "private", auth: (u, p) => u === "u" && p === "p" });

    const unauth = await app.request("/docs/?action=download");
    assert.equal(unauth.status, 401);

    const ok = await app.request("/docs/?action=download", {
      headers: { Authorization: `Basic ${btoa("u:p")}` },
    });
    assert.equal(ok.status, 200);
  });
});
