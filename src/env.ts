import process from "node:process";
import type { WedbavOptions } from "./wedbav.ts";

export type Bindings = {
  WEDBAV_USERNAME?: string;
  WEDBAV_PASSWORD?: string;
  PORT?: string;
  WEDBAV_BROWSER?: WedbavOptions["browser"];
  WEDBAV_TABLE?: string;

  LIBSQL_URL?: string;
  AUTH_TOKEN?: string;

  DATABASE_URL_POSTGRES?: string;
};

/**
 * we should only access env variables through this object
 */
export const env = process.env as unknown as Bindings;
