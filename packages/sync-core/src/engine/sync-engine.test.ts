import { describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../testing/memory-backend.ts";
import { MemoryStore } from "../persist/memory-store.ts";
import { MemoryVault } from "../adapters/memory-vault.ts";
import { SyncEngine } from "./sync-engine.ts";

async function client(
  label: string,
  backend: MemoryBackend,
  vault: MemoryVault,
) {
  const store = new MemoryStore({
    label,
    vaultId: backend.vaultId,
    serverEpoch: backend.serverEpoch,
  });
  const engine = new SyncEngine({
    api: backend,
    vault,
    store,
    vaultId: backend.vaultId,
  });
  return { store, vault, engine };
}

describe("sync engine", () => {
  it("replicates a markdown create from one client to another", async () => {
    const backend = new MemoryBackend();
    const a = await client("alpha", backend, new MemoryVault());
    const b = await client("beta", backend, new MemoryVault());
    await a.vault.writeText("hello.md", "hi\n");
    const push = await a.engine.cycle();
    expect(push.errors).toEqual([]);
    const pull = await b.engine.cycle();
    expect(pull.errors).toEqual([]);
    expect(await b.vault.readText("hello.md")).toBe("hi\n");
  });

  it("preserves both sides of an overlapping edit", async () => {
    const backend = new MemoryBackend();
    const shared = new MemoryVault();
    const seed = await client("seed", backend, shared);
    await shared.writeText("note.md", "base\n");
    await seed.engine.cycle();

    const aVault = new MemoryVault();
    const bVault = new MemoryVault();
    const a = await client("laptop", backend, aVault);
    const b = await client("phone", backend, bVault);
    await a.engine.cycle();
    await b.engine.cycle();
    await aVault.writeText("note.md", "base local\n");
    await bVault.writeText("note.md", "base remote\n");
    await a.engine.cycle();
    await b.engine.cycle();
    await a.engine.cycle();
    const aFiles = (await aVault.list()).map((row) => row.path);
    const bFiles = (await bVault.list()).map((row) => row.path);
    expect(
      aFiles.some((path) => path.includes("conflict") || path === "note.md"),
    ).toBe(true);
    expect(
      bFiles.some((path) => path.includes("conflict") || path === "note.md"),
    ).toBe(true);
    const aTexts = [];
    for (const path of aFiles.filter((item) => item.endsWith(".md")))
      aTexts.push(await aVault.readText(path));
    expect(
      aTexts.some((text) => text.includes("local") || text.includes("remote")),
    ).toBe(true);
  });

  it("retries an identical commit without duplicating revisions", async () => {
    const backend = new MemoryBackend();
    const a = await client("alpha", backend, new MemoryVault());
    await a.vault.writeText("once.md", "1\n");
    await a.engine.cycle();
    const firstHead = (await backend.capabilities()).headSeq;
    await a.engine.cycle();
    expect((await backend.capabilities()).headSeq).toBe(firstHead);
  });
});

it("persists the complete binary payload before attempting a network commit", async () => {
  const backend = new MemoryBackend(),
    vault = new MemoryVault(),
    store = new MemoryStore({ vaultId: backend.vaultId });
  await vault.writeBytes("attachment.bin", new Uint8Array([0, 255, 3]));
  vi.spyOn(backend, "commit").mockImplementation(async (envelope) => {
    const pending = await store.listOutbox();
    expect(
      pending.find((x) => x.operationId === envelope.operationId)?.envelope,
    ).toEqual(envelope);
    throw new Error("offline");
  });
  const engine = new SyncEngine({
    api: backend,
    vault,
    store,
    vaultId: backend.vaultId,
  });
  expect((await engine.cycle()).errors).toContain("offline");
  expect(await store.listOutbox()).toHaveLength(1);
  expect(await vault.readBytes("attachment.bin")).toEqual(
    new Uint8Array([0, 255, 3]),
  );
});

it.each(["offline", "corrupt"])(
  "never writes a failed binary download: %s",
  async (mode) => {
    const backend = new MemoryBackend(),
      source = await client("source", backend, new MemoryVault());
    await source.vault.writeBytes(
      "attachment.bin",
      new Uint8Array([0, 255, 3]),
    );
    await source.engine.cycle();
    vi.spyOn(backend, "readBlob").mockImplementation(async () => {
      if (mode === "offline") throw new Error("offline");
      return new Uint8Array([9, 9, 9]);
    });
    const target = await client("target", backend, new MemoryVault());
    await expect(target.engine.cycle()).rejects.toThrow(
      mode === "offline" ? "offline" : "HASH_MISMATCH",
    );
    expect(await target.vault.exists("attachment.bin")).toBe(false);
    expect((await target.store.getMeta()).appliedCursor).toBe("0");
  },
);

it("does not infer deletion from an incomplete non-empty scan", async () => {
  const backend = new MemoryBackend(),
    a = await client("a", backend, new MemoryVault());
  await a.vault.writeText("a.md", "a");
  await a.vault.writeText("b.md", "b");
  await a.engine.cycle();
  await a.vault.remove("a.md");
  await a.engine.cycle();
  const b = await client("b", backend, new MemoryVault());
  await b.engine.cycle();
  expect(await b.vault.readText("a.md")).toBe("a");
});

it("keeps a local edit made while its earlier mutation is in flight", async () => {
  const backend = new MemoryBackend(),
    a = await client("a", backend, new MemoryVault());
  await a.vault.writeText("a.md", "base");
  await a.engine.cycle();
  await a.vault.writeText("a.md", "first");
  const commit = backend.commit.bind(backend);
  let once = true;
  vi.spyOn(backend, "commit").mockImplementation(async (request) => {
    const result = await commit(request);
    if (once) {
      once = false;
      await a.vault.writeText("a.md", "second");
    }
    return result;
  });
  await a.engine.cycle();
  await a.engine.cycle();
  const b = await client("b", backend, new MemoryVault());
  await b.engine.cycle();
  const texts = await Promise.all(
    (await b.vault.list())
      .filter((f) => f.kind === "file")
      .map((f) => b.vault.readText(f.path)),
  );
  expect(texts).toContain("second");
});

it("uses per-file revisions even when other files advance the journal", async () => {
  const backend = new MemoryBackend(),
    a = await client("a", backend, new MemoryVault());
  await a.vault.writeText("a.md", "a");
  await a.vault.writeText("b.md", "b");
  await a.engine.cycle();
  await a.vault.writeText("b.md", "changed");
  expect((await a.engine.cycle()).errors).toEqual([]);
  const b = await client("b", backend, new MemoryVault());
  await b.engine.cycle();
  expect(await b.vault.readText("b.md")).toBe("changed");
});

it("preserves text edited while a remote body is downloading", async () => {
  const backend = new MemoryBackend(),
    a = await client("a", backend, new MemoryVault()),
    b = await client("b", backend, new MemoryVault());
  await a.vault.writeText("a.md", "base");
  await a.engine.cycle();
  await b.engine.cycle();
  await a.vault.writeText("a.md", "remote");
  await a.engine.cycle();
  const get = backend.getBodies.bind(backend);
  let once = true;
  vi.spyOn(backend, "getBodies").mockImplementation(async (...args) => {
    const result = await get(...args);
    if (once) {
      once = false;
      await b.vault.writeText("a.md", "late local");
    }
    return result;
  });
  await b.engine.cycle();
  const texts = await Promise.all(
    (await b.vault.list())
      .filter((r) => r.kind === "file")
      .map((r) => b.vault.readText(r.path)),
  );
  expect(texts).toContain("late local");
  expect(texts).toContain("remote");
});
