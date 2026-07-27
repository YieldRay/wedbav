import { dialectFromConnectionString } from "./src/connection-string.ts";
import { env } from "./src/env.ts";
import startServer from "./src/server.ts";

const { dialect, dbType } = dialectFromConnectionString(env.WEDBAV_CONNECTION_STRING || ":memory:");

startServer(dialect, dbType);
