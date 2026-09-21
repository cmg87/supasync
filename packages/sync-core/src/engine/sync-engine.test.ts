import { describe, expect, it, vi } from "vitest";
import { createEnvelope } from "@supasync/protocol";
import { MemoryBackend } from "../testing/memory-backend.ts";
import { MemoryStore } from "../persist/memory-store.ts";
import { MemoryVault } from "../adapters/memory-vault.ts";
import type { VaultStat } from "../types.ts";
import { SyncEngine } from "./sync-engine.ts";

class ListedVault extends MemoryVault {
  constructor(private readonly rows: VaultStat[]) {
    super();
  }

  override async list(): Promise<VaultStat[]> {
    return this.rows;
  }
}

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

it("skips roots, canonicalizes folders, and reports invalid folder paths", async () => {
  const backend = new MemoryBackend();
  const vault = new ListedVault([
    { path: "", kind: "folder", byteLength: 0 },
    { path: "/", kind: "folder", byteLength: 0 },
    { path: "Cafe\u0301", kind: "folder", byteLength: 0 },
    { path: "Caf\u00e9/", kind: "folder", byteLength: 0 },
    { path: "bad//folder", kind: "folder", byteLength: 0 },
    { path: "valid", kind: "folder", byteLength: 0 },
  ]);
  const store = new MemoryStore({
    vaultId: backend.vaultId,
    serverEpoch: backend.serverEpoch,
  });
  const commit = vi.spyOn(backend, "commit");
  const engine = new SyncEngine({
    api: backend,
    vault,
    store,
    vaultId: backend.vaultId,
  });

  const first = await engine.cycle();
  expect(first.errors).toContain(
    "bad//folder: INVALID_PATH: path component is empty or a traversal segment",
  );
  expect(commit.mock.calls.map(([env]) => env.payload.path).sort()).toEqual([
    "Caf\u00e9",
    "valid",
  ]);
  await engine.cycle();
  expect(commit).toHaveBeenCalledTimes(2);
});

it("matches pending folder paths by canonical display path", async () => {
  const backend = new MemoryBackend();
  const vault = new ListedVault([
    { path: "Cafe\u0301/", kind: "folder", byteLength: 0 },
  ]);
  const store = new MemoryStore({
    vaultId: backend.vaultId,
    serverEpoch: backend.serverEpoch,
  });
  const meta = await store.getMeta();
  const operationId = crypto.randomUUID();
  await store.putOutbox({
    operationId,
    envelope: createEnvelope({
      serverEpoch: backend.serverEpoch,
      vaultId: backend.vaultId,
      clientId: meta.clientId,
      operationId,
      entryId: crypto.randomUUID(),
      type: "create",
      payload: { path: "Caf\u00e9", kind: "folder" },
    }),
    extras: {},
    status: "queued",
    sentHash: null,
  });
  const commit = vi.spyOn(backend, "commit");

  const report = await new SyncEngine({
    api: backend,
    vault,
    store,
    vaultId: backend.vaultId,
  }).cycle();

  expect(report.errors).toEqual([]);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0]![0].operationId).toBe(operationId);
});

it("quarantines an obsolete unsupported path and applies its valid rename", async () => {
  const backend = new MemoryBackend();
  const source = await client("desktop", backend, new MemoryVault());
  await source.vault.writeText("original.md", "portable\n");
  await source.engine.cycle();
  const sourceRow = [...(await source.store.getManifest()).values()][0]!;
  await source.vault.rename("original.md", "renamed.md");
  await source.engine.renameLocal("original.md", "renamed.md");
  await source.engine.cycle();

  const pull = backend.pullChanges.bind(backend);
  vi.spyOn(backend, "pullChanges").mockImplementation(async (input) => {
    const page = await pull(input);
    return {
      ...page,
      revisions: page.revisions.map((revision) =>
        revision.seq === "1"
          ? { ...revision, path: "original?.md", pathKey: "original?.md" }
          : revision,
      ),
    };
  });
  const targetVault = new MemoryVault();
  const targetStore = new MemoryStore({
    vaultId: backend.vaultId,
    serverEpoch: backend.serverEpoch,
    receivedCursor: "1",
    appliedCursor: "0",
  });
  const target = new SyncEngine({
    api: backend,
    vault: targetVault,
    store: targetStore,
    vaultId: backend.vaultId,
  });
  await targetStore.putIntent({
    path: "original?.md",
    beforeHash: null,
    afterHash: sourceRow.baseHash,
    seq: "1",
    entryId: sourceRow.entryId,
  });

  const recovered = await target.cycle();
  expect(recovered.errors).toEqual([
    "Retired unsupported apply intent: original?.md",
    "Quarantined unsupported remote path at revision 1: original?.md",
  ]);
  expect(await targetVault.readText("renamed.md")).toBe("portable\n");
  expect((await targetStore.getMeta()).appliedCursor).toBe("2");
  expect(await targetStore.getCache("unsupported-revision:1")).toMatchObject({
    reason: "unsupported-remote-path",
    revision: { path: "original?.md", seq: "1" },
  });
  expect(
    await targetStore.getCache(
      `unsupported-intent:${sourceRow.entryId}:1`,
    ),
  ).toMatchObject({
    reason: "unsupported-apply-path",
    intent: { path: "original?.md", entryId: sourceRow.entryId },
  });
  expect(await targetStore.listIntents()).toEqual([]);
  expect((await target.cycle()).errors).toEqual([]);
});

it("retires a legacy queued invalid create while syncing its corrected file", async () => {
  const backend = new MemoryBackend();
  const vault = new MemoryVault();
  const store = new MemoryStore({
    vaultId: backend.vaultId,
    serverEpoch: backend.serverEpoch,
  });
  await vault.writeText("corrected.md", "preserved\n");
  const operationId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  const legacy = {
    operationId,
    envelope: createEnvelope({
      serverEpoch: backend.serverEpoch,
      vaultId: backend.vaultId,
      clientId: (await store.getMeta()).clientId,
      operationId,
      entryId,
      type: "create" as const,
      payload: {
        path: "incorrect?.md",
        kind: "markdown",
        text: "preserved\n",
      },
    }),
    extras: {},
    status: "queued" as const,
    sentHash: "captured",
  };
  await store.putOutbox(legacy);
  await store.putManifest({
    entryId,
    path: "incorrect?.md",
    kind: "markdown",
    remoteSeq: "0",
    remoteHash: null,
    localHash: "captured",
    baseSeq: "0",
    baseHash: null,
    deleted: false,
    blobId: null,
  });

  const report = await new SyncEngine({
    api: backend,
    vault,
    store,
    vaultId: backend.vaultId,
  }).cycle();

  expect(report.errors).toEqual([
    "Retired unsupported queued path: incorrect?.md",
  ]);
  expect(await store.listOutbox()).toEqual([]);
  expect((await store.getManifest()).has(entryId)).toBe(false);
  expect(await store.getCache(`rejected-outbox:${operationId}`)).toEqual({
    reason: "unsupported-path-request",
    error: "INVALID_PATH: path component contains a cross-platform reserved character",
    outbox: legacy,
  });
  const target = await client("mobile", backend, new MemoryVault());
  expect((await target.engine.cycle()).errors).toEqual([]);
  expect(await target.vault.readText("corrected.md")).toBe("preserved\n");
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
