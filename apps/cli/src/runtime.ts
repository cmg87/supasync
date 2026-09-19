import { join, resolve } from "node:path";
import { realpath, mkdir, open, unlink, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  PasswordAuth,
  SupaSyncClient,
  VaultKeys,
  type SecretStore,
} from "@supasync/client";
import { EncryptedSyncApi, SyncEngine } from "@supasync/sync-core";
import { atomicJson, readJson, dataHome } from "@supasync/installer";
import { FileStore } from "./file-store.ts";
import { NodeVault } from "./node-vault.ts";
export type RuntimeConfig = {
  url: string;
  anonKey: string;
  installationId?: string;
  vaultId?: string;
};
export class FileSecrets implements SecretStore {
  private file(id: string) {
    if (!/^[a-z0-9-]{1,120}$/.test(id)) throw new Error("Invalid secret ID");
    return join(dataHome(), "secrets", `${id}.json`);
  }
  async get(id: string) {
    return (await readJson<{ value: string }>(this.file(id)))?.value ?? null;
  }
  async set(id: string, value: string) {
    await atomicJson(this.file(id), { value });
  }
  async delete(id: string) {
    await unlink(this.file(id)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
export async function runtime() {
  const config = await readJson<RuntimeConfig>(join(dataHome(), "config.json"));
  if (!config?.url || !config.anonKey)
    throw new Error("Run supasync setup first");
  config.installationId ??= crypto.randomUUID();
  await atomicJson(join(dataHome(), "config.json"), config);
  const secrets = new FileSecrets();
  const auth = new PasswordAuth(config.url, config.anonKey, fetch, secrets);
  const client = new SupaSyncClient({
    url: config.url,
    anonKey: config.anonKey,
    fetch,
    session: auth,
  });
  const keys = new VaultKeys(secrets, config.url, config.installationId);
  return { config, secrets, auth, client, keys };
}
export async function vaultIdentity(
  path: string,
  vaultId: string,
  endpoint: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([await realpath(path), vaultId, new URL(endpoint).origin]),
    )
    .digest("hex");
}
export async function acquireVault(
  path: string,
  vaultId: string,
  endpoint: string,
) {
  const id = await vaultIdentity(path, vaultId, endpoint);
  const directory = join(dataHome(), "locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${id}.lock`);
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await open(file, "wx", 0o600);
      await h.writeFile(JSON.stringify({ pid: process.pid, token }));
      await h.close();
      return async () => {
        const current = await readJson<{ token: string }>(file);
        if (current?.token === token) await unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readJson<{ pid: number }>(file);
      if (!owner || !Number.isSafeInteger(owner.pid))
        throw new Error("Vault lock is invalid; inspect before repairing");
      try {
        process.kill(owner.pid, 0);
        throw new Error("Vault is already owned by another sync process");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          await unlink(file);
          continue;
        }
        throw e;
      }
    }
  }
  throw new Error("Could not acquire vault ownership");
}
export async function openVault(path: string, vaultId: string) {
  const r = await runtime();
  const key = await r.keys.get(vaultId);
  if (!key)
    throw new Error("Vault is locked; enroll with supasync recovery verify");
  const release = await acquireVault(path, vaultId, r.config.url);
  try {
    const id = await vaultIdentity(path, vaultId, r.config.url);
    const store = new FileStore(
      join(dataHome(), "vault-state", id, "state.json"),
    );
    const meta = await store.getMeta();
    meta.vaultId = vaultId;
    await store.putMeta(meta);
    await r.client.registerClient({
      vaultId,
      clientId: meta.clientId,
      label: "headless",
      platform: "node",
    });
    const api = new EncryptedSyncApi(
      r.client,
      store,
      vaultId,
      key,
      fetch,
      r.config.url,
    );
    const vault = new NodeVault(resolve(path));
    const engine = new SyncEngine({ api, vault, store, vaultId });
    return {
      ...r,
      api,
      vault,
      store,
      engine,
      close: async () => {
        engine.pause();
        key.fill(0);
        await release();
      },
    };
  } catch (e) {
    key.fill(0);
    await release();
    throw e;
  }
}
