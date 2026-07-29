import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createKyselyFs } from "./fs.ts";
import { createTestDialect } from "./test-helpers.ts";
import { createHono, resolveBrowserFeatures, type WedbavOptions } from "./wedbav.ts";

async function createApp() {
  const fs = createKyselyFs(createTestDialect(), { dbType: "sqlite" });
  await fs.ready();
  // auth: () => true bypasses env-based credentials so tests run without HTTP 401
  const app = createHono(fs, { browser: "public", auth: () => true });
  return { app, fs };
}

const AUTH = `Basic ${btoa("test:test")}`;

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
    const moveRes = await app.request(
      req("MOVE", "/%40src.txt", {
        headers: { Destination: "http://localhost/%40dst.txt" },
      }),
    );
    assert.ok(moveRes.status === 201 || moveRes.status === 204, `MOVE status: ${moveRes.status}`);
    assert.equal((await app.request(req("GET", "/%40dst.txt"))).status, 200);
    assert.equal((await app.request(req("GET", "/%40src.txt"))).status, 404);
  });

  it("renames #src.txt to #dst.txt", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/#src.txt", "data");
    const moveRes = await app.request(
      req("MOVE", "/%23src.txt", {
        headers: { Destination: "http://localhost/%23dst.txt" },
      }),
    );
    assert.ok(moveRes.status === 201 || moveRes.status === 204, `MOVE status: ${moveRes.status}`);
    assert.equal((await app.request(req("GET", "/%23dst.txt"))).status, 200);
    assert.equal((await app.request(req("GET", "/%23src.txt"))).status, 404);
  });

  it("renames across special chars: @src to #dst", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/@src.txt", "data");
    const moveRes = await app.request(
      req("MOVE", "/%40src.txt", {
        headers: { Destination: "http://localhost/%23dst.txt" },
      }),
    );
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

  // Regression: WebDAV DELETE of a non-empty directory must return 204, not 500.
  // The transaction refactor previously issued a raw ROLLBACK that failed on the
  // libsql remote driver ("cannot rollback - no transaction is active").
  it("DELETE of a non-empty directory succeeds with 204", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/tet/a.txt", "a");
    await fs.writeFile("/tet/sub/b.txt", "b");
    const delRes = await app.request(req("DELETE", "/tet/"));
    assert.equal(delRes.status, 204);
    await assert.rejects(() => fs.stat("/tet/a.txt"));
    await assert.rejects(() => fs.stat("/tet/sub/b.txt"));
    await assert.rejects(() => fs.stat("/tet"));
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
    const res = await app.request(
      req("COPY", "/%40src/", {
        headers: { Destination: "http://localhost/%40dst/" },
      }),
    );
    assert.ok(res.status === 201 || res.status === 204, `COPY status: ${res.status}`);
    if (res.status === 201) {
      const location = res.headers.get("Location");
      assert.ok(location?.includes("%40"), `expected encoded @ in Location: ${location}`);
    }
  });

  it("COPY of #src/ returns Location: /%23dst/", async () => {
    const { app, fs } = await createApp();
    await fs.mkdir("/#src/");
    const res = await app.request(
      req("COPY", "/%23src/", {
        headers: { Destination: "http://localhost/%23dst/" },
      }),
    );
    assert.ok(res.status === 201 || res.status === 204, `COPY status: ${res.status}`);
    if (res.status === 201) {
      const location = res.headers.get("Location");
      assert.ok(location?.includes("%23"), `expected encoded # in Location: ${location}`);
    }
  });
});

// ─── I. WebDAV behavioral semantics (status codes, methods) ─────────────────

describe("WebDAV method semantics", () => {
  it("PUT creates a file and returns 201", async () => {
    const { app } = await createApp();
    const res = await app.request(req("PUT", "/created.txt", { body: "hi" }));
    assert.equal(res.status, 201);
  });

  it("GET on a directory with listing disabled returns 404 (no listing UI)", async () => {
    // The default test app uses browser:"public", which renders directory HTML listings.
    // With list:false the browser still serves files (behind auth) but never renders
    // the listing UI, so a directory without an index.html returns 404.
    const fs = createKyselyFs(createTestDialect(), { dbType: "sqlite" });
    await fs.ready();
    const app = createHono(fs, { browser: "private", list: false, auth: () => true });
    await fs.mkdir("/adir");
    const res = await app.request(req("GET", "/adir"));
    assert.equal(res.status, 404);
  });

  it("GET on a directory in browser:public mode returns an HTML listing (200)", async () => {
    const { app, fs } = await createApp();
    await fs.mkdir("/adir");
    const res = await app.request(req("GET", "/adir/", { headers: { Accept: "text/html" } }));
    assert.equal(res.status, 200);
    assert.ok((res.headers.get("content-type") ?? "").includes("text/html"));
  });

  it("GET on a missing file returns 404", async () => {
    const { app } = await createApp();
    const res = await app.request(req("GET", "/nope.txt"));
    assert.equal(res.status, 404);
  });

  it("DELETE is idempotent (force) and returns 204 even for missing paths", async () => {
    const { app } = await createApp();
    const res = await app.request(req("DELETE", "/never-existed.txt"));
    assert.equal(res.status, 204);
  });

  it("MKCOL then PROPFIND Depth:0 finds the collection", async () => {
    const { app } = await createApp();
    const mk = await app.request(req("MKCOL", "/coll/"));
    assert.ok(mk.status === 201 || mk.status === 204);
    const pf = await app.request(req("PROPFIND", "/coll/", { headers: { Depth: "0" } }));
    assert.equal(pf.status, 207);
  });

  it("PROPFIND on root returns 207 even when empty", async () => {
    const { app } = await createApp();
    const res = await app.request(req("PROPFIND", "/", { headers: { Depth: "1" } }));
    assert.equal(res.status, 207);
  });

  it("PROPATCH is not implemented (501)", async () => {
    const { app } = await createApp();
    const res = await app.request(req("PROPATCH", "/x.txt"));
    assert.equal(res.status, 501);
  });

  it("unsupported method returns 405 with an Allow header", async () => {
    const { app } = await createApp();
    const res = await app.request(req("LOCK", "/x.txt"));
    assert.equal(res.status, 405);
    assert.ok(res.headers.get("Allow"), "405 must advertise allowed methods");
  });

  it("OPTIONS advertises DAV compliance and returns 204", async () => {
    const { app } = await createApp();
    const res = await app.request(req("OPTIONS", "/"));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("DAV"), "1");
  });
});

// ─── J. Conditional GET / ETag (browser mode) ───────────────────────────────

describe("conditional GET via ETag", () => {
  it("serves the file with an ETag and returns 304 for a matching If-None-Match", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/cond.txt", "cache me");
    const first = await app.request(req("GET", "/cond.txt", { headers: { Accept: "text/html" } }));
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag, "expected an ETag header");

    const second = await app.request(
      req("GET", "/cond.txt", { headers: { Accept: "text/html", "If-None-Match": etag! } }),
    );
    assert.equal(second.status, 304);
  });

  it("sends cache-control: no-store so no browser/proxy/CDN serves a stale copy", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/doc.txt", "v1");
    const first = await app.request(req("GET", "/doc.txt"));
    assert.equal(first.status, 200);
    const cc = first.headers.get("cache-control") ?? "";
    // `no-store` is the vendor-neutral directive that prevents any cache (including
    // a CDN) from storing the body; the others harden against quirky intermediaries.
    assert.match(cc, /no-store/);
    assert.match(cc, /no-cache/);
    const etag = first.headers.get("etag");

    // A 304 revalidation response must also carry the no-store directive.
    const notModified = await app.request(req("GET", "/doc.txt", { headers: { "If-None-Match": etag! } }));
    assert.equal(notModified.status, 304);
    assert.match(notModified.headers.get("cache-control") ?? "", /no-store/);

    // After an edit the ETag changes, so the old If-None-Match no longer matches
    // and the fresh content is served (never a stale 304).
    await app.request(req("PUT", "/doc.txt", { body: "v2" }));
    const afterEdit = await app.request(req("GET", "/doc.txt", { headers: { "If-None-Match": etag! } }));
    assert.equal(afterEdit.status, 200);
    assert.equal(await afterEdit.text(), "v2");
    assert.notEqual(afterEdit.headers.get("etag"), etag);
  });
});

// ─── K. Authentication ──────────────────────────────────────────────────────

describe("authentication", () => {
  async function createAuthedApp() {
    const fs = createKyselyFs(createTestDialect(), { dbType: "sqlite" });
    await fs.ready();
    // Only accept exactly user:pass
    const app = createHono(fs, { browser: false, auth: (u, p) => u === "user" && p === "pass" });
    return { app, fs };
  }

  it("rejects a WebDAV request with no credentials (401)", async () => {
    const { app } = await createAuthedApp();
    const res = await app.request(new Request("http://localhost/x.txt", { method: "PUT", body: "x" }));
    assert.equal(res.status, 401);
  });

  it("rejects wrong credentials (401)", async () => {
    const { app } = await createAuthedApp();
    const res = await app.request(
      new Request("http://localhost/x.txt", {
        method: "PUT",
        body: "x",
        headers: { Authorization: `Basic ${btoa("user:wrong")}` },
      }),
    );
    assert.equal(res.status, 401);
  });

  it("accepts correct credentials", async () => {
    const { app } = await createAuthedApp();
    const res = await app.request(
      new Request("http://localhost/ok.txt", {
        method: "PUT",
        body: "x",
        headers: { Authorization: `Basic ${btoa("user:pass")}` },
      }),
    );
    assert.equal(res.status, 201);
  });
});

// ─── L. Chinese (UTF-8) paths over the HTTP/WebDAV layer ─────────────────────
// The fs layer is exercised directly in fs.test.ts; these tests drive the full
// percent-encode/decode round-trip through the HTTP handlers.

describe("Chinese UTF-8 paths over HTTP", () => {
  // [decoded path, percent-encoded request path]
  const files: [string, string][] = [
    ["/文件.txt", "/%E6%96%87%E4%BB%B6.txt"],
    ["/目录/测试.txt", "/%E7%9B%AE%E5%BD%95/%E6%B5%8B%E8%AF%95.txt"],
    ["/中文 空格.txt", "/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC.txt"],
  ];

  for (const [decoded, encoded] of files) {
    it(`PUT ${encoded} → GET round-trips content`, async () => {
      const { app } = await createApp();
      const putRes = await app.request(req("PUT", encoded, { body: "你好世界" }));
      assert.ok(putRes.status === 201 || putRes.status === 204, `PUT status: ${putRes.status}`);
      const getRes = await app.request(req("GET", encoded));
      assert.equal(getRes.status, 200);
      assert.equal(await getRes.text(), "你好世界");
    });

    it(`stat sees the decoded name for ${encoded}`, async () => {
      const { app, fs } = await createApp();
      await app.request(req("PUT", encoded, { body: "x" }));
      // The fs must receive the DECODED path, never the percent-encoded form.
      assert.equal((await fs.stat(decoded)).isFile(), true);
    });
  }

  it("PROPFIND encodes Chinese hrefs and shows the decoded displayname", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/文档.txt", "x");
    const res = await app.request(req("PROPFIND", "/", { headers: { Depth: "1" } }));
    assert.equal(res.status, 207);
    const body = await res.text();
    // href must be percent-encoded UTF-8
    assert.ok(body.includes("/%E6%96%87%E6%A1%A3.txt"), `expected encoded href in:\n${body}`);
    // displayname must be the decoded, human-readable name
    assert.ok(body.includes("<d:displayname>文档.txt</d:displayname>"), "displayname should be decoded");
    // the raw Chinese bytes must not leak into an href element
    assert.ok(!body.includes("<d:href>/文档.txt</d:href>"), "raw Chinese must not appear in href");
  });

  it("MOVE renames a Chinese file to another Chinese name", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/旧文件.txt", "数据");
    const moveRes = await app.request(
      req("MOVE", "/%E6%97%A7%E6%96%87%E4%BB%B6.txt", {
        headers: { Destination: "http://localhost/%E6%96%B0%E6%96%87%E4%BB%B6.txt" },
      }),
    );
    assert.ok(moveRes.status === 201 || moveRes.status === 204, `MOVE status: ${moveRes.status}`);
    assert.equal((await app.request(req("GET", "/%E6%96%B0%E6%96%87%E4%BB%B6.txt"))).status, 200);
    assert.equal((await app.request(req("GET", "/%E6%97%A7%E6%96%87%E4%BB%B6.txt"))).status, 404);
    assert.equal((await fs.readFile("/新文件.txt")).toString(), "数据");
  });

  it("DELETE removes a Chinese-named file", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/删除我.txt", "x");
    const delRes = await app.request(req("DELETE", "/%E5%88%A0%E9%99%A4%E6%88%91.txt"));
    assert.ok(delRes.status === 200 || delRes.status === 204, `DELETE status: ${delRes.status}`);
    await assert.rejects(() => fs.stat("/删除我.txt"));
  });

  it("browser listing shows decoded Chinese names but encoded hrefs", async () => {
    const { app, fs } = await createApp();
    await fs.writeFile("/图片.png", "x");
    const res = await app.request(req("GET", "/", { headers: { Accept: "text/html" } }));
    assert.equal(res.status, 200);
    const body = await res.text();
    // Human-readable decoded name in the display span
    assert.ok(body.includes('class="name-text">图片.png'), "listing should show decoded name");
    // href/link must be percent-encoded
    assert.ok(body.includes('href="./%E5%9B%BE%E7%89%87.png"'), `expected encoded href in:\n${body}`);
  });
});

// ─── M. browser / list option resolution ────────────────────────────────────

describe("resolveBrowserFeatures", () => {
  const cases: [WedbavOptions, { browser: "public" | "private" | false; list: "public" | "private" | false }][] = [
    // defaults: browser private, list inherits browser
    [{}, { browser: "private", list: "private" }],
    // browser public → list inherits public
    [{ browser: "public" }, { browser: "public", list: "public" }],
    // explicit list overrides the inherited value (independent auth)
    [
      { browser: "public", list: "private" },
      { browser: "public", list: "private" },
    ],
    [
      { browser: "private", list: "public" },
      { browser: "private", list: "public" },
    ],
    // list disabled while browser enabled
    [
      { browser: "public", list: false },
      { browser: "public", list: false },
    ],
    [
      { browser: "private", list: "false" },
      { browser: "private", list: false },
    ],
    // browser disabled forces list off, regardless of the list value
    [{ browser: false }, { browser: false, list: false }],
    [{ browser: "false" }, { browser: false, list: false }],
    [
      { browser: false, list: "public" },
      { browser: false, list: false },
    ],
    // string "false" is treated the same as boolean false
    [
      { browser: "false", list: "false" },
      { browser: false, list: false },
    ],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(resolveBrowserFeatures(input), expected);
    });
  }
});

describe("browser & list options (HTTP)", () => {
  async function appWith(options: Partial<WedbavOptions>) {
    const fs = createKyselyFs(createTestDialect(), { dbType: "sqlite" });
    await fs.ready();
    const app = createHono(fs, { auth: (u, p) => u === "user" && p === "pass", ...options });
    return { app, fs };
  }
  const CREDS = `Basic ${btoa("user:pass")}`;
  const html = { Accept: "text/html" };

  it("browser:false falls through to WebDAV GET (directory download is 404)", async () => {
    const { app, fs } = await appWith({ browser: false });
    await fs.mkdir("/adir");
    // No browser handler; WebDAV GET refuses to download a directory.
    const res = await app.request(new Request("http://localhost/adir", { headers: { Authorization: CREDS } }));
    assert.equal(res.status, 404);
  });

  it("browser:public serves a file without auth", async () => {
    const { app, fs } = await appWith({ browser: "public" });
    await fs.writeFile("/pub.txt", "hi");
    const res = await app.request(new Request("http://localhost/pub.txt"));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hi");
  });

  it("browser:private requires auth to read a file", async () => {
    const { app, fs } = await appWith({ browser: "private" });
    await fs.writeFile("/sec.txt", "secret");
    const anon = await app.request(new Request("http://localhost/sec.txt"));
    assert.equal(anon.status, 401);
    const authed = await app.request(new Request("http://localhost/sec.txt", { headers: { Authorization: CREDS } }));
    assert.equal(authed.status, 200);
    assert.equal(await authed.text(), "secret");
  });

  it("list:false returns 404 for a directory even when browser serves files", async () => {
    const { app, fs } = await appWith({ browser: "public", list: false });
    await fs.mkdir("/adir");
    await fs.writeFile("/adir/file.txt", "x");
    // The directory itself has no listing → 404 …
    assert.equal((await app.request(new Request("http://localhost/adir/", { headers: html }))).status, 404);
    // … but files inside are still served publicly.
    assert.equal((await app.request(new Request("http://localhost/adir/file.txt"))).status, 200);
  });

  it("independent auth: public files but private listing", async () => {
    const { app, fs } = await appWith({ browser: "public", list: "private" });
    await fs.writeFile("/dir/f.txt", "data");
    // File is public …
    assert.equal((await app.request(new Request("http://localhost/dir/f.txt"))).status, 200);
    // … but listing the directory requires auth.
    const anonList = await app.request(new Request("http://localhost/dir/", { headers: html }));
    assert.equal(anonList.status, 401);
    const authedList = await app.request(
      new Request("http://localhost/dir/", { headers: { ...html, Authorization: CREDS } }),
    );
    assert.equal(authedList.status, 200);
  });

  it("independent auth: private files but public listing", async () => {
    const { app, fs } = await appWith({ browser: "private", list: "public" });
    await fs.writeFile("/dir/f.txt", "data");
    // Listing is public …
    const list = await app.request(new Request("http://localhost/dir/", { headers: html }));
    assert.equal(list.status, 200);
    // … but reading a file requires auth.
    assert.equal((await app.request(new Request("http://localhost/dir/f.txt"))).status, 401);
    const authedFile = await app.request(
      new Request("http://localhost/dir/f.txt", { headers: { Authorization: CREDS } }),
    );
    assert.equal(authedFile.status, 200);
  });

  it("list inherits browser when unset (private/private)", async () => {
    const { app, fs } = await appWith({ browser: "private" });
    await fs.mkdir("/adir");
    // listing inherits private → anonymous is rejected
    const anon = await app.request(new Request("http://localhost/adir/", { headers: html }));
    assert.equal(anon.status, 401);
    const authed = await app.request(
      new Request("http://localhost/adir/", { headers: { ...html, Authorization: CREDS } }),
    );
    assert.equal(authed.status, 200);
  });

  it("editor page (?action=edit) follows the list auth level, not browser", async () => {
    // list:private → editor requires auth even when files are served publicly.
    const priv = await appWith({ browser: "public", list: "private" });
    const anon = await priv.app.request(new Request("http://localhost/new.txt?action=edit", { headers: html }));
    assert.equal(anon.status, 401);
    const authed = await priv.app.request(
      new Request("http://localhost/new.txt?action=edit", { headers: { ...html, Authorization: CREDS } }),
    );
    assert.equal(authed.status, 200);

    // list:public → editor is public even when files are behind auth.
    const pub = await appWith({ browser: "private", list: "public" });
    const pubRes = await pub.app.request(new Request("http://localhost/new.txt?action=edit", { headers: html }));
    assert.equal(pubRes.status, 200);
  });

  it("?action=edit is ignored when the listing feature is disabled", async () => {
    const { app, fs } = await appWith({ browser: "public", list: false });
    await fs.writeFile("/exists.txt", "content");
    // ?action=edit on a missing file must NOT show the editor; it falls through to a
    // normal (missing) file request → 404.
    const missing = await app.request(new Request("http://localhost/new.txt?action=edit", { headers: html }));
    assert.equal(missing.status, 404);
    // ?action=edit on an existing file serves the raw file, not the editor UI.
    const existing = await app.request(new Request("http://localhost/exists.txt?action=edit", { headers: html }));
    assert.equal(existing.status, 200);
    assert.equal(await existing.text(), "content");
  });

  it("?action=edit does not leak the editor UI when listing requires auth (regression)", async () => {
    // The bug: browser:public made the editor render for anyone. It must now be gated
    // by the (private) listing feature.
    const { app } = await appWith({ browser: "public", list: "private" });
    const res = await app.request(new Request("http://localhost/secret.txt?action=edit", { headers: html }));
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.ok(!body.includes("CodeMirror") && !/editor/i.test(body), "editor HTML must not be served to anon");
  });
});

// ─── N. ?action=edit on directories + custom actionQuery ─────────────────────

describe("directory management via ?action=edit", () => {
  async function appWith(options: Partial<WedbavOptions>) {
    const fs = createKyselyFs(createTestDialect(), { dbType: "sqlite" });
    await fs.ready();
    const app = createHono(fs, { auth: () => true, ...options });
    return { app, fs };
  }
  const html = { Accept: "text/html" };
  const isListing = (body: string) => body.includes('id="file-list"');
  const isEditor = (body: string) => body.includes('id="editor-container"');

  it("normally serves index.html for a directory (no way to manage)", async () => {
    const { app, fs } = await appWith({ browser: "public" });
    await fs.writeFile("/site/index.html", "<h1>home</h1>");
    const res = await app.request(new Request("http://localhost/site/", { headers: html }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<h1>home</h1>");
  });

  it("?action=edit on a directory forces the listing UI even when index.html exists", async () => {
    const { app, fs } = await appWith({ browser: "public" });
    await fs.writeFile("/site/index.html", "<h1>home</h1>");
    await fs.writeFile("/site/data.txt", "x");
    const res = await app.request(new Request("http://localhost/site/?action=edit", { headers: html }));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(isListing(body), "expected the manager/listing UI, not index.html");
    assert.ok(!body.includes("<h1>home</h1>"), "index.html must not be served");
  });

  it("?action=edit on a directory without a trailing slash redirects to the slash form", async () => {
    const { app, fs } = await appWith({ browser: "public" });
    await fs.writeFile("/site/index.html", "home");
    const res = await app.request(
      new Request("http://localhost/site?action=edit", { headers: html, redirect: "manual" }),
    );
    assert.equal(res.status, 308);
    assert.equal(res.headers.get("location"), "/site/?action=edit");
  });

  it("?action=edit still opens the editor for a file (not the listing)", async () => {
    const { app, fs } = await appWith({ browser: "public" });
    await fs.writeFile("/notes.txt", "hi");
    const res = await app.request(new Request("http://localhost/notes.txt?action=edit", { headers: html }));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(isEditor(body), "expected the editor UI for a file");
  });

  it("?action=edit on a directory is guarded by the list auth level", async () => {
    const { app, fs } = await appWith({ browser: "public", list: "private", auth: (u, p) => u === "a" && p === "b" });
    await fs.writeFile("/site/index.html", "home");
    const anon = await app.request(new Request("http://localhost/site/?action=edit", { headers: html }));
    assert.equal(anon.status, 401);
    const authed = await app.request(
      new Request("http://localhost/site/?action=edit", {
        headers: { ...html, Authorization: `Basic ${btoa("a:b")}` },
      }),
    );
    assert.equal(authed.status, 200);
    assert.ok(isListing(await authed.text()));
  });

  it("a custom actionQuery activates the management UI (and default ?action does not)", async () => {
    const { app, fs } = await appWith({ browser: "public", actionQuery: "wedbav-action" });
    await fs.writeFile("/site/index.html", "<h1>home</h1>");

    // The custom query forces the listing.
    const custom = await app.request(new Request("http://localhost/site/?wedbav-action=edit", { headers: html }));
    assert.equal(custom.status, 200);
    assert.ok(isListing(await custom.text()), "custom actionQuery should force the listing");

    // The default ?action is now just a normal query param → index.html is served.
    const stale = await app.request(new Request("http://localhost/site/?action=edit", { headers: html }));
    assert.equal(stale.status, 200);
    assert.equal(await stale.text(), "<h1>home</h1>", "default ?action must be ignored when actionQuery is customized");
  });

  it("custom actionQuery opens the file editor and is reflected in the page", async () => {
    const { app, fs } = await appWith({ browser: "public", actionQuery: "manage" });
    await fs.writeFile("/notes.txt", "hi");
    const res = await app.request(new Request("http://localhost/notes.txt?manage=edit", { headers: html }));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(isEditor(body), "expected the editor UI");
    // The editor's client script must use the custom query when rewriting history.
    assert.ok(body.includes('"manage"'), "editor should embed the custom action query");
  });

  it("directory rows link with ?action=edit and expose a zip-download link in the download slot", async () => {
    const { app, fs } = await appWith({ browser: "public" });
    await fs.mkdir("/sub");
    await fs.writeFile("/file.txt", "x");
    const res = await app.request(new Request("http://localhost/?action=edit", { headers: html }));
    assert.equal(res.status, 200);
    const body = await res.text();
    // Directory row-link navigates INTO the folder while staying in the manager.
    assert.ok(body.includes('href="./sub/?action=edit"'), `expected dir row-link to carry ?action=edit in:\n${body}`);
    // The download slot for a directory is a zip-download link (URL-navigable).
    assert.ok(body.includes('href="./sub/?action=download"'), "directory download slot should be a zip-download link");
    // Files still link directly to themselves (no ?action on the row-link).
    assert.ok(body.includes('href="./file.txt"'), "file row-link should point to the file itself");
  });

  it("directory row-link uses the custom actionQuery", async () => {
    const { app, fs } = await appWith({ browser: "public", actionQuery: "manage" });
    await fs.mkdir("/sub");
    const res = await app.request(new Request("http://localhost/?manage=edit", { headers: html }));
    const body = await res.text();
    assert.ok(body.includes('href="./sub/?manage=edit"'), `expected dir row-link to use ?manage=edit in:\n${body}`);
  });
});
