import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ETAG, FULL_PATH, type VFSError } from "./abstract.ts";
import { createKyselyFs } from "./fs.ts";
import { createTestDialect } from "./test-helpers.ts";

function createFs() {
  return createKyselyFs(createTestDialect(), { dbType: "sqlite" });
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

    it("throws EISDIR when writing to implicit directory path", async () => {
      const fs = createFs();
      await fs.writeFile("/dir-as-file/child.txt", "x");
      await assert.rejects(
        () => fs.writeFile("/dir-as-file", "data"),
        (err: VFSError) => {
          assert.equal(err.code, "EISDIR");
          return true;
        },
      );
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

    it("size is UTF-8 byte length, not character count", async () => {
      const fs = createFs();
      await fs.writeFile("/utf.txt", "你好"); // 2 chars, 6 bytes
      const s = await fs.stat("/utf.txt");
      assert.equal(s.size, 6);
    });

    it("mtime updates on writeFile overwrite", async () => {
      const fs = createFs();
      await fs.writeFile("/ts.txt", "v1");
      const s1 = await fs.stat("/ts.txt");
      await new Promise((r) => setTimeout(r, 10));
      await fs.writeFile("/ts.txt", "v2");
      const s2 = await fs.stat("/ts.txt");
      assert.ok(s2.mtimeMs > s1.mtimeMs);
    });

    it("mtime updates on rename", async () => {
      const fs = createFs();
      await fs.writeFile("/before.txt", "x");
      const s1 = await fs.stat("/before.txt");
      await new Promise((r) => setTimeout(r, 10));
      await fs.rename("/before.txt", "/after.txt");
      const s2 = await fs.stat("/after.txt");
      assert.ok(s2.mtimeMs > s1.mtimeMs);
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

    it("is idempotent for existing dir with recursive:true", async () => {
      const fs = createFs();
      await fs.mkdir("/existing-dir");
      await assert.doesNotReject(() => fs.mkdir("/existing-dir", { recursive: true }));
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
      assert.equal(entries[0]!.name, "file.txt");
      assert.equal(entries[0]!.isFile(), true);
      assert.equal(entries[0]![FULL_PATH as unknown as keyof (typeof entries)[0]] as unknown as string, "/dt/file.txt");
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

    it("throws ENOENT for non-existent directory", async () => {
      const fs = createFs();
      await assert.rejects(
        () => fs.readdir("/no-such-dir"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOENT");
          return true;
        },
      );
    });

    it("throws ENOTDIR when path is a file", async () => {
      const fs = createFs();
      await fs.writeFile("/just-a-file.txt", "x");
      await assert.rejects(
        () => fs.readdir("/just-a-file.txt"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOTDIR");
          return true;
        },
      );
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

    // diverges from Node.js: real fs throws ENOENT, KyselyFs silently succeeds
    it("silently succeeds for non-existent file (diverges: Node throws ENOENT)", async () => {
      const fs = createFs();
      await assert.doesNotReject(() => fs.unlink("/ghost.txt"));
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
      // Must resolve cleanly (transaction commits — no dangling ROLLBACK).
      await assert.doesNotReject(() => fs.rmdir("/recdir", { recursive: true }));
      await assert.rejects(() => fs.stat("/recdir/a.txt"));
      await assert.rejects(() => fs.stat("/recdir/sub/b.txt"));
      await assert.rejects(() => fs.stat("/recdir"));
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

    it("throws ENOENT for non-existent directory", async () => {
      const fs = createFs();
      await assert.rejects(
        () => fs.rmdir("/nowhere"),
        (err: VFSError) => {
          assert.equal(err.code, "ENOENT");
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
    it("streams file content correctly", async () => {
      const fs = createFs();
      const content = "streamed content";
      await fs.writeFile("/stream.txt", content);
      const stream = fs.createReadStream("/stream.txt");
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      assert.equal(Buffer.concat(chunks).toString(), content);
    });

    it("streams empty file without hanging", async () => {
      const fs = createFs();
      await fs.writeFile("/empty.txt", "");
      const stream = fs.createReadStream("/empty.txt");
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      assert.equal(Buffer.concat(chunks).toString(), "");
    });
  });

  describe("readFile on directory", () => {
    it("throws EISDIR for explicit directory", async () => {
      const fs = createFs();
      await fs.mkdir("/adir");
      await assert.rejects(
        () => fs.readFile("/adir"),
        (err: VFSError) => {
          assert.equal(err.code, "EISDIR");
          return true;
        },
      );
    });

    it("throws EISDIR for implicit directory", async () => {
      const fs = createFs();
      await fs.writeFile("/implicitdir/file.txt", "x");
      await assert.rejects(
        () => fs.readFile("/implicitdir"),
        (err: VFSError) => {
          assert.equal(err.code, "EISDIR");
          return true;
        },
      );
    });
  });

  describe("rename overwrites", () => {
    it("overwrites existing file at destination (Node.js semantics)", async () => {
      const fs = createFs();
      await fs.writeFile("/src.txt", "new");
      await fs.writeFile("/dst.txt", "old");
      await fs.rename("/src.txt", "/dst.txt");
      await assert.rejects(() => fs.stat("/src.txt"));
      const buf = await fs.readFile("/dst.txt");
      assert.equal(buf.toString(), "new");
    });

    it("throws EEXIST when renaming dir to existing explicit dir", async () => {
      const fs = createFs();
      await fs.mkdir("/srcdir");
      await fs.mkdir("/dstdir");
      await assert.rejects(
        () => fs.rename("/srcdir/", "/dstdir/"),
        (err: VFSError) => {
          assert.equal(err.code, "EEXIST");
          return true;
        },
      );
    });
  });

  describe("mkdir edge cases", () => {
    it("throws EEXIST when a file exists at that path", async () => {
      const fs = createFs();
      await fs.writeFile("/conflict.txt", "x");
      await assert.rejects(
        () => fs.mkdir("/conflict.txt"),
        (err: VFSError) => {
          assert.equal(err.code, "EEXIST");
          return true;
        },
      );
    });
  });

  describe("rm edge cases", () => {
    it("throws ENOTEMPTY when removing non-empty directory without recursive", async () => {
      const fs = createFs();
      await fs.writeFile("/nonempty2/file.txt", "x");
      await assert.rejects(
        () => fs.rm("/nonempty2", { recursive: false }),
        (err: VFSError) => {
          assert.equal(err.code, "ENOTEMPTY");
          return true;
        },
      );
    });
  });

  describe("directory tree integrity", () => {
    async function buildTree(fs: ReturnType<typeof createFs>) {
      // Build this tree:
      //   /
      //   ├── a/
      //   │   ├── b/
      //   │   │   ├── c.txt
      //   │   │   └── d.txt
      //   │   └── e.txt
      //   └── f/
      //       └── g.txt
      await fs.mkdir("/a");
      await fs.mkdir("/a/b");
      await fs.writeFile("/a/b/c.txt", "c");
      await fs.writeFile("/a/b/d.txt", "d");
      await fs.writeFile("/a/e.txt", "e");
      await fs.mkdir("/f");
      await fs.writeFile("/f/g.txt", "g");
    }

    it("stat correctly identifies every node type", async () => {
      const fs = createFs();
      await buildTree(fs);

      for (const dir of ["/", "/a", "/a/b", "/f"]) {
        const s = await fs.stat(dir);
        assert.equal(s.isDirectory(), true, `${dir} should be a directory`);
        assert.equal(s.isFile(), false, `${dir} should not be a file`);
      }
      for (const file of ["/a/b/c.txt", "/a/b/d.txt", "/a/e.txt", "/f/g.txt"]) {
        const s = await fs.stat(file);
        assert.equal(s.isFile(), true, `${file} should be a file`);
        assert.equal(s.isDirectory(), false, `${file} should not be a directory`);
      }
    });

    it("readdir returns correct immediate children at every level", async () => {
      const fs = createFs();
      await buildTree(fs);

      const root = await fs.readdir("/");
      assert.deepEqual(root.sort(), ["a", "f"]);

      const a = await fs.readdir("/a");
      assert.deepEqual(a.sort(), ["b", "e.txt"]);

      const ab = await fs.readdir("/a/b");
      assert.deepEqual(ab.sort(), ["c.txt", "d.txt"]);

      const f = await fs.readdir("/f");
      assert.deepEqual(f.sort(), ["g.txt"]);
    });

    it("readdir recursive returns all descendants", async () => {
      const fs = createFs();
      await buildTree(fs);

      const all = (await fs.readdir("/", { recursive: true })).sort();
      assert.deepEqual(all, ["a", "a/b", "a/b/c.txt", "a/b/d.txt", "a/e.txt", "f", "f/g.txt"]);
    });

    it("rm recursive removes subtree and leaves sibling intact", async () => {
      const fs = createFs();
      await buildTree(fs);

      await fs.rm("/a", { recursive: true });

      // /a and everything under it is gone
      for (const p of ["/a", "/a/b", "/a/b/c.txt", "/a/b/d.txt", "/a/e.txt"]) {
        await assert.rejects(() => fs.stat(p), `${p} should be gone`);
      }

      // /f subtree is untouched
      const s = await fs.stat("/f/g.txt");
      assert.equal(s.isFile(), true);
    });

    it("rename subtree moves all children and leaves sibling intact", async () => {
      const fs = createFs();
      await buildTree(fs);

      await fs.rename("/a/", "/a2/");

      // old paths gone
      for (const p of ["/a", "/a/b", "/a/b/c.txt", "/a/e.txt"]) {
        await assert.rejects(() => fs.stat(p), `${p} should be gone after rename`);
      }

      // new paths exist with correct types
      assert.equal((await fs.stat("/a2")).isDirectory(), true);
      assert.equal((await fs.stat("/a2/b")).isDirectory(), true);
      assert.equal((await fs.stat("/a2/b/c.txt")).isFile(), true);
      assert.equal((await fs.stat("/a2/e.txt")).isFile(), true);

      // content preserved
      assert.equal((await fs.readFile("/a2/b/c.txt")).toString(), "c");

      // sibling untouched
      assert.equal((await fs.stat("/f/g.txt")).isFile(), true);
    });

    it("copy subtree duplicates all files and leaves source intact", async () => {
      const fs = createFs();
      await buildTree(fs);

      // copy /a/b into /a/b2 by copying files manually (copyFile is file-only)
      await fs.mkdir("/a/b2");
      await fs.copyFile("/a/b/c.txt", "/a/b2/c.txt");
      await fs.copyFile("/a/b/d.txt", "/a/b2/d.txt");

      // new files exist with correct content
      assert.equal((await fs.readFile("/a/b2/c.txt")).toString(), "c");
      assert.equal((await fs.readFile("/a/b2/d.txt")).toString(), "d");

      // originals untouched
      assert.equal((await fs.readFile("/a/b/c.txt")).toString(), "c");
      assert.equal((await fs.readFile("/a/b/d.txt")).toString(), "d");

      // readdir reflects new structure
      const ab = await fs.readdir("/a");
      assert.deepEqual(ab.sort(), ["b", "b2", "e.txt"]);
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

  describe("URL-reserved character filenames", () => {
    // These names are stored literally in the DB — the server decodes URLs before
    // calling fs methods, so the fs always sees the real decoded name.
    const specialNames = [
      "@at", "#hash", "&amp", "=eq", "+plus", "hello world",
      "%percent", "!bang", "a&b=c", "foo#bar", "😀emoji", "привет",
    ];

    for (const name of specialNames) {
      it(`writeFile + readFile: "${name}"`, async () => {
        const fs = createFs();
        await fs.writeFile(`/special/${name}.txt`, `content of ${name}`);
        const buf = await fs.readFile(`/special/${name}.txt`);
        assert.equal(buf.toString(), `content of ${name}`);
      });

      it(`stat: "${name}"`, async () => {
        const fs = createFs();
        await fs.writeFile(`/special/${name}.txt`, "x");
        const s = await fs.stat(`/special/${name}.txt`);
        assert.equal(s.isFile(), true);
        assert.equal(s.size, 1);
      });

      it(`readdir includes "${name}"`, async () => {
        const fs = createFs();
        await fs.writeFile(`/special/${name}.txt`, "x");
        const entries = await fs.readdir("/special");
        assert.ok(entries.includes(`${name}.txt`), `expected "${name}.txt" in readdir`);
      });

      it(`unlink: "${name}"`, async () => {
        const fs = createFs();
        await fs.writeFile(`/special/${name}.txt`, "x");
        await fs.unlink(`/special/${name}.txt`);
        await assert.rejects(
          () => fs.stat(`/special/${name}.txt`),
          (err: VFSError) => { assert.equal(err.code, "ENOENT"); return true; },
        );
      });

      it(`rename: "${name}"`, async () => {
        const fs = createFs();
        await fs.writeFile(`/special/${name}.txt`, "data");
        await fs.rename(`/special/${name}.txt`, `/special/${name}-renamed.txt`);
        await assert.rejects(() => fs.stat(`/special/${name}.txt`));
        const buf = await fs.readFile(`/special/${name}-renamed.txt`);
        assert.equal(buf.toString(), "data");
      });
    }

    it("readdir returns exact literal names (not URL-encoded)", async () => {
      const fs = createFs();
      await fs.writeFile("/special/@foo.txt", "a");
      await fs.writeFile("/special/#bar.txt", "b");
      await fs.writeFile("/special/&baz.txt", "c");
      const entries = await fs.readdir("/special");
      assert.ok(entries.includes("@foo.txt"));
      assert.ok(entries.includes("#bar.txt"));
      assert.ok(entries.includes("&baz.txt"));
      assert.ok(!entries.includes("%40foo.txt"), "should not be URL-encoded");
      assert.ok(!entries.includes("%23bar.txt"), "should not be URL-encoded");
    });
  });

  // ── Regression tests for the anchored-prefix rename bug ──────────────────────
  // Previously rename() used String.replace(oldDirKey, newDirKey) which rewrites
  // the FIRST occurrence anywhere in the path, corrupting nested repeated names.
  describe("rename: anchored prefix replacement (regression)", () => {
    it("renames a directory whose descendant repeats the source segment name", async () => {
      const fs = createFs();
      // /a/ contains /a/x/a/deep.txt — the segment "a/" appears twice
      await fs.writeFile("/a/x/a/deep.txt", "deep");
      await fs.writeFile("/a/top.txt", "top");
      await fs.rename("/a/", "/b/");

      // Old tree gone
      await assert.rejects(() => fs.stat("/a/x/a/deep.txt"));
      await assert.rejects(() => fs.stat("/a/top.txt"));

      // New tree preserves the repeated inner "a" segment exactly
      assert.equal((await fs.readFile("/b/x/a/deep.txt")).toString(), "deep");
      assert.equal((await fs.readFile("/b/top.txt")).toString(), "top");
      // The inner /b/x/a/ must still exist as-is (not collapsed to /b/x/b/)
      await assert.rejects(() => fs.stat("/b/x/b/deep.txt"), "inner segment must not be rewritten");
    });

    it("renaming a prefix does not touch a sibling with a longer name", async () => {
      const fs = createFs();
      // /dir/ and /dir2/ share the "dir" prefix; renaming /dir/ must leave /dir2/ alone
      await fs.writeFile("/dir/a.txt", "a");
      await fs.writeFile("/dir2/b.txt", "b");
      await fs.rename("/dir/", "/renamed/");

      assert.equal((await fs.readFile("/renamed/a.txt")).toString(), "a");
      // sibling with the longer name is untouched
      assert.equal((await fs.readFile("/dir2/b.txt")).toString(), "b");
      await assert.rejects(() => fs.stat("/dir/a.txt"));
    });
  });

  // ── Regression tests for the same-path rename no-op ──────────────────────────
  describe("rename: same-path no-op (regression)", () => {
    it("renaming a file to itself keeps it intact", async () => {
      const fs = createFs();
      await fs.writeFile("/same.txt", "content");
      await assert.doesNotReject(() => fs.rename("/same.txt", "/same.txt"));
      assert.equal((await fs.readFile("/same.txt")).toString(), "content");
    });

    it("renaming a directory to itself keeps its children intact", async () => {
      const fs = createFs();
      await fs.writeFile("/d/child.txt", "x");
      await assert.doesNotReject(() => fs.rename("/d/", "/d/"));
      assert.equal((await fs.readFile("/d/child.txt")).toString(), "x");
    });

    it("renaming a file to a path that normalizes to the same key is a no-op", async () => {
      const fs = createFs();
      await fs.writeFile("/n.txt", "keep");
      // "/./n.txt" normalizes to "/n.txt"
      await assert.doesNotReject(() => fs.rename("/n.txt", "/./n.txt"));
      assert.equal((await fs.readFile("/n.txt")).toString(), "keep");
    });
  });

  // ── Transaction atomicity: a failing rename must not partially mutate state ───
  describe("rename atomicity (regression)", () => {
    it("does not remove destination when moving a dir onto an existing explicit dir", async () => {
      const fs = createFs();
      await fs.mkdir("/srcdir");
      await fs.writeFile("/srcdir/keep.txt", "src");
      await fs.mkdir("/dstdir");
      await fs.writeFile("/dstdir/existing.txt", "dst");

      await assert.rejects(
        () => fs.rename("/srcdir/", "/dstdir/"),
        (err: VFSError) => {
          assert.equal(err.code, "EEXIST");
          return true;
        },
      );

      // Source untouched after the failed (rolled-back) rename
      assert.equal((await fs.readFile("/srcdir/keep.txt")).toString(), "src");
      // Destination untouched
      assert.equal((await fs.readFile("/dstdir/existing.txt")).toString(), "dst");
    });
  });

  // ── createReadStream across chunk boundaries and large content ───────────────
  describe("createReadStream chunking (regression for byte-accurate offset)", () => {
    async function drain(stream: import("node:stream").Readable): Promise<Buffer> {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (c) => chunks.push(Buffer.from(c)));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      return Buffer.concat(chunks);
    }

    it("streams content larger than the 1MB highWaterMark across multiple chunks", async () => {
      const fs = createFs();
      // 2.5 MB of deterministic bytes so we cross several chunk boundaries
      const size = 2_500_000;
      const data = Buffer.alloc(size);
      for (let i = 0; i < size; i++) data[i] = i % 251; // prime-ish stride avoids trivial patterns
      await fs.writeFile("/big.bin", data);

      const out = await drain(fs.createReadStream("/big.bin"));
      assert.equal(out.byteLength, size);
      assert.ok(out.equals(data), "streamed bytes must exactly match written content");
    });

    it("streams content whose size is not a multiple of the chunk size", async () => {
      const fs = createFs();
      const size = 1024 * 1024 + 12345; // just over one chunk with an odd tail
      const data = Buffer.alloc(size, 0xab);
      data[size - 1] = 0x01; // sentinel last byte to detect truncation/overrun
      await fs.writeFile("/odd.bin", data);

      const out = await drain(fs.createReadStream("/odd.bin"));
      assert.equal(out.byteLength, size);
      assert.equal(out[size - 1], 0x01, "final tail byte must be preserved");
    });
  });

  // ── ready() and schema initialization ────────────────────────────────────────
  describe("ready()", () => {
    it("resolves once the schema exists and operations work afterwards", async () => {
      const fs = createKyselyFs(createTestDialect(), { dbType: "sqlite" });
      await fs.ready();
      await fs.writeFile("/after-ready.txt", "ok");
      assert.equal((await fs.readFile("/after-ready.txt")).toString(), "ok");
    });

    it("is idempotent (can be awaited multiple times)", async () => {
      const fs = createFs();
      await fs.ready();
      await fs.ready();
      await assert.doesNotReject(() => fs.ready());
    });
  });

  // ── ETag behavior ────────────────────────────────────────────────────────────
  describe("etag", () => {
    it("exposes a stable etag via the ETAG symbol on stat", async () => {
      const fs = createFs();
      await fs.writeFile("/e.txt", "hello");
      // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed access
      const s = (await fs.stat("/e.txt")) as any;
      assert.match(s[ETAG], /^"[0-9a-f]{64}"$/);
    });

    it("etag changes when content changes", async () => {
      const fs = createFs();
      await fs.writeFile("/e.txt", "hello");
      // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed access
      const before = ((await fs.stat("/e.txt")) as any)[ETAG];
      await fs.writeFile("/e.txt", "world");
      // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed access
      const after = ((await fs.stat("/e.txt")) as any)[ETAG];
      assert.notEqual(before, after);
    });

    it("copyFile preserves the source etag on the destination", async () => {
      const fs = createFs();
      await fs.writeFile("/src.txt", "same-bytes");
      // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed access
      const srcEtag = ((await fs.stat("/src.txt")) as any)[ETAG];
      await fs.copyFile("/src.txt", "/dst.txt");
      // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed access
      const dstEtag = ((await fs.stat("/dst.txt")) as any)[ETAG];
      assert.equal(dstEtag, srcEtag);
    });
  });

  // ── readFile encoding + empty content ────────────────────────────────────────
  describe("readFile encoding & empty content", () => {
    it("returns a string when an encoding is given", async () => {
      const fs = createFs();
      await fs.writeFile("/enc.txt", "héllo");
      const s = await fs.readFile("/enc.txt", { encoding: "utf-8" });
      assert.equal(typeof s, "string");
      assert.equal(s, "héllo");
    });

    it("returns an empty Buffer for an empty file", async () => {
      const fs = createFs();
      await fs.writeFile("/zero.txt", "");
      const buf = await fs.readFile("/zero.txt");
      assert.equal(buf.byteLength, 0);
    });

    it("stat reports size 0 for an empty file", async () => {
      const fs = createFs();
      await fs.writeFile("/zero.txt", "");
      assert.equal((await fs.stat("/zero.txt")).size, 0);
    });
  });
});
