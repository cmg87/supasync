import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { PasswordAuth, SupaSyncClient, VaultKeys } from "@supasync/client";
import {
  EncryptedSyncApi,
  MemoryStore,
  MemoryVault,
  SyncEngine,
} from "@supasync/sync-core";
import { hashBytes } from "@supasync/protocol";
const url = "http://127.0.0.1:54321";
const anon =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
it("keeps names/content off the server and preserves exact ciphertext across a lost commit response", async () => {
  const values = new Map<string, string>();
  const secrets = {
    get: async (id: string) => values.get(id) ?? null,
    set: async (id: string, value: string) => {
      values.set(id, value);
    },
  };
  const auth = new PasswordAuth(url, anon, fetch, secrets);
  await auth.signUp(
    `supasync-fixture-v2-${crypto.randomUUID()}@example.test`,
    "test-password-v2",
  );
  let loseResponse = false;
  const requests: string[] = [];
  const uploads: Uint8Array[] = [];
  const transport: typeof fetch = async (input, init) => {
    if (typeof init?.body === "string") requests.push(init.body);
    if (init?.method === "PUT" && init.body instanceof Uint8Array)
      uploads.push(init.body);
    const response = await fetch(input, init);
    if (
      loseResponse &&
      typeof init?.body === "string" &&
      JSON.parse(init.body).operation === "commit"
    ) {
      loseResponse = false;
      throw new Error("lost response");
    }
    return response;
  };
  const client = new SupaSyncClient({
    url,
    anonKey: anon,
    fetch: transport,
    session: auth,
  });
  const keys = new VaultKeys(secrets, url, "test");
  const vaultId = crypto.randomUUID();
  const marker = `private-${crypto.randomUUID()}`;
  const prepared = await keys.prepare(vaultId, marker);
  const recovery = (await keys.pendingRecovery(vaultId))!;
  await client.rpc("create_vault", prepared);
  await keys.recover(vaultId, prepared.recoveryEnvelope, recovery);
  const key = (await keys.get(vaultId))!;
  async function device() {
    const store = new MemoryStore({ vaultId });
    const meta = await store.getMeta();
    await client.registerClient({
      vaultId,
      clientId: meta.clientId,
      label: "test",
      platform: "test",
    });
    const vault = new MemoryVault();
    const api = new EncryptedSyncApi(
      client,
      store,
      vaultId,
      key,
      transport,
      url,
    );
    return {
      store,
      vault,
      api,
      engine: new SyncEngine({ api, vault, store, vaultId }),
    };
  }
  const a = await device();
  const b = await device();
  await a.vault.writeText(`${marker}/note.md`, `${marker} secret body\n`);
  await a.vault.writeBytes(
    `${marker}/image.bin`,
    new TextEncoder().encode(`${marker} private binary`),
  );
  expect((await a.engine.cycle()).errors).toEqual([]);
  expect((await b.engine.cycle()).errors).toEqual([]);
  expect(await b.vault.readText(`${marker}/note.md`)).toContain(marker);
  expect(await b.vault.readBytes(`${marker}/image.bin`)).toEqual(
    await a.vault.readBytes(`${marker}/image.bin`),
  );
  await a.vault.writeText(`${marker}/note.md`, "updated secret\n");
  loseResponse = true;
  expect((await a.engine.cycle()).errors).toContain("lost response");
  const pending = await a.store.listOutbox();
  expect(pending).toHaveLength(1);
  expect(pending[0]?.wire).toBeTruthy();
  const sealed = JSON.stringify(pending[0]?.wire);
  expect(sealed).not.toContain("updated secret");
  expect((await a.engine.cycle()).errors).toEqual([]);
  expect(await a.store.listOutbox()).toHaveLength(0);
  const retryRequests = requests.filter((raw) =>
    raw.includes(pending[0]!.operationId),
  );
  expect(new Set(retryRequests).size).toBe(1);
  await b.engine.cycle();
  expect(await b.vault.readText(`${marker}/note.md`)).toBe("updated secret\n");
  const before = [...(await a.store.getManifest()).values()].find(
    (r) => r.path === `${marker}/note.md`,
  )!.entryId;
  await a.vault.writeBytes(
    `${marker}/image.bin`,
    new Uint8Array([0, 255, 42, 1]),
  );
  expect((await a.engine.cycle()).errors).toEqual([]);
  expect((await b.engine.cycle()).errors).toEqual([]);
  expect(await b.vault.readBytes(`${marker}/image.bin`)).toEqual(
    new Uint8Array([0, 255, 42, 1]),
  );
  const moved = `${marker}-moved`;
  await a.vault.rename(marker, moved);
  await a.engine.renameLocal(marker, moved);
  expect((await a.engine.cycle()).errors).toEqual([]);
  expect((await b.engine.cycle()).errors).toEqual([]);
  expect(await b.vault.readText(`${moved}/note.md`)).toBe("updated secret\n");
  expect(
    [...(await b.store.getManifest()).values()].find(
      (r) => r.path === `${moved}/note.md`,
    )?.entryId,
  ).toBe(before);
  await a.vault.writeText(`${moved}/note.md`, "competing version A\n");
  await b.vault.writeText(`${moved}/note.md`, "competing version B\n");
  await a.engine.cycle();
  await b.engine.cycle();
  await a.engine.cycle();
  await b.engine.cycle();
  const files = (await b.vault.list()).filter(
    (f) => f.kind === "file" && f.path.endsWith(".md"),
  );
  const contents = await Promise.all(
    files.map((f) => b.vault.readText(f.path)),
  );
  expect(contents).toContain("competing version A\n");
  expect(contents).toContain("competing version B\n");
  const dump = execFileSync(
    "docker",
    [
      "exec",
      "supabase_db_supasync",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-At",
      "-c",
      `select row_to_json(t)::text from supasync_v2.vaults t where id='${vaultId}' union all select row_to_json(t)::text from supasync_v2.revisions t where vault_id='${vaultId}' union all select row_to_json(t)::text from supasync_v2.objects t where vault_id='${vaultId}' union all select row_to_json(t)::text from supasync_v2.receipts t where vault_id='${vaultId}'`,
    ],
    { encoding: "utf8" },
  );
  const plaintextHash = await hashBytes(
    new TextEncoder().encode(`${marker} secret body\n`),
  );
  for (const secret of [marker, "updated secret", plaintextHash, recovery]) {
    expect(dump).not.toContain(secret);
    expect(requests.join("")).not.toContain(secret);
    for (const upload of uploads)
      expect(new TextDecoder().decode(upload)).not.toContain(secret);
  }
  const logs = execFileSync(
    "docker",
    ["logs", "--since", "10m", "supabase_edge_runtime_supasync"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  expect(logs).not.toContain(marker);
  await auth.signOut();
}, 60000);
