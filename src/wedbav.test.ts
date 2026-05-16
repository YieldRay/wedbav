import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { createKyselyFs } from "./fs.ts";
import { createHono } from "./wedbav.ts";

async function createApp() {
  // Use in-memory SQLite (KyselyFs) — throws proper VFSError with syscall, unlike memfs
  const dialect = new LibsqlDialect({ url: ":memory:" });
  const fs = createKyselyFs(dialect, { dbType: "sqlite" });
  // Warm up: the KyselyFs constructor fires table creation without await;
  // stat("/") waits for it to complete before any test operations run.
  await fs.stat("/").catch(() => {});
  // auth: () => true bypasses env-based credentials so tests run without HTTP 401
  const app = createHono(fs, { browser: "list", auth: () => true });
  return { app, fs };
}

const AUTH = "Basic " + btoa("test:test");

function req(method: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", AUTH);
  return new Request(`http://localhost${path}`, { method, ...init, headers });
}

// ─── A. PROPFIND — href encoding in XML response ────────────────────────────

describe("PROPFIND href encoding", () => {
  const specialDirs: [string, string][] = [
    ["@dir", "/%40dir/"],
    ["#dir", "/%23dir/"],
    ["&dir", "/%26dir/"],
    ["=dir", "/%3Ddir/"],
    ["+dir", "/%2Bdir/"],
    ["hello world", "/hello%20world/"],
    ["%dir", "/%25dir/"],
  ];

  for (const [name, encodedHref] of specialDirs) {
    it(`encodes "${name}" in PROPFIND href`, async () => {
      const { app, fs } = await createApp();
      await fs.mkdir(`/${name}/`);
      const res = await app.request(req("PROPFIND", "/", { headers: { Depth: "1" } }));
      assert.equal(res.status, 207);
      const body = await res.text();
      assert.ok(body.includes(`<d:href>${encodedHref}</d:href>`), `expected ${encodedHref} in:\n${body}`);
    });
  }

  it("XML response contains no unescaped & in href for file named a&b.txt", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/a&b.txt", "x");
    const res = await app.request(req("PROPFIND", "/", { headers: { Depth: "1" } }));
    const body = await res.text();
    // href must be /a%26b.txt — no raw & in XML attribute
    assert.ok(body.includes("/a%26b.txt"), `expected /a%26b.txt in body`);
    // The raw & should not appear unescaped inside a d:href element
    assert.ok(!body.includes("<d:href>/a&b.txt</d:href>"), "raw & must not appear in href");
  });

  it("XML response contains no unescaped < in href for file named <file>.txt", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/<file>.txt", "x");
    const res = await app.request(req("PROPFIND", "/", { headers: { Depth: "1" } }));
    const body = await res.text();
    assert.ok(body.includes("/%3Cfile%3E.txt"), "expected encoded < and > in href");
    assert.ok(!body.includes("<d:href>/<file>.txt</d:href>"), "raw < must not appear in href");
  });
});

// ─── B. PUT → GET round-trip ─────────────────────────────────────────────────

describe("PUT → GET round-trip with special chars", () => {
  const files: [string, string][] = [
    ["/@foo.txt", "/%40foo.txt"],
    ["/#foo.txt", "/%23foo.txt"],
    ["/&foo.txt", "/%26foo.txt"],
    ["/hello world.txt", "/hello%20world.txt"],
    ["/%foo.txt", "/%25foo.txt"],
    ["/a=b.txt", "/a%3Db.txt"],
    ["/a+b.txt", "/a%2Bb.txt"],
  ];

  for (const [_decodedPath, encodedPath] of files) {
    it(`PUT ${encodedPath} → GET ${encodedPath}`, async () => {
      const { app } = await createApp();
      const putRes = await app.request(req("PUT", encodedPath, { body: "hello" }));
      assert.ok(putRes.status === 201 || putRes.status === 204, `PUT status: ${putRes.status}`);
      const getRes = await app.request(req("GET", encodedPath));
      assert.equal(getRes.status, 200);
      assert.equal(await getRes.text(), "hello");
    });
  }
});

// ─── C. MKCOL → PROPFIND round-trip ─────────────────────────────────────────

describe("MKCOL → PROPFIND round-trip with special chars", () => {
  const dirs: [string, string][] = [
    ["/%40dir/", "/%40dir/"],
    ["/%23dir/", "/%23dir/"],
    ["/%26dir/", "/%26dir/"],
    ["/hello%20world/", "/hello%20world/"],
  ];

  for (const [mkcolPath, expectedHref] of dirs) {
    it(`MKCOL ${mkcolPath} appears in PROPFIND as ${expectedHref}`, async () => {
      const { app } = await createApp();
      const mkcolRes = await app.request(req("MKCOL", mkcolPath));
      assert.ok(mkcolRes.status === 201 || mkcolRes.status === 204, `MKCOL status: ${mkcolRes.status}`);
      // Use Depth:1 from root — avoids the trailing-slash duplication in Depth:0 self-PROPFIND
      const propRes = await app.request(req("PROPFIND", "/", { headers: { Depth: "1" } }));
      assert.equal(propRes.status, 207);
      const body = await propRes.text();
      assert.ok(body.includes(`<d:href>${expectedHref}</d:href>`), `expected ${expectedHref} in:\n${body}`);
    });
  }
});

// ─── D. MOVE (rename) with special chars ────────────────────────────────────

describe("MOVE with special char paths", () => {
  it("renames @src.txt to @dst.txt", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/@src.txt", "data");
    const moveRes = await app.request(req("MOVE", "/%40src.txt", {
      headers: { Destination: "http://localhost/%40dst.txt" },
    }));
    assert.ok(moveRes.status === 201 || moveRes.status === 204, `MOVE status: ${moveRes.status}`);
    assert.equal((await app.request(req("GET", "/%40dst.txt"))).status, 200);
    assert.equal((await app.request(req("GET", "/%40src.txt"))).status, 404);
  });

  it("renames #src.txt to #dst.txt", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/#src.txt", "data");
    const moveRes = await app.request(req("MOVE", "/%23src.txt", {
      headers: { Destination: "http://localhost/%23dst.txt" },
    }));
    assert.ok(moveRes.status === 201 || moveRes.status === 204, `MOVE status: ${moveRes.status}`);
    assert.equal((await app.request(req("GET", "/%23dst.txt"))).status, 200);
    assert.equal((await app.request(req("GET", "/%23src.txt"))).status, 404);
  });

  it("renames across special chars: @src to #dst", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/@src.txt", "data");
    const moveRes = await app.request(req("MOVE", "/%40src.txt", {
      headers: { Destination: "http://localhost/%23dst.txt" },
    }));
    assert.ok(moveRes.status === 201 || moveRes.status === 204);
    assert.equal((await app.request(req("GET", "/%23dst.txt"))).status, 200);
  });
});

// ─── E. DELETE with special chars ────────────────────────────────────────────

describe("DELETE with special char paths", () => {
  const cases: [string, string][] = [
    ["/#file.txt", "/%23file.txt"],
    ["/@file.txt", "/%40file.txt"],
    ["/&file.txt", "/%26file.txt"],
    ["/hello world.txt", "/hello%20world.txt"],
    ["/%file.txt", "/%25file.txt"],
  ];

  for (const [decodedPath, encodedPath] of cases) {
    it(`DELETE ${encodedPath}`, async () => {
      const { app, fs } = await createApp();
      await fs.writeFile(decodedPath, "x");
      const delRes = await app.request(req("DELETE", encodedPath));
      assert.ok(delRes.status === 200 || delRes.status === 204, `DELETE status: ${delRes.status}`);
      assert.equal((await app.request(req("GET", encodedPath))).status, 404);
    });
  }

  it("DELETE #dir/ (directory)", async () => {
    const { app, fs } = await createApp();
    await fs.mkdir("/#dir/");
    const delRes = await app.request(req("DELETE", "/%23dir/"));
    assert.ok(delRes.status === 200 || delRes.status === 204, `DELETE status: ${delRes.status}`);
    const propRes = await app.request(req("PROPFIND", "/%23dir/", { headers: { Depth: "0" } }));
    assert.equal(propRes.status, 404);
  });
});

// ─── F. Browser listing HTML — data-path and PATHNAME encoding ───────────────

describe("Browser HTML listing — data-path and PATHNAME encoding", () => {
  it("data-path for @foo.txt is URL-encoded", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/@foo.txt", "x");
    const res = await app.request(req("GET", "/", { headers: { Accept: "text/html" } }));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('data-path="/%40foo.txt"'), `expected encoded data-path in:\n${body}`);
    assert.ok(!body.includes('data-path="/@foo.txt"'), "raw @ must not appear in data-path");
  });

  it("data-path for #dir/ is URL-encoded", async () => {
    const { app, fs } = await createApp();
    await fs.mkdir("/#dir/");
    const res = await app.request(req("GET", "/", { headers: { Accept: "text/html" } }));
    const body = await res.text();
    assert.ok(body.includes('data-path="/%23dir/"'), `expected encoded data-path in:\n${body}`);
    assert.ok(!body.includes('data-path="/#dir/"'), "raw # must not appear in data-path");
  });

  it("row-link href for @foo.txt is URL-encoded", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/@foo.txt", "x");
    const res = await app.request(req("GET", "/", { headers: { Accept: "text/html" } }));
    const body = await res.text();
    assert.ok(body.includes('href="./%40foo.txt"'), `expected encoded href in:\n${body}`);
  });

  it("PATHNAME JS variable is URL-encoded when inside a special-char dir", async () => {
    const { app, fs } = await createApp();
    await fs.mkdir("/#dir/");
    await fs.writeFile("/#dir/file.txt", "x");
    const res = await app.request(req("GET", "/%23dir/", { headers: { Accept: "text/html" } }));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('const PATHNAME = "/%23dir/"'), `expected encoded PATHNAME in:\n${body}`);
    assert.ok(!body.includes('const PATHNAME = "/#dir/"'), "raw # must not appear in PATHNAME");
  });

  it("display name shows decoded name (not %40foo)", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/@foo.txt", "x");
    const res = await app.request(req("GET", "/", { headers: { Accept: "text/html" } }));
    const body = await res.text();
    // The name-text span must contain the decoded name
    assert.ok(body.includes('class="name-text">@foo.txt'), "display name should be decoded @foo.txt");
    // The name-text span must NOT contain the encoded form
    assert.ok(!body.includes('class="name-text">%40foo.txt'), "display name must not be URL-encoded");
  });
});

// ─── G. XML escaping + URL encoding combined ────────────────────────────────

describe("XML escaping combined with URL encoding", () => {
  it("file named a&b.txt: href is /a%26b.txt with no raw & in XML", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/a&b.txt", "x");
    const res = await app.request(req("PROPFIND", "/", { headers: { Depth: "1" } }));
    const body = await res.text();
    assert.ok(body.includes("/a%26b.txt"), "& must be percent-encoded in href");
    // raw & in XML would break XML parsers
    const hrefMatches = body.match(/<d:href>[^<]*<\/d:href>/g) ?? [];
    for (const href of hrefMatches) {
      assert.ok(!href.includes("&b.txt"), `raw & found in href: ${href}`);
    }
  });

  it('file named "quoted".txt: href is URL-encoded', async () => {
    const { app, fs } = await createApp();
    await fs.writeFile('/"quoted".txt', "x");
    const res = await app.request(req("PROPFIND", "/", { headers: { Depth: "1" } }));
    const body = await res.text();
    assert.ok(body.includes("/%22quoted%22.txt"), 'expected encoded " in href');
  });
});

// ─── H. Location header encoding (COPY 201 response) ────────────────────────

describe("Location header encoding", () => {
  it("COPY of @src/ returns Location: /%40dst/", async () => {
    const { app, fs } = await createApp();
    await fs.mkdir("/@src/");
    const res = await app.request(req("COPY", "/%40src/", {
      headers: { Destination: "http://localhost/%40dst/" },
    }));
    assert.ok(res.status === 201 || res.status === 204, `COPY status: ${res.status}`);
    if (res.status === 201) {
      const location = res.headers.get("Location");
      assert.ok(location?.includes("%40"), `expected encoded @ in Location: ${location}`);
    }
  });

  it("COPY of #src/ returns Location: /%23dst/", async () => {
    const { app, fs } = await createApp();
    await fs.mkdir("/#src/");
    const res = await app.request(req("COPY", "/%23src/", {
      headers: { Destination: "http://localhost/%23dst/" },
    }));
    assert.ok(res.status === 201 || res.status === 204, `COPY status: ${res.status}`);
    if (res.status === 201) {
      const location = res.headers.get("Location");
      assert.ok(location?.includes("%23"), `expected encoded # in Location: ${location}`);
    }
  });
});
