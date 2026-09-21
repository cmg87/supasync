import { build } from "esbuild";
import { rm } from "node:fs/promises";
await rm(new URL("./dist/", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: ["src/cli.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
