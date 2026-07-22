import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { createKyselyFs } from "./fs.ts";
import { createTestDialect } from "./test-helpers.ts";
import {
  convertToWebStream,
  createEtag,
  decodeURISafe,
  encodePath,
  encodePathForSQL,
  getPathnameFromURL,
  isErrnoException,
  mapErrnoToStatus,
  normalizePathLike,
  readBufferOrStream,
  removeSuffixSlash,
} from "./utils.ts";

describe("removeSuffixSlash", () => {
  it("removes single trailing slash", () => {
    assert.equal(removeSuffixSlash("/foo/"), "/foo");
  });

  it("removes multiple trailing slashes", () => {
    assert.equal(removeSuffixSlash("/foo///"), "/foo");
  });

  it("leaves path without trailing slash unchanged", () => {
    assert.equal(removeSuffixSlash("/foo/bar"), "/foo/bar");
  });

  it("handles root slash", () => {
    assert.equal(removeSuffixSlash("/"), "");
  });

  it("handles empty string", () => {
    assert.equal(removeSuffixSlash(""), "");
  });
});

describe("encodePathForSQL", () => {
  it("escapes % character", () => {
    assert.equal(encodePathForSQL("foo%bar"), "foo\\\\%bar");
  });

  it("escapes _ character", () => {
    assert.equal(encodePathForSQL("foo_bar"), "foo\\\\_bar");
  });

  it("escapes both % and _", () => {
    assert.equal(encodePathForSQL("a%b_c"), "a\\\\%b\\\\_c");
  });

  it("leaves normal paths unchanged", () => {
    assert.equal(encodePathForSQL("/foo/bar/baz"), "/foo/bar/baz");
  });
});

describe("decodeURISafe", () => {
  it("decodes valid URI", () => {
    assert.equal(decodeURISafe("/foo%20bar"), "/foo bar");
  });

  it("returns original string on invalid URI", () => {
    assert.equal(decodeURISafe("%"), "%");
  });

  it("leaves already-decoded string unchanged", () => {
    assert.equal(decodeURISafe("/foo/bar"), "/foo/bar");
  });

  it("decodes @ (%40) in path segment", () => {
    assert.equal(decodeURISafe("/path/%40foo"), "/path/@foo");
  });

  it("decodes # (%23) in path segment", () => {
    assert.equal(decodeURISafe("/path/%23foo"), "/path/#foo");
  });

  it("decodes & (%26) in path segment", () => {
    assert.equal(decodeURISafe("/path/%26foo"), "/path/&foo");
  });

  it("decodes = (%3D) in path segment", () => {
    assert.equal(decodeURISafe("/path/foo%3Dbar"), "/path/foo=bar");
  });

  it("decodes %2F within a segment (filenames cannot contain / in practice)", () => {
    // %2F is decoded per-segment; real filesystems don't allow / in filenames
    assert.equal(decodeURISafe("/path/%2Ffoo"), "/path//foo");
  });

  it("preserves path separators", () => {
    assert.equal(decodeURISafe("/a/b/c"), "/a/b/c");
  });

  it("decodes + (%2B) in path segment", () => {
    assert.equal(decodeURISafe("/path/%2Bfoo"), "/path/+foo");
  });

  it("decodes ! (%21) in path segment", () => {
    assert.equal(decodeURISafe("/path/%21foo"), "/path/!foo");
  });

  it("decodes $ (%24) in path segment", () => {
    assert.equal(decodeURISafe("/path/%24foo"), "/path/$foo");
  });

  it("decodes , (%2C) in path segment", () => {
    assert.equal(decodeURISafe("/path/foo%2Cbar"), "/path/foo,bar");
  });

  it("decodes ; (%3B) in path segment", () => {
    assert.equal(decodeURISafe("/path/foo%3Bbar"), "/path/foo;bar");
  });

  it("decodes : (%3A) in path segment", () => {
    assert.equal(decodeURISafe("/path/foo%3Abar"), "/path/foo:bar");
  });

  it("decodes ? (%3F) in path segment", () => {
    assert.equal(decodeURISafe("/path/foo%3Fbar"), "/path/foo?bar");
  });

  it("decodes consecutive special chars", () => {
    assert.equal(decodeURISafe("/%40%23%26"), "/@#&");
  });

  it("decodes emoji", () => {
    assert.equal(decodeURISafe("/path/%F0%9F%98%80"), "/path/😀");
  });

  it("decodes Cyrillic", () => {
    assert.equal(decodeURISafe("/path/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82"), "/path/привет");
  });

  it("handles invalid percent sequence gracefully", () => {
    assert.equal(decodeURISafe("/%GG"), "/%GG");
  });

  it("handles root path", () => {
    assert.equal(decodeURISafe("/"), "/");
  });

  it("handles double slash", () => {
    assert.equal(decodeURISafe("//foo"), "//foo");
  });
});

describe("getPathnameFromURL", () => {
  it("extracts pathname from URL string", () => {
    assert.equal(getPathnameFromURL("http://example.com/foo/bar"), "/foo/bar");
  });

  it("decodes percent-encoded pathname", () => {
    assert.equal(getPathnameFromURL("http://example.com/foo%20bar"), "/foo bar");
  });

  it("works with URL object", () => {
    assert.equal(getPathnameFromURL(new URL("http://example.com/baz")), "/baz");
  });

  it("decodes @ in pathname", () => {
    assert.equal(getPathnameFromURL("http://example.com/%40foo"), "/@foo");
  });

  it("decodes # in pathname", () => {
    assert.equal(getPathnameFromURL("http://example.com/%23foo"), "/#foo");
  });

  it("decodes & in pathname", () => {
    assert.equal(getPathnameFromURL("http://example.com/%26foo"), "/&foo");
  });

  it("decodes = in pathname", () => {
    assert.equal(getPathnameFromURL("http://example.com/foo%3Dbar"), "/foo=bar");
  });

  it("decodes emoji in pathname", () => {
    assert.equal(getPathnameFromURL("http://example.com/%F0%9F%98%80"), "/😀");
  });
});

describe("encodePath", () => {
  it("encodes special characters in segments", () => {
    assert.equal(encodePath("/@foo"), "/%40foo");
  });

  it("encodes # in segment", () => {
    assert.equal(encodePath("/#foo"), "/%23foo");
  });

  it("preserves path separators", () => {
    assert.equal(encodePath("/a/b/c"), "/a/b/c");
  });

  it("encodes space in segment", () => {
    assert.equal(encodePath("/foo bar/baz"), "/foo%20bar/baz");
  });

  it("encodes & in segment", () => {
    assert.equal(encodePath("/a&b"), "/a%26b");
  });

  it("encodes = in segment", () => {
    assert.equal(encodePath("/foo=bar"), "/foo%3Dbar");
  });

  it("encodes ? in segment", () => {
    assert.equal(encodePath("/foo?bar"), "/foo%3Fbar");
  });

  it("encodes + in segment", () => {
    assert.equal(encodePath("/foo+bar"), "/foo%2Bbar");
  });

  it("encodes % in segment", () => {
    assert.equal(encodePath("/foo%bar"), "/foo%25bar");
  });

  it("leaves ! unencoded in segment (allowed in URI components)", () => {
    assert.equal(encodePath("/foo!bar"), "/foo!bar");
  });

  it("encodes emoji in segment", () => {
    assert.equal(encodePath("/path/😀"), "/path/%F0%9F%98%80");
  });

  it("handles root path", () => {
    assert.equal(encodePath("/"), "/");
  });

  it("handles empty string", () => {
    assert.equal(encodePath(""), "");
  });

  it("round-trips with decodeURISafe", () => {
    const original = "/path/@foo/#bar/hello world";
    assert.equal(decodeURISafe(encodePath(original)), original);
  });

  it("round-trips all reserved chars with decodeURISafe", () => {
    const original = "/a@b/#c/d&e/f=g/h+i/j%k/l!m/n,o/p;q/r:s/t?u";
    assert.equal(decodeURISafe(encodePath(original)), original);
  });

  it("round-trips emoji with decodeURISafe", () => {
    const original = "/path/😀/привет/文件";
    assert.equal(decodeURISafe(encodePath(original)), original);
  });
});

describe("isErrnoException", () => {
  it("returns true for object with code, syscall, path", () => {
    const err = Object.assign(new Error("test"), { code: "ENOENT", syscall: "stat", path: "/foo" });
    assert.equal(isErrnoException(err), true);
  });

  it("returns false for plain Error", () => {
    assert.equal(isErrnoException(new Error("test")), false);
  });

  it("returns false for non-Error", () => {
    assert.equal(isErrnoException("string"), false);
    assert.equal(isErrnoException(null), false);
  });
});

describe("mapErrnoToStatus", () => {
  const cases: [string, number][] = [
    ["EACCES", 403],
    ["EPERM", 403],
    ["ENOENT", 404],
    ["EEXIST", 400],
    ["ENOTDIR", 409],
    ["EISDIR", 409],
    ["ENOTEMPTY", 409],
    ["EINVAL", 400],
    ["ENOSPC", 507],
    ["EFBIG", 507],
  ];

  for (const [code, expected] of cases) {
    it(`maps ${code} to ${expected}`, () => {
      const err = Object.assign(new Error(code), { code, syscall: "op", path: "/" });
      assert.equal(mapErrnoToStatus(err), expected);
    });
  }

  it("maps unknown code to 500", () => {
    const err = Object.assign(new Error("EUNKNOWN"), { code: "EUNKNOWN", syscall: "op", path: "/" });
    assert.equal(mapErrnoToStatus(err), 500);
  });
});

describe("createEtag", () => {
  it("returns a quoted hex string", async () => {
    const etag = await createEtag(new Uint8Array([1, 2, 3]));
    assert.match(etag, /^"[0-9a-f]{64}"$/);
  });

  it("returns same etag for same content", async () => {
    const a = await createEtag(new TextEncoder().encode("hello"));
    const b = await createEtag(new TextEncoder().encode("hello"));
    assert.equal(a, b);
  });

  it("returns different etags for different content", async () => {
    const a = await createEtag(new TextEncoder().encode("hello"));
    const b = await createEtag(new TextEncoder().encode("world"));
    assert.notEqual(a, b);
  });
});

describe("normalizePathLike", () => {
  it("normalizes path with double slashes", () => {
    assert.equal(normalizePathLike("/foo//bar"), "/foo/bar");
  });

  it("resolves dot segments", () => {
    assert.equal(normalizePathLike("/foo/./bar"), "/foo/bar");
  });

  it("resolves double dot segments", () => {
    assert.equal(normalizePathLike("/foo/bar/../baz"), "/foo/baz");
  });

  it("converts PathLike (Buffer) to string", () => {
    const result = normalizePathLike(Buffer.from("/foo/bar"));
    assert.equal(typeof result, "string");
  });
});

describe("readBufferOrStream", () => {
  function createFs() {
    return createKyselyFs(createTestDialect(), { dbType: "sqlite" });
  }

  it("returns a Buffer body for small files (≤ 1MB)", async () => {
    const fs = createFs();
    await fs.writeFile("/small.txt", "tiny");
    const { body, stat } = await readBufferOrStream(fs, "/small.txt");
    assert.ok(!(body instanceof Readable), "small files should be returned as a buffer");
    assert.equal(stat.size, 4);
  });

  it("returns a stream body for large files (> 1MB)", async () => {
    const fs = createFs();
    const data = Buffer.alloc(1024 * 1024 + 1, 0x41); // one byte over the threshold
    await fs.writeFile("/large.bin", data);
    const { body, stat } = await readBufferOrStream(fs, "/large.bin");
    assert.ok(body instanceof Readable, "large files should be streamed");
    assert.equal(stat.size, data.byteLength);
  });

  it("reuses a provided stat instead of re-statting", async () => {
    const fs = createFs();
    await fs.writeFile("/provided.txt", "x");
    const stat = await fs.stat("/provided.txt");
    const { stat: returned } = await readBufferOrStream(fs, "/provided.txt", stat);
    assert.equal(returned, stat);
  });
});

describe("convertToWebStream", () => {
  it("passes through a Uint8Array unchanged", () => {
    const buf = new Uint8Array([1, 2, 3]);
    assert.equal(convertToWebStream(buf), buf);
  });

  it("converts a Readable into a web ReadableStream", () => {
    const readable = Readable.from([Buffer.from("hello")]);
    const web = convertToWebStream(readable);
    assert.ok(web instanceof ReadableStream);
  });
});
