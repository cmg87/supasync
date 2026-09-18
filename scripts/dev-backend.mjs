#!/usr/bin/env node
import { spawn } from "node:child_process";

const children = [];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    children.push(child);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      if (signal) reject(new Error(`${command} ${args.join(" ")} exited via ${signal}`));
      else resolve(code ?? 0);
    });
  });
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill("SIGINT");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  const startCode = await run("supabase", ["start"]);
  if (startCode !== 0) process.exit(startCode);
} catch {
  process.exit(1);
}

const serve = spawn("supabase", ["functions", "serve"], { stdio: "inherit" });
children.push(serve);
serve.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
