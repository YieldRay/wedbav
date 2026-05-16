import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import { PostgresDialect, type Dialect } from "kysely";
import { Pool } from "pg";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import type { DB_Type } from "./fs.ts";

const SUPPORTED_SCHEMES = new Set(["postgresql", "postgres", "pg", "file", "libsql", "memory"] as const);
type SUPPORTED_SCHEME = typeof SUPPORTED_SCHEMES extends Set<infer U> ? U : never;

export function dialectFromConnectionString(connectionString: string): {
  dialect: Dialect;
  dbType: DB_Type;
} {
  if (
    connectionString === "" ||
    connectionString === "memory" ||
    connectionString.startsWith(":memory:") ||
    connectionString.startsWith("memory:")
  ) {
    console.warn(
      "In-memory SQLite is used. Data will not persist across restarts. To use a file-based SQLite database, set the connection string to something like `file:/path/to/mydb.sqlite`.",
    );
    return {
      dialect: new LibsqlDialect({ url: "file::memory:" }),
      dbType: "sqlite",
    };
  }

  const url = new URL(connectionString);
  const scheme = url.protocol.replace(":", "") as SUPPORTED_SCHEME;

  switch (scheme) {
    case "pg": {
      url.protocol = "postgres:";
      const pool = new Pool({ connectionString });
      return {
        dialect: new PostgresDialect({ pool }),
        dbType: "pg",
      };
    }
    case "postgresql": {
      url.protocol = "postgres:";
      return {
        dialect: new PostgresJSDialect({ postgres: postgres(connectionString) }),
        dbType: "pg",
      };
    }
    case "postgres": {
      return {
        dialect: new PostgresJSDialect({ postgres: postgres(connectionString) }),
        dbType: "pg",
      };
    }
    case "file": {
      return {
        dialect: new LibsqlDialect({ url: connectionString }),
        dbType: "sqlite",
      };
    }
    case "libsql": {
      const authToken = url.password || undefined;
      const libsqlUrl = new URL(url);
      libsqlUrl.username = "";
      libsqlUrl.password = "";
      const libsqlHref = libsqlUrl.href;

      return {
        dialect: new LibsqlDialect(authToken ? { url: libsqlHref, authToken } : { url: libsqlHref }),
        dbType: "sqlite",
      };
    }
    default: {
      throw new Error(
        `Unsupported connection string scheme: ${scheme}. Supported schemes are: ${[...SUPPORTED_SCHEMES].join(", ")}`,
      );
    }
  }
}

export function dialectFromConnectionStringForVercel(connectionString: string):
  | {
      dialect: Dialect;
      dbType: "pg";
      pool: Pool;
    }
  | {
      dialect: Dialect;
      dbType: "sqlite";
      pool?: undefined;
    } {
  if (
    connectionString === "memory" ||
    connectionString.startsWith(":memory:") ||
    connectionString.startsWith("memory:")
  ) {
    return {
      dialect: new LibsqlDialect({ url: "file::memory:" }),
      dbType: "sqlite",
    };
  }

  const url = new URL(connectionString);
  const scheme = url.protocol.replace(":", "") as SUPPORTED_SCHEME;

  switch (scheme) {
    case "pg":
    case "postgres":
    case "postgresql":
      url.protocol = "postgres:";
      const pool = new Pool({ connectionString });
      return {
        dialect: new PostgresDialect({ pool }),
        dbType: "pg",
        pool,
      };

    case "libsql":
      const authToken = url.password || undefined;
      const libsqlUrl = new URL(url);
      libsqlUrl.username = "";
      libsqlUrl.password = "";
      const libsqlHref = libsqlUrl.href;
      return {
        dialect: new LibsqlDialect(authToken ? { url: libsqlHref, authToken } : { url: libsqlHref }),
        dbType: "sqlite",
      };

    default:
      throw new Error(
        `For vercel, unsupported connection string scheme: ${scheme}. Supported schemes are: postgresql, postgres, pg, libsql`,
      );
  }
}
