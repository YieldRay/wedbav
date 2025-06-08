import fs from "node:fs/promises";
import { isBuiltin } from "node:module";
import { argv } from "node:process";

const entrypoints = argv.slice(2);
if (entrypoints.length === 0) entrypoints.push("./main.ts");

const { outputs, success, logs } = await Bun.build({
  entrypoints,
  outdir: "./dist",
  target: "node",
  packages: "external",
  env: "inline",
});

if (success) {
  console.log("Build succeeded!");
  console.log("Outputs:", outputs);
  outputs.forEach(async (output) => {
    const content = await output.text();
    // Replace `import "...";` with `import "npm:...";`
    fs.writeFile(
      output.path,
      content.replace(/^(import\s+[^"']+)(["'][^"']*["'])/gm, (match, p1, p2) => {
        const name = p2.slice(1, -1);
        if (isBuiltin(name)) {
          if (name.startsWith("node:")) {
            return match;
          } else {
            // Add "node:" prefix for built-in modules
            return `${p1}node:${name}`;
          }
        }
        // For non-built-in modules, prefix with "npm:"
        return `${p1}"npm:${name}"`;
      })
    );
  });
} else {
  console.error("Build failed!");
  console.error("Logs:", logs);
  process.exit(1);
}
