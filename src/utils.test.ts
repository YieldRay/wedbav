import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEtag,
  decodeURISafe,
  encodePathForSQL,
  escapeXML,
  getPathnameFromURL,
  isErrnoException,
  mapErrnoToStatus,
  normalizePathLike,
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

describe("escapeXML", () => {
  it("escapes &", () => {
    assert.equal(escapeXML("a & b"), "a &amp; b");
  });

  it("escapes <", () => {
    assert.equal(escapeXML("a < b"), "a &lt; b");
  });

  it("escapes >", () => {
    assert.equal(escapeXML("a > b"), "a &gt; b");
  });

  it("escapes single quote", () => {
    assert.equal(escapeXML("it's"), "it&apos;s");
  });

  it("escapes double quote", () => {
    assert.equal(escapeXML('"hello"'), "&quot;hello&quot;");
  });

  it("escapes all special chars in one string", () => {
    assert.equal(escapeXML('<a href="x&y">it\'s</a>'), "&lt;a href=&quot;x&amp;y&quot;&gt;it&apos;s&lt;/a&gt;");
  });

  it("leaves plain text unchanged", () => {
    assert.equal(escapeXML("hello world"), "hello world");
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
