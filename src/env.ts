import process from "node:process";
import type { WedbavOptions } from "./wedbav.ts";

export type Bindings = {
  WEDBAV_USERNAME?: string;
  WEDBAV_PASSWORD?: string;
  PORT?: string;
  WEDBAV_BROWSER?: WedbavOptions["browser"];
  WEDBAV_TABLE?: string;
};

export const env = process.env as unknown as Bindings;
