#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  // Read only this project's local status. Never use linked-project credentials.
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
  const url = new URL(status.API_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Refusing to configure a non-local backend.");
  }
  const anonKey = status.ANON_KEY;
  if (!anonKey) throw new Error("Local Supabase did not return a public anon key.");
  const health = await fetch(`${url.origin}/auth/v1/health`, { headers: { apikey: anonKey } });
  if (!health.ok) throw new Error("Local Supabase Auth is not ready.");
  const edge = await fetch(`${url.origin}/functions/v1/supasync-api`, {
    method: "POST", headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "list_vaults", payload: {} }),
  });
  if (edge.status !== 401) throw new Error("Start the local Edge Functions with npm run dev:backend first.");
  const parent = join(root, "test-vaults");
  await mkdir(parent, { recursive: true });
  // Always create a fresh disposable vault; never overwrite a personal vault.
  const vault = await mkdtemp(join(parent, "SupaSync-Local-"));
  const plugin = join(vault, ".obsidian", "plugins", "supasync");
  await mkdir(plugin, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css", "versions.json"]) {
    await copyFile(join(root, "dist", "obsidian", file), join(plugin, file));
  }
  await writeFile(join(plugin, "data.json"), JSON.stringify({
    supabaseUrl: url.origin, anonKey, email: "", vaultId: "", deviceLabel: "Local Obsidian",
    autoSync: true, installationId: randomUUID(),
  }, null, 2));
  await writeFile(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["supasync"]));
  await writeFile(join(vault, "Welcome.md"), "# SupaSync local test\n\nOpen Settings → SupaSync. Create an account or sign in.\n\nThe local backend confirms new accounts immediately. This is a disposable test vault.\n");
  console.log(`Ready: ${vault}\nOpen this folder as a vault in Obsidian, enable community plugins if prompted, then Settings → SupaSync → Create account or Sign in.\nThe local connection is already configured. No credentials or sessions are bundled in the plugin.`);
} catch (error) {
  console.error(error instanceof Error && !('stderr' in error) ? error.message : "Local Supabase is not running. Start npm run dev:backend first.");
  process.exitCode = 1;
}
