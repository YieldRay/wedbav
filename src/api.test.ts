import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { createHonoAPI } from "./api.ts";
import { createKyselyFs } from "./fs.ts";

function createApi(options: { readOnly?: boolean } = {}) {
  const dialect = new LibsqlDialect({ url: ":memory:" });
  const fs = createKyselyFs(dialect, { dbType: "sqlite" });
  const app = createHonoAPI(fs, { prefix: "/fs", readOnly: options.readOnly ?? false });
  return { app, fs };
}

// All API routes require `Accept: application/json`; otherwise the router's
// getPath resolves to an UNREACHABLE path and the request 404s.
function post(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const fromB64 = (s: string) => Buffer.from(s, "base64").toString();

describe("API Accept gating", () => {
  it("ignores requests without Accept: application/json", async () => {
    const { app } = createApi();
    const res = await app.request(
      new Request("http://localhost/stat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/" }),
      }),
    );
    assert.equal(res.status, 404);
  });
});

describe("API /stat", () => {
  it("returns type 2 for a directory", async () => {
    const { app, fs } = createApi();
    await fs.mkdir("/d");
    const res = await app.request(post("/stat", { path: "/d" }));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { type: number; size: number };
    assert.equal(json.type, 2);
  });

  it("returns type 1 and byte size for a file", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/f.txt", "你好"); // 6 UTF-8 bytes
    const res = await app.request(post("/stat", { path: "/f.txt" }));
    const json = (await res.json()) as { type: number; size: number };
    assert.equal(json.type, 1);
    assert.equal(json.size, 6);
  });

  it("returns 404 for a missing path", async () => {
    const { app } = createApi();
    const res = await app.request(post("/stat", { path: "/missing" }));
    assert.equal(res.status, 404);
  });

  it("marks permissions readonly when configured", async () => {
    const { app, fs } = createApi({ readOnly: true });
    await fs.writeFile("/f.txt", "x");
    const res = await app.request(post("/stat", { path: "/f.txt" }));
    const json = (await res.json()) as { permissions?: number };
    assert.equal(json.permissions, 1);
  });
});

describe("API /readDirectory", () => {
  it("lists entries with correct types", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/dir/file.txt", "x");
    await fs.mkdir("/dir/sub");
    const res = await app.request(post("/readDirectory", { path: "/dir" }));
    assert.equal(res.status, 200);
    const items = (await res.json()) as { name: string; type: number }[];
    const byName = new Map(items.map((i) => [i.name, i.type]));
    assert.equal(byName.get("file.txt"), 1);
    assert.equal(byName.get("sub"), 2);
  });

  it("returns 404 for a missing directory", async () => {
    const { app } = createApi();
    const res = await app.request(post("/readDirectory", { path: "/nope" }));
    assert.equal(res.status, 404);
  });
});

describe("API /createDirectory", () => {
  it("creates a directory", async () => {
    const { app, fs } = createApi();
    const res = await app.request(post("/createDirectory", { path: "/new" }));
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { success: boolean }).success, true);
    assert.equal((await fs.stat("/new")).isDirectory(), true);
  });

  it("refuses when readOnly", async () => {
    const { app } = createApi({ readOnly: true });
    const res = await app.request(post("/createDirectory", { path: "/new" }));
    assert.equal(res.status, 400);
  });
});

describe("API /writeFile and /readFile", () => {
  it("round-trips base64 content", async () => {
    const { app } = createApi();
    const w = await app.request(post("/writeFile", { path: "/rt.txt", b64: b64("round trip") }));
    assert.equal(w.status, 200);
    const r = await app.request(post("/readFile", { path: "/rt.txt" }));
    assert.equal(r.status, 200);
    const json = (await r.json()) as { success: boolean; b64: string };
    assert.equal(fromB64(json.b64), "round trip");
  });

  it("creates parent directories automatically", async () => {
    const { app, fs } = createApi();
    const w = await app.request(post("/writeFile", { path: "/deep/nested/file.txt", b64: b64("x") }));
    assert.equal(w.status, 200);
    assert.equal((await fs.stat("/deep/nested")).isDirectory(), true);
  });

  it("respects create:false when the file does not exist", async () => {
    const { app } = createApi();
    const res = await app.request(
      post("/writeFile", { path: "/no.txt", b64: b64("x"), options: { create: false, overwrite: true } }),
    );
    assert.equal(res.status, 404);
  });

  it("respects overwrite:false when the file exists", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/exists.txt", "old");
    const res = await app.request(
      post("/writeFile", { path: "/exists.txt", b64: b64("new"), options: { create: true, overwrite: false } }),
    );
    assert.equal(res.status, 400);
    assert.equal((await fs.readFile("/exists.txt")).toString(), "old");
  });

  it("refuses writeFile when readOnly", async () => {
    const { app } = createApi({ readOnly: true });
    const res = await app.request(post("/writeFile", { path: "/ro.txt", b64: b64("x") }));
    assert.equal(res.status, 400);
  });

  it("readFile returns 404 for a missing file", async () => {
    const { app } = createApi();
    const res = await app.request(post("/readFile", { path: "/gone.txt" }));
    assert.equal(res.status, 404);
  });
});

describe("API /copy", () => {
  it("copies a file", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/src.txt", "data");
    const res = await app.request(post("/copy", { source: "/src.txt", destination: "/dst.txt" }));
    assert.equal(res.status, 200);
    assert.equal((await fs.readFile("/dst.txt")).toString(), "data");
  });

  it("copies a directory tree", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/a/b/c.txt", "c");
    const res = await app.request(post("/copy", { source: "/a/", destination: "/copy/" }));
    assert.equal(res.status, 200);
    assert.equal((await fs.readFile("/copy/b/c.txt")).toString(), "c");
  });

  it("refuses to overwrite without the overwrite option", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/src.txt", "new");
    await fs.writeFile("/dst.txt", "old");
    const res = await app.request(post("/copy", { source: "/src.txt", destination: "/dst.txt" }));
    assert.equal(res.status, 400);
    assert.equal((await fs.readFile("/dst.txt")).toString(), "old");
  });

  it("overwrites when the overwrite option is set", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/src.txt", "new");
    await fs.writeFile("/dst.txt", "old");
    const res = await app.request(
      post("/copy", { source: "/src.txt", destination: "/dst.txt", options: { overwrite: true } }),
    );
    assert.equal(res.status, 200);
    assert.equal((await fs.readFile("/dst.txt")).toString(), "new");
  });

  it("returns 404 when the source does not exist", async () => {
    const { app } = createApi();
    const res = await app.request(post("/copy", { source: "/missing", destination: "/dst" }));
    assert.equal(res.status, 404);
  });
});

describe("API /rename", () => {
  it("renames a file", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/old.txt", "data");
    const res = await app.request(post("/rename", { oldPath: "/old.txt", newPath: "/new.txt" }));
    assert.equal(res.status, 200);
    assert.equal((await fs.readFile("/new.txt")).toString(), "data");
    await assert.rejects(() => fs.stat("/old.txt"));
  });

  it("is a no-op when old and new are the same", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/same.txt", "x");
    const res = await app.request(post("/rename", { oldPath: "/same.txt", newPath: "/same.txt" }));
    assert.equal(res.status, 200);
    assert.equal((await fs.readFile("/same.txt")).toString(), "x");
  });

  it("returns 404 when the source does not exist", async () => {
    const { app } = createApi();
    const res = await app.request(post("/rename", { oldPath: "/ghost.txt", newPath: "/x.txt" }));
    assert.equal(res.status, 404);
  });

  it("refuses to overwrite an existing target without the option", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/a.txt", "a");
    await fs.writeFile("/b.txt", "b");
    const res = await app.request(post("/rename", { oldPath: "/a.txt", newPath: "/b.txt" }));
    assert.equal(res.status, 400);
    // both still present
    assert.equal((await fs.readFile("/a.txt")).toString(), "a");
    assert.equal((await fs.readFile("/b.txt")).toString(), "b");
  });

  it("overwrites the target when the option is set", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/a.txt", "a");
    await fs.writeFile("/b.txt", "b");
    const res = await app.request(
      post("/rename", { oldPath: "/a.txt", newPath: "/b.txt", options: { overwrite: true } }),
    );
    assert.equal(res.status, 200);
    assert.equal((await fs.readFile("/b.txt")).toString(), "a");
    await assert.rejects(() => fs.stat("/a.txt"));
  });
});

describe("API /delete", () => {
  it("deletes a file", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/del.txt", "x");
    const res = await app.request(post("/delete", { path: "/del.txt" }));
    assert.equal(res.status, 200);
    await assert.rejects(() => fs.stat("/del.txt"));
  });

  it("returns 404 for a missing path", async () => {
    const { app } = createApi();
    const res = await app.request(post("/delete", { path: "/gone.txt" }));
    assert.equal(res.status, 404);
  });

  it("returns 409 for a non-empty directory without recursive", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/dir/child.txt", "x");
    const res = await app.request(post("/delete", { path: "/dir" }));
    assert.equal(res.status, 409);
  });

  it("deletes a directory recursively when requested", async () => {
    const { app, fs } = createApi();
    await fs.writeFile("/dir/child.txt", "x");
    const res = await app.request(post("/delete", { path: "/dir", options: { recursive: true } }));
    assert.equal(res.status, 200);
    await assert.rejects(() => fs.stat("/dir/child.txt"));
  });

  it("refuses when readOnly", async () => {
    const { app, fs } = createApi({ readOnly: true });
    await fs.writeFile("/x.txt", "x");
    const res = await app.request(post("/delete", { path: "/x.txt" }));
    assert.equal(res.status, 400);
  });
});
