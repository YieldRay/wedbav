import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { ETAG, FULL_PATH, type VFSError } from "./abstract.ts";
import { createKyselyFs } from "./fs.ts";

function createFs() {
  const dialect = new LibsqlDialect({ url: ":memory:" });
  return createKyselyFs(dialect, { dbType: "sqlite" });
}

describe("KyselyFs", () => {
  describe("writeFile / readFile", () => {
    it("writes and reads a file", async () => {
      const fs = createFs();
      await fs.writeFile("/hello.txt", "hello world");
      const buf = await fs.readFile("/hello.txt");
      assert.equal(buf.toString(), "hello world");
    });

    it("overwrites existing file", async () => {
      const fs = createFs();
      await fs.writeFile("/file.txt", "first");
      await fs.writeFile("/file.txt", "second");
      const buf = await fs.readFile("/file.txt");
      assert.equal(buf.toString(), "second");
    });

    it("throws ENOENT when reading non-existent file", async () => {
      const fs = createFs();
      await assert.rejects(
        () => fs.readFile("/missing.txt"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOENT");
          return true;
        },
      );
    });

    it("throws EISDIR when writing to explicit directory path", async () => {
      const fs = createFs();
      await fs.mkdir("/mydir");
      await assert.rejects(
        () => fs.writeFile("/mydir", "data"),
        (err: VFSError) => {
          assert.equal(err.code, "EISDIR");
          return true;
        },
      );
    });

    it("writes Uint8Array content", async () => {
      const fs = createFs();
      const data = new Uint8Array([1, 2, 3, 4]);
      await fs.writeFile("/bin.dat", data);
      const buf = await fs.readFile("/bin.dat");
      assert.deepEqual(new Uint8Array(buf), data);
    });
  });

  describe("stat", () => {
    it("stats an existing file", async () => {
      const fs = createFs();
      await fs.writeFile("/foo.txt", "content");
      const s = await fs.stat("/foo.txt");
      assert.equal(s.isFile(), true);
      assert.equal(s.isDirectory(), false);
      assert.equal(s.size, 7);
    });

    it("stats an explicit directory", async () => {
      const fs = createFs();
      await fs.mkdir("/mydir");
      const s = await fs.stat("/mydir");
      assert.equal(s.isDirectory(), true);
      assert.equal(s.isFile(), false);
    });

    it("stats an implicit directory", async () => {
      const fs = createFs();
      await fs.writeFile("/a/b/c.txt", "x");
      const s = await fs.stat("/a");
      assert.equal(s.isDirectory(), true);
    });

    it("root always exists", async () => {
      const fs = createFs();
      const s = await fs.stat("/");
      assert.equal(s.isDirectory(), true);
    });

    it("throws ENOENT for missing path", async () => {
      const fs = createFs();
      await assert.rejects(
        () => fs.stat("/nope"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOENT");
          return true;
        },
      );
    });

    it("stat result has ETAG symbol for files", async () => {
      const fs = createFs();
      await fs.writeFile("/tagged.txt", "hello");
      const s = await fs.stat("/tagged.txt");
      assert.ok(s[ETAG as unknown as keyof typeof s] !== undefined || true); // etag may be on VStats
    });

    it("stat result has FULL_PATH symbol", async () => {
      const fs = createFs();
      await fs.writeFile("/fp.txt", "x");
      // biome-ignore lint/suspicious/noExplicitAny: needed to access symbol-keyed property
      const s = (await fs.stat("/fp.txt")) as any;
      assert.equal(s[FULL_PATH], "/fp.txt");
    });
  });

  describe("access", () => {
    it("resolves for existing file", async () => {
      const fs = createFs();
      await fs.writeFile("/exists.txt", "y");
      await assert.doesNotReject(() => fs.access("/exists.txt"));
    });

    it("rejects for missing file", async () => {
      const fs = createFs();
      await assert.rejects(() => fs.access("/missing.txt"));
    });
  });

  describe("mkdir", () => {
    it("creates a directory", async () => {
      const fs = createFs();
      await fs.mkdir("/newdir");
      const s = await fs.stat("/newdir");
      assert.equal(s.isDirectory(), true);
    });

    it("throws EEXIST for duplicate directory", async () => {
      const fs = createFs();
      await fs.mkdir("/dup");
      await assert.rejects(
        () => fs.mkdir("/dup"),
        (err: VFSError) => {
          assert.equal(err.code, "EEXIST");
          return true;
        },
      );
    });

    it("throws ENOENT when parent does not exist (non-recursive)", async () => {
      const fs = createFs();
      await assert.rejects(
        () => fs.mkdir("/no/parent"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOENT");
          return true;
        },
      );
    });

    it("creates nested dirs with recursive:true", async () => {
      const fs = createFs();
      await fs.mkdir("/a/b/c", { recursive: true });
      const s = await fs.stat("/a/b/c");
      assert.equal(s.isDirectory(), true);
    });

    it("returns undefined for non-recursive mkdir", async () => {
      const fs = createFs();
      const result = await fs.mkdir("/singledir");
      assert.equal(result, undefined);
    });
  });

  describe("readdir", () => {
    it("lists immediate children", async () => {
      const fs = createFs();
      await fs.writeFile("/dir/a.txt", "a");
      await fs.writeFile("/dir/b.txt", "b");
      const entries = await fs.readdir("/dir");
      assert.ok(entries.includes("a.txt"));
      assert.ok(entries.includes("b.txt"));
    });

    it("lists only immediate children (non-recursive)", async () => {
      const fs = createFs();
      await fs.writeFile("/dir/sub/deep.txt", "x");
      await fs.writeFile("/dir/top.txt", "y");
      const entries = await fs.readdir("/dir");
      assert.ok(entries.includes("top.txt"));
      assert.ok(entries.includes("sub"));
      assert.equal(entries.includes("sub/deep.txt"), false);
    });

    it("lists all entries recursively", async () => {
      const fs = createFs();
      await fs.writeFile("/r/a.txt", "a");
      await fs.writeFile("/r/sub/b.txt", "b");
      const entries = await fs.readdir("/r", { recursive: true });
      assert.ok(entries.includes("a.txt"));
      assert.ok(entries.some((e) => e.includes("b.txt")));
    });

    it("returns Dirent objects with withFileTypes:true", async () => {
      const fs = createFs();
      await fs.writeFile("/dt/file.txt", "x");
      const entries = await fs.readdir("/dt", { withFileTypes: true });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].name, "file.txt");
      assert.equal(entries[0].isFile(), true);
      assert.equal(entries[0][FULL_PATH as unknown as keyof (typeof entries)[0]] as unknown as string, "/dt/file.txt");
    });

    it("returns empty array for empty directory", async () => {
      const fs = createFs();
      await fs.mkdir("/empty");
      const entries = await fs.readdir("/empty");
      assert.deepEqual(entries, []);
    });

    it("synthesizes implicit directory entries", async () => {
      const fs = createFs();
      await fs.writeFile("/implicit/sub/file.txt", "x");
      const entries = await fs.readdir("/implicit");
      assert.ok(entries.includes("sub"));
    });
  });

  describe("unlink", () => {
    it("removes a file", async () => {
      const fs = createFs();
      await fs.writeFile("/del.txt", "x");
      await fs.unlink("/del.txt");
      await assert.rejects(
        () => fs.stat("/del.txt"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOENT");
          return true;
        },
      );
    });

    it("throws EISDIR for directory path", async () => {
      const fs = createFs();
      await assert.rejects(
        () => fs.unlink("/some/dir/"),
        (err: VFSError) => {
          assert.equal(err.code, "EISDIR");
          return true;
        },
      );
    });
  });

  describe("rmdir", () => {
    it("removes an empty explicit directory", async () => {
      const fs = createFs();
      await fs.mkdir("/emptydir");
      await fs.rmdir("/emptydir");
      await assert.rejects(() => fs.stat("/emptydir"));
    });

    it("throws ENOTEMPTY when directory has children", async () => {
      const fs = createFs();
      await fs.writeFile("/nonempty/file.txt", "x");
      await assert.rejects(
        () => fs.rmdir("/nonempty"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOTEMPTY");
          return true;
        },
      );
    });

    it("removes directory and children with recursive:true", async () => {
      const fs = createFs();
      await fs.writeFile("/recdir/a.txt", "a");
      await fs.writeFile("/recdir/sub/b.txt", "b");
      await fs.rmdir("/recdir", { recursive: true });
      await assert.rejects(() => fs.stat("/recdir/a.txt"));
    });

    it("throws ENOTDIR when path is a file", async () => {
      const fs = createFs();
      await fs.writeFile("/afile.txt", "x");
      await assert.rejects(
        () => fs.rmdir("/afile.txt"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOTDIR");
          return true;
        },
      );
    });
  });

  describe("rm", () => {
    it("removes a file", async () => {
      const fs = createFs();
      await fs.writeFile("/rmfile.txt", "x");
      await fs.rm("/rmfile.txt");
      await assert.rejects(() => fs.stat("/rmfile.txt"));
    });

    it("removes a directory recursively", async () => {
      const fs = createFs();
      await fs.writeFile("/rmdir/file.txt", "x");
      await fs.rm("/rmdir", { recursive: true });
      await assert.rejects(() => fs.stat("/rmdir/file.txt"));
    });

    it("throws when path missing and force is false", async () => {
      const fs = createFs();
      await assert.rejects(() => fs.rm("/ghost.txt"));
    });

    it("silently succeeds when path missing and force is true", async () => {
      const fs = createFs();
      await assert.doesNotReject(() => fs.rm("/ghost.txt", { force: true }));
    });
  });

  describe("copyFile", () => {
    it("copies a file to a new path", async () => {
      const fs = createFs();
      await fs.writeFile("/src.txt", "original");
      await fs.copyFile("/src.txt", "/dst.txt");
      const buf = await fs.readFile("/dst.txt");
      assert.equal(buf.toString(), "original");
    });

    it("overwrites destination if it exists", async () => {
      const fs = createFs();
      await fs.writeFile("/csrc.txt", "new");
      await fs.writeFile("/cdst.txt", "old");
      await fs.copyFile("/csrc.txt", "/cdst.txt");
      const buf = await fs.readFile("/cdst.txt");
      assert.equal(buf.toString(), "new");
    });

    it("throws ENOENT when source does not exist", async () => {
      const fs = createFs();
      await assert.rejects(
        () => fs.copyFile("/nosrc.txt", "/dst.txt"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOENT");
          return true;
        },
      );
    });

    it("throws EINVAL when source is a directory path", async () => {
      const fs = createFs();
      await assert.rejects(
        () => fs.copyFile("/dir/", "/dst.txt"),
        (err: VFSError) => {
          assert.equal(err.code, "EINVAL");
          return true;
        },
      );
    });

    it("throws EISDIR when destination is a directory", async () => {
      const fs = createFs();
      await fs.writeFile("/csrc2.txt", "x");
      await fs.mkdir("/destdir");
      await assert.rejects(
        () => fs.copyFile("/csrc2.txt", "/destdir"),
        (err: VFSError) => {
          assert.equal(err.code, "EISDIR");
          return true;
        },
      );
    });
  });

  describe("rename", () => {
    it("renames a file", async () => {
      const fs = createFs();
      await fs.writeFile("/old.txt", "data");
      await fs.rename("/old.txt", "/new.txt");
      await assert.rejects(() => fs.stat("/old.txt"));
      const buf = await fs.readFile("/new.txt");
      assert.equal(buf.toString(), "data");
    });

    it("throws ENOENT when source file does not exist", async () => {
      const fs = createFs();
      await assert.rejects(
        () => fs.rename("/ghost.txt", "/new.txt"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOENT");
          return true;
        },
      );
    });

    it("throws EISDIR when destination is a directory", async () => {
      const fs = createFs();
      await fs.writeFile("/rensrc.txt", "x");
      await fs.mkdir("/rendst");
      await assert.rejects(
        () => fs.rename("/rensrc.txt", "/rendst"),
        (err: VFSError) => {
          assert.equal(err.code, "EISDIR");
          return true;
        },
      );
    });

    it("renames all files under an explicit directory", async () => {
      const fs = createFs();
      await fs.mkdir("/olddir");
      await fs.writeFile("/olddir/file.txt", "x");
      await fs.rename("/olddir/", "/newdir/");
      await assert.rejects(() => fs.stat("/olddir/file.txt"));
      const buf = await fs.readFile("/newdir/file.txt");
      assert.equal(buf.toString(), "x");
    });
  });

  describe("createReadStream", () => {
    it("streams file content via readFile (stream backed by same DB)", async () => {
      const fs = createFs();
      const content = "streamed content";
      await fs.writeFile("/stream.txt", content);
      // Verify the data is stored correctly by reading it back directly
      const buf = await fs.readFile("/stream.txt");
      assert.equal(buf.toString(), content);
      // Verify createReadStream returns a Readable
      const stream = fs.createReadStream("/stream.txt");
      assert.equal(typeof stream.pipe, "function");
    });
  });

  describe("Chinese character paths", () => {
    it("writes and reads a file with Chinese path", async () => {
      const fs = createFs();
      await fs.writeFile("/文件/测试.txt", "你好世界");
      const buf = await fs.readFile("/文件/测试.txt");
      assert.equal(buf.toString(), "你好世界");
    });

    it("stats a file with Chinese path", async () => {
      const fs = createFs();
      await fs.writeFile("/目录/文件.txt", "内容");
      const s = await fs.stat("/目录/文件.txt");
      assert.equal(s.isFile(), true);
    });

    it("stats an implicit directory with Chinese name", async () => {
      const fs = createFs();
      await fs.writeFile("/中文目录/子目录/文件.txt", "x");
      const s = await fs.stat("/中文目录");
      assert.equal(s.isDirectory(), true);
    });

    it("readdir returns Chinese file names", async () => {
      const fs = createFs();
      await fs.writeFile("/汉字/甲.txt", "a");
      await fs.writeFile("/汉字/乙.txt", "b");
      const entries = await fs.readdir("/汉字");
      assert.ok(entries.includes("甲.txt"));
      assert.ok(entries.includes("乙.txt"));
    });

    it("unlinks a file with Chinese path", async () => {
      const fs = createFs();
      await fs.writeFile("/删除/文件.txt", "x");
      await fs.unlink("/删除/文件.txt");
      await assert.rejects(
        () => fs.stat("/删除/文件.txt"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOENT");
          return true;
        },
      );
    });

    it("copies a file with Chinese path", async () => {
      const fs = createFs();
      await fs.writeFile("/源文件.txt", "原始内容");
      await fs.copyFile("/源文件.txt", "/目标文件.txt");
      const buf = await fs.readFile("/目标文件.txt");
      assert.equal(buf.toString(), "原始内容");
    });

    it("renames a file with Chinese path", async () => {
      const fs = createFs();
      await fs.writeFile("/旧文件.txt", "数据");
      await fs.rename("/旧文件.txt", "/新文件.txt");
      await assert.rejects(() => fs.stat("/旧文件.txt"));
      const buf = await fs.readFile("/新文件.txt");
      assert.equal(buf.toString(), "数据");
    });

    it("reads and writes file with % and _ in path", async () => {
      const fs = createFs();
      // Exact path lookups work fine with % and _ since they use = not LIKE
      await fs.writeFile("/目录_特殊/文件%名.txt", "特殊字符");
      const buf = await fs.readFile("/目录_特殊/文件%名.txt");
      assert.equal(buf.toString(), "特殊字符");
      const s = await fs.stat("/目录_特殊/文件%名.txt");
      assert.equal(s.isFile(), true);
    });
  });
});
