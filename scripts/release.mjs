#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const dest = join(root, "dist", "obsidian");
mkdirSync(dest, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css", "versions.json"]) {
  cpSync(join(root, "apps/obsidian", file === "main.js" ? "main.js" : file), join(dest, file));
}
console.log("Release assets:", dest);
