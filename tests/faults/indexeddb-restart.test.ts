import "fake-indexeddb/auto";
import { it, expect, vi } from "vitest";
import { IndexedDbStore } from "../../apps/obsidian/src/adapters/indexeddb-store.ts";
import { MemoryBackend, MemoryVault, SyncEngine } from "@supasync/sync-core";
import { createEnvelope } from "@supasync/protocol";

it("recovers a filesystem rename completed before the manifest was saved", async () => {
  const backend = new MemoryBackend(),
    vault = new MemoryVault(),
    name = crypto.randomUUID(),
    store = new IndexedDbStore(name);
  const engine = new SyncEngine({
    api: backend,
    vault,
    store,
    vaultId: backend.vaultId,
  });
  await vault.writeText("old.md", "kept");
  await engine.cycle();
  const row = [...(await store.getManifest()).values()][0]!;
  const request = createEnvelope({
    serverEpoch: backend.serverEpoch,
    vaultId: backend.vaultId,
    clientId: "other",
    operationId: crypto.randomUUID(),
    entryId: row.entryId,
    baseRevisionId: row.baseSeq,
    type: "rename",
    payload: { path: "new.md" },
  });
  const result = await backend.commit(request);
  await store.putIntent({
    fromPath: "old.md",
    path: "new.md",
    beforeHash: row.baseHash,
    afterHash: row.baseHash,
    seq: result.revision!.seq,
    entryId: row.entryId,
  });
  await vault.rename("old.md", "new.md");
  const reopened = new IndexedDbStore(name);
  await new SyncEngine({
    api: backend,
    vault,
    store: reopened,
    vaultId: backend.vaultId,
  }).cycle();
  expect(await vault.readText("new.md")).toBe("kept");
  expect(await reopened.listOutbox()).toHaveLength(0);
  expect((await reopened.getManifest()).size).toBe(1);
});

it("reopens a durable outbox after the server commits and the process loses its response", async () => {
  const name = crypto.randomUUID(),
    backend = new MemoryBackend(),
    vault = new MemoryVault();
  const store = new IndexedDbStore(name);
  await vault.writeText("a.md", "durable");
  const commit = backend.commit.bind(backend);
  let lose = true;
  vi.spyOn(backend, "commit").mockImplementation(async (request) => {
    const result = await commit(request);
    if (lose) {
      lose = false;
      throw new Error("process lost");
    }
    return result;
  });
  const engine = new SyncEngine({
    api: backend,
    store,
    vault,
    vaultId: backend.vaultId,
  });
  expect((await engine.cycle()).errors).toContain("process lost");
  const reopened = new IndexedDbStore(name);
  expect(await reopened.listOutbox()).toHaveLength(1);
  const resumed = new SyncEngine({
    api: backend,
    store: reopened,
    vault,
    vaultId: backend.vaultId,
  });
  await resumed.cycle();
  expect(await reopened.listOutbox()).toHaveLength(0);
  expect((await backend.capabilities()).headSeq).toBe("1");
});

it("does not acknowledge a fetched journal page when applying it fails", async () => {
  const backend = new MemoryBackend(),
    source = new MemoryVault(),
    sourceStore = new IndexedDbStore(crypto.randomUUID());
  const writer = new SyncEngine({
    api: backend,
    vault: source,
    store: sourceStore,
    vaultId: backend.vaultId,
  });
  await source.writeText("a.md", "one");
  await writer.cycle();
  const name = crypto.randomUUID(),
    store = new IndexedDbStore(name),
    target = new MemoryVault();
  const reader = new SyncEngine({
    api: backend,
    store,
    vault: target,
    vaultId: backend.vaultId,
  });
  await reader.cycle();
  await source.writeText("a.md", "two");
  await writer.cycle();
  const original = target.writeText.bind(target);
  let fail = true;
  vi.spyOn(target, "writeText").mockImplementation(async (path, text) => {
    if (fail) {
      fail = false;
      throw new Error("disk full");
    }
    await original(path, text);
  });
  await expect(reader.cycle()).rejects.toThrow("disk full");
  const reopened = new IndexedDbStore(name),
    meta = await reopened.getMeta();
  expect(BigInt(meta.receivedCursor)).toBeGreaterThan(
    BigInt(meta.appliedCursor),
  );
  expect(await reopened.listIntents()).toHaveLength(1);
  await new SyncEngine({
    api: backend,
    store: reopened,
    vault: target,
    vaultId: backend.vaultId,
  }).cycle();
  expect(await target.readText("a.md")).toBe("two");
  expect((await reopened.getMeta()).appliedCursor).toBe(
    (await reopened.getMeta()).receivedCursor,
  );
});
