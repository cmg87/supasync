import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PasswordAuth, SupaSyncClient, type SecretStore } from "@supasync/client";
import { SyncEngine } from "@supasync/sync-core";
import { FileStore } from "./file-store.ts";
import { NodeVault } from "./node-vault.ts";

type Config = {
  url?: string;
  anonKey?: string;
  vaultId?: string;
};

const configPath = join(homedir(), ".config", "supasync", "config.json");
const secretPath = join(homedir(), ".config", "supasync", "session.json");

class FileSecrets implements SecretStore {
  async get(): Promise<string | null> {
    try {
      return await readFile(secretPath, "utf8");
    } catch {
      return null;
    }
  }
  async set(_id: string, value: string): Promise<void> {
    await mkdir(join(homedir(), ".config", "supasync"), { recursive: true });
    await writeFile(secretPath, value);
  }
}

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as Config;
  } catch {
    return {};
  }
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(join(homedir(), ".config", "supasync"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1];
  return fallback;
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const config = await loadConfig();
  if (cmd === "config") {
    config.url = arg("url", config.url);
    config.anonKey = arg("anon-key", config.anonKey);
    config.vaultId = arg("vault", config.vaultId);
    await saveConfig(config);
    console.log("saved", configPath);
    return;
  }
  if (!config.url || !config.anonKey) {
    throw new Error("run: supasync config --url <url> --anon-key <key>");
  }
  const auth = new PasswordAuth(config.url, config.anonKey, fetch, new FileSecrets());
  if (cmd === "login") {
    const email = arg("email");
    const password = arg("password");
    if (!email || !password) throw new Error("login requires --email and --password");
    await auth.signIn(email, password);
    console.log("signed in");
    return;
  }
  const client = new SupaSyncClient({ url: config.url, fetch, session: auth });
  if (cmd === "vaults") {
    console.log(JSON.stringify(await client.listVaults(), null, 2));
    return;
  }
  if (cmd === "create-vault") {
    const name = arg("name", "Vault");
    console.log(JSON.stringify(await client.createVault(name ?? "Vault"), null, 2));
    return;
  }
  const vaultId = arg("vault", config.vaultId);
  if (!vaultId) throw new Error("vault id required");
  if (cmd === "sync" || cmd === "pull" || cmd === "push") {
    const dir = resolve(arg("dir", process.cwd()) ?? process.cwd());
    const store = new FileStore(join(dir, ".supasync", "state.json"));
    const meta = await store.getMeta();
    meta.vaultId = vaultId;
    await store.putMeta(meta);
    await client.registerClient({
      vaultId,
      clientId: meta.clientId,
      label: "hermes",
      platform: "cli",
    });
    const engine = new SyncEngine({
      api: client,
      vault: new NodeVault(dir),
      store,
      vaultId,
    });
    const report = await engine.cycle();
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (cmd === "get") {
    const path = arg("path");
    if (!path) throw new Error("--path required");
    const vaults = await client.listVaults();
    console.log(JSON.stringify({ vaults, path }, null, 2));
    return;
  }
  console.log(`supasync ${cmd ?? ""}
commands:
  config --url --anon-key [--vault]
  login --email --password
  vaults
  create-vault --name
  sync --dir --vault
  pull|push (aliases of sync)
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
