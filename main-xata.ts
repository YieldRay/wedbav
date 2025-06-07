import { buildClient } from "@xata.io/client";
import { XataDialect } from "@xata.io/kysely";
import { main } from "./main.ts";

const XataClient = buildClient();
type XataClient = InstanceType<typeof XataClient>;

let instance: XataClient | undefined = undefined;

export const getXataClient = () => {
  if (instance) return instance;

  instance = new XataClient({
    databaseURL: process.env["DATABASE_URL"],
  });
  return instance;
};

export const xataDialect = new XataDialect({
  xata: getXataClient(),
});

main(xataDialect as any, "pg");
