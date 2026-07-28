import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dialectFromConnectionString } from "./connection-string.ts";

describe("dialectFromConnectionString", () => {
  it("defaults empty string to in-memory sqlite", () => {
    const { dbType, dialect } = dialectFromConnectionString("");
    assert.equal(dbType, "sqlite");
    assert.ok(dialect);
  });

  it("resolves 'memory' to sqlite", () => {
    assert.equal(dialectFromConnectionString("memory").dbType, "sqlite");
  });

  it("resolves ':memory:' to sqlite", () => {
    assert.equal(dialectFromConnectionString(":memory:").dbType, "sqlite");
  });

  it("resolves file: URLs to sqlite", () => {
    assert.equal(dialectFromConnectionString("file:/tmp/test.sqlite").dbType, "sqlite");
  });

  it("resolves libsql: URLs to sqlite", () => {
    assert.equal(dialectFromConnectionString("libsql://example.turso.io").dbType, "sqlite");
  });

  it("resolves libsql: URLs with an auth token to sqlite", () => {
    assert.equal(dialectFromConnectionString("libsql://user:token@example.turso.io").dbType, "sqlite");
  });

  it("resolves postgres: URLs to pg", () => {
    assert.equal(dialectFromConnectionString("postgres://user:pw@localhost:5432/db").dbType, "pg");
  });

  it("resolves postgresql: URLs to pg", () => {
    assert.equal(dialectFromConnectionString("postgresql://user:pw@localhost:5432/db").dbType, "pg");
  });

  it("resolves pg: URLs to pg (via Pool)", () => {
    assert.equal(dialectFromConnectionString("pg://user:pw@localhost:5432/db").dbType, "pg");
  });

  it("throws for an unsupported scheme", () => {
    assert.throws(() => dialectFromConnectionString("mysql://user:pw@localhost/db"), /Unsupported connection string/);
  });
});
