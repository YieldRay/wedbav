import process from "node:process";
import type { WedbavOptions } from "./wedbav.ts";

export type Bindings = {
  WEDBAV_USERNAME?: string;
  WEDBAV_PASSWORD?: string;
  PORT?: string;
  WEDBAV_BROWSER?: WedbavOptions["browser"];
  WEDBAV_LIST?: WedbavOptions["list"];
  WEDBAV_TABLE?: string;

  WEDBAV_CONNECTION_STRING?: string;

  WEDBAV_JWT_SECRET?: string;
  WEDBAV_JWT_MAX_AGE?: string;
};

/**
 * we should only access env variables through this object
 */
export const env = process.env as unknown as Bindings;
