import { Buffer } from "node:buffer";
import path from "node:path/posix";
import type { Dirent, Stats } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { encodeBase64, decodeBase64 } from "hono/utils/encode";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";
import z from "zod/v4";
import type { FsSubset } from "./abstract.ts";
import { isErrnoException, mapErrnoToStatus } from "./utils.ts";

const FileType = z.union([z.literal(1), z.literal(2)]);
type FileType = z.infer<typeof FileType>;

const FileStat = z.object({
  type: FileType,
  ctime: z.number(),
  mtime: z.number(),
  size: z.number(),
  permissions: z.literal(1).optional(),
});

const ReadDirectoryResponse = z.array(
  z.object({
    name: z.string(),
    type: FileType,
  })
);

const DefaultSuccess = z.object({
  success: z.boolean(),
});

/**
 * The api router, will only handle the request that have header `accept: application/json`
 */
export function createHonoAPI<Prefix extends string>(
  fs: FsSubset,
  options: {
    readOnly?: boolean;
    prefix?: Prefix;
  } = {}
) {
  const PREFIX = options.prefix ?? "/fs";
  const readOnly = options.readOnly ?? false;

  const api = new Hono();

  api.post(
    "/stat",
    describeRoute({
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: resolver(FileStat),
            },
          },
        },
        400: describeError("Bad Request"),
        404: describeError("Not Found"),
      },
    }),
    zValidator(
      "json",
      z.object({
        path: z.string(),
      })
    ),
    async (c) => {
      const body = c.req.valid("json");
      const targetPath = body.path;
      try {
        const stat = await fs.stat(targetPath);
        return c.json({
          type: stat.isDirectory() ? 2 : 1,
          ctime: getTime(stat.birthtimeMs ?? stat.ctimeMs),
          mtime: getTime(stat.mtimeMs),
          size: stat.size,
          permissions: readOnly ? 1 : undefined,
        });
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return c.json({ error: "Not Found" }, 404);
        }
        throw error;
      }
    }
  );

  api.post(
    "/readDirectory",
    describeRoute({
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: resolver(ReadDirectoryResponse),
            },
          },
        },
        400: describeError("Bad Request"),
        404: describeError("Not Found"),
      },
    }),
    zValidator(
      "json",
      z.object({
        path: z.string(),
      })
    ),
    async (c) => {
      const body = c.req.valid("json");
      const directoryPath = body.path;

      try {
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });
        const items = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 2 : 1,
        }));
        return c.json(items);
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return c.json({ error: "Not Found" }, 404);
        }
        throw error;
      }
    }
  );

  api.post(
    "/createDirectory",
    describeRoute({
      responses: {
        200: describeSuccess(),
        400: describeError("Bad Request"),
      },
    }),
    zValidator(
      "json",
      z.object({
        path: z.string(),
      })
    ),
    async (c) => {
      const body = c.req.valid("json");
      const directoryPath = body.path;

      if (readOnly) {
        return c.json({ error: "File is readonly" }, 400);
      }

      try {
        await fs.mkdir(directoryPath, { recursive: true });
        return c.json({ success: true });
      } catch (error) {
        if (isErrnoException(error)) {
          return c.json({ error: error.message }, mapErrnoToStatus(error));
        }
        throw error;
      }
    }
  );

  api.post(
    "/readFile",
    describeRoute({
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  success: z.literal(true),
                  b64: z.string(),
                })
              ),
            },
          },
        },
        400: describeError("Bad Request"),
        404: describeError("File not found"),
      },
    }),
    zValidator(
      "json",
      z.object({
        path: z.string(),
      })
    ),
    async (c) => {
      const body = c.req.valid("json");
      const filePath = body.path;

      try {
        const content = await fs.readFile(filePath);
        const bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
        return c.json({
          success: true,
          b64: encodeBase64(toArrayBuffer(bytes)),
        });
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return c.json({ error: "File not found" }, 404);
        }
        throw error;
      }
    }
  );

  api.post(
    "/writeFile",
    describeRoute({
      responses: {
        200: describeSuccess(),
        400: describeError("Bad Request"),
        404: describeError("File not found"),
      },
    }),
    zValidator(
      "json",
      z.object({
        path: z.string(),
        b64: z.string(),
        options: z
          .object({
            create: z.boolean(),
            overwrite: z.boolean(),
          })
          .optional(),
      })
    ),
    async (c) => {
      const body = c.req.valid("json");
      const filePath = body.path;

      if (readOnly) {
        return c.json({ error: "File is readonly" }, 400);
      }

      const { create = true, overwrite = true } = body.options ?? {};

      const exists = await pathExists(fs, filePath);
      if (!create && !exists) {
        return c.json({ error: "File not found" }, 404);
      }
      if (!overwrite && exists) {
        return c.json({ error: "File already exists" }, 400);
      }

      try {
        await ensureParentDirectory(fs, filePath);
        const content = Buffer.from(decodeBase64(body.b64));
        await fs.writeFile(filePath, content);
        return c.json({ success: true });
      } catch (error) {
        if (isErrnoException(error)) {
          return c.json({ error: error.message }, mapErrnoToStatus(error));
        }
        throw error;
      }
    }
  );

  api.post(
    "/copy",
    describeRoute({
      responses: {
        200: describeSuccess(),
        400: describeError("Bad Request"),
        404: describeError("Not Found"),
      },
    }),
    zValidator(
      "json",
      z.object({
        source: z.string(),
        destination: z.string(),
        options: z
          .object({
            overwrite: z.boolean(),
          })
          .optional(),
      })
    ),
    async (c) => {
      const body = c.req.valid("json");
      const sourcePath = body.source;
      const destinationPath = body.destination;

      if (readOnly) {
        return c.json({ error: "File is readonly" }, 400);
      }

      try {
        const sourceStat = await fs.stat(sourcePath);
        const overwrite = body.options?.overwrite ?? false;
        await performCopy(fs, sourcePath, destinationPath, sourceStat, overwrite);
        return c.json({ success: true });
      } catch (error) {
        if (isErrnoException(error)) {
          const status = error.code === "ENOENT" ? 404 : mapErrnoToStatus(error);
          return c.json({ error: error.message }, status);
        }
        throw error;
      }
    }
  );

  api.post(
    "/rename",
    describeRoute({
      responses: {
        200: describeSuccess(),
        400: describeError("Bad Request"),
        404: describeError("Not Found"),
      },
    }),
    zValidator(
      "json",
      z.object({
        oldPath: z.string(),
        newPath: z.string(),
        options: z
          .object({
            overwrite: z.boolean(),
          })
          .optional(),
      })
    ),
    async (c) => {
      const body = c.req.valid("json");
      const oldPath = body.oldPath;
      const newPath = body.newPath;

      if (oldPath === newPath) {
        return c.json({ success: true });
      }

      if (readOnly) {
        return c.json({ error: "File is readonly" }, 400);
      }

      try {
        await fs.stat(oldPath);
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return c.json({ error: "Not Found" }, 404);
        }
        throw error;
      }

      const overwrite = body.options?.overwrite ?? false;
      const targetExists = await pathExists(fs, newPath);
      if (targetExists) {
        if (!overwrite) {
          return c.json({ error: "File already exists" }, 400);
        }
        await fs.rm(newPath, { recursive: true, force: true });
      }

      try {
        await ensureParentDirectory(fs, newPath);
        await fs.rename(oldPath, newPath);
        return c.json({ success: true });
      } catch (error) {
        if (isErrnoException(error)) {
          return c.json({ error: error.message }, mapErrnoToStatus(error));
        }
        throw error;
      }
    }
  );

  api.post(
    "/delete",
    describeRoute({
      responses: {
        200: describeSuccess(),
        400: describeError("Bad Request"),
        404: describeError("File not found"),
      },
    }),
    zValidator(
      "json",
      z.object({
        path: z.string(),
        options: z
          .object({
            recursive: z.boolean(),
          })
          .optional(),
      })
    ),
    async (c) => {
      const body = c.req.valid("json");
      const targetPath = body.path;

      if (readOnly) {
        return c.json({ error: "File is readonly" }, 400);
      }

      try {
        const recursive = body.options?.recursive ?? false;
        await fs.rm(targetPath, { recursive, force: false });
        return c.json({ success: true });
      } catch (error) {
        if (isErrnoException(error)) {
          const status = error.code === "ENOENT" ? 404 : mapErrnoToStatus(error);
          return c.json({ error: error.message }, status);
        }
        throw error;
      }
    }
  );

  const app = new Hono({
    getPath: (req) => {
      const url = new URL(req.url);
      if (req.headers.get("accept")?.startsWith("application/json")) {
        return PREFIX + url.pathname + url.search;
      } else {
        return PREFIX + "/UNREACHABLE";
      }
    },
  });

  app.route(PREFIX, api);
  return app;
}

function getTime(time: number | undefined) {
  return typeof time === "number" ? time : 0;
}

function describeError(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: resolver(
          z.object({
            error: z.string(),
          })
        ),
      },
    },
  } as const;
}

function describeSuccess() {
  return {
    description: "Success",
    content: {
      "application/json": {
        schema: resolver(DefaultSuccess),
      },
    },
  } as const;
}

async function pathExists(fs: FsSubset, targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDirectory(fs: FsSubset, targetPath: string) {
  const parent = path.dirname(targetPath);
  if (parent === "." || parent === targetPath) {
    return;
  }
  if (parent === "/") {
    return;
  }
  try {
    await fs.mkdir(parent, { recursive: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

async function performCopy(
  fs: FsSubset,
  sourcePath: string,
  destinationPath: string,
  sourceStat: Stats,
  overwrite: boolean
) {
  const destinationExists = await pathExists(fs, destinationPath);
  if (destinationExists) {
    if (!overwrite) {
      const error = new Error("File already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    await fs.rm(destinationPath, { recursive: true, force: true });
  }

  if (sourceStat.isDirectory()) {
    await copyDirectory(fs, sourcePath, destinationPath);
  } else {
    await ensureParentDirectory(fs, destinationPath);
    await fs.copyFile(sourcePath, destinationPath);
  }
}

async function copyDirectory(fs: FsSubset, source: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  const entries = (await fs.readdir(source, { withFileTypes: true })) as Dirent[];
  for (const entry of entries) {
    const childSource = path.join(source, entry.name);
    const childDestination = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(fs, childSource, childDestination);
    } else {
      await ensureParentDirectory(fs, childDestination);
      await fs.copyFile(childSource, childDestination);
    }
  }
}

function toArrayBuffer(view: Uint8Array): ArrayBufferLike {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer;
  }
  return view.slice().buffer;
}
