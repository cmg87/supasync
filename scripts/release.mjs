#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
console.log("Release assets:", join(root, "dist", "obsidian"));
