import { env } from "./src/env.ts";
import startServer from "./src/server.ts";
import { dialectFromConnectionString } from "./src/connection-string.ts";

const { dialect, dbType } = dialectFromConnectionString(env.WEDBAV_CONNECTION_STRING || ":memory:");

startServer(dialect, dbType);
