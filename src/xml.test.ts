import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeXML } from "./xml.ts";

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
