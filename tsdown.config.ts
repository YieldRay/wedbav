import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    outDir: "lib",
    dts: true,
  },
  {
    entry: ["main.ts"],
    outDir: "dist",
    platform: "node",
    format: "esm",
  },
]);
