import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { davXML, escapeXML } from "./xml.ts";

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

describe("davXML", () => {
  const date = new Date("2020-01-02T03:04:05Z");

  it("emits a multistatus root with a self response for a directory listing", () => {
    // The PROPFIND handler passes the collection path without a trailing slash;
    // davXML appends the slash for directory hrefs.
    const xml = davXML(date, "/dir", []);
    assert.ok(xml.startsWith('<?xml version="1.0"'), xml);
    assert.ok(xml.includes('<d:multistatus xmlns:d="DAV:">'), xml);
    assert.ok(xml.includes("<d:href>/dir/</d:href>"), xml);
    // directory self entry advertises a collection resourcetype
    assert.ok(xml.includes("<d:collection/>"), xml);
  });

  it("renders one response element per child entry", () => {
    const xml = davXML(date, "/dir", [
      { path: "/dir/a.txt", contentlength: 3, lastmodified: date, isdir: false },
      { path: "/dir/sub", contentlength: 0, lastmodified: date, isdir: true },
    ]);
    assert.ok(xml.includes("<d:href>/dir/a.txt</d:href>"), xml);
    assert.ok(xml.includes("<d:getcontentlength>3</d:getcontentlength>"), xml);
    // directory child href carries a trailing slash
    assert.ok(xml.includes("<d:href>/dir/sub/</d:href>"), xml);
    assert.ok(xml.includes("httpd/unix-directory"), xml);
  });

  it("percent-encodes special characters in hrefs", () => {
    const xml = davXML(date, "/", [{ path: "/a&b.txt", contentlength: 1, lastmodified: date, isdir: false }]);
    assert.ok(xml.includes("/a%26b.txt"), xml);
    assert.ok(!xml.includes("<d:href>/a&b.txt</d:href>"), "raw & must not appear in href");
  });

  it("renders a single file response when passed `true`", () => {
    const xml = davXML(date, "/file.txt", true);
    assert.ok(xml.includes("<d:href>/file.txt</d:href>"), xml);
    // file entry has no collection resourcetype
    assert.ok(!xml.includes("<d:collection/>"), xml);
    assert.ok(xml.includes("application/octet-stream"), xml);
  });
});
