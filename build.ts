import fs from "node:fs/promises";
import { isBuiltin } from "node:module";
import { styleText, parseArgs } from "node:util";

const consoleSuccess = (text: string) => console.log(styleText(["green"], text));
const consoleError = (text: string) => console.error(styleText(["red"], text));
const consoleInfo = (text: string) => console.info(styleText(["blue"], text));

const { values, positionals } = parseArgs({
  options: {
    npm: {
      type: "boolean",
      description: "Prefix npm imports with 'npm:'",
    },
    docker: {
      type: "boolean",
      description: "Build and push a Docker image to ttl.sh",
    },
  },
  allowPositionals: true,
  strict: true,
});

const entrypoints = positionals.length > 0 ? positionals : ["./main.ts"];

const { outputs, success, logs } = await Bun.build({
  entrypoints,
  outdir: "./dist",
  target: "node",
  packages: "external",
  env: "inline",
});

if (!success) {
  consoleError("Build failed!");
  console.error("Logs:", logs);
  process.exit(1);
}

consoleSuccess("Build succeeded!");
console.log("Outputs:", outputs);
if (values.npm) {
  for (const output of outputs) {
    consoleInfo(`Processing output: ${output.path}`);
    const content = await output.text();
    // Replace `import "...";` with `import "npm:...";`
    await fs.writeFile(
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
    consoleInfo(`Processed output: ${output.path}`);
  }
}

import { $ } from "bun";
if (values.docker) {
  const IMAGE_NAME = crypto.randomUUID();
  consoleInfo(`Building Docker image with name: ${IMAGE_NAME}`);
  await $`docker build -t ttl.sh/${IMAGE_NAME} .`;
  await $`docker push ttl.sh/${IMAGE_NAME}`;
}
