import { describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../testing/memory-backend.ts";
import { MemoryStore } from "../persist/memory-store.ts";
import { MemoryVault } from "../adapters/memory-vault.ts";
import { SyncEngine } from "./sync-engine.ts";

async function client(label: string, backend: MemoryBackend, vault: MemoryVault) {
  const store = new MemoryStore({ label, vaultId: backend.vaultId, serverEpoch: backend.serverEpoch });
  const engine = new SyncEngine({ api: backend, vault, store, vaultId: backend.vaultId });
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
    expect(aFiles.some((path) => path.includes("conflict") || path === "note.md")).toBe(true);
    expect(bFiles.some((path) => path.includes("conflict") || path === "note.md")).toBe(true);
    const aTexts = [];
    for (const path of aFiles.filter((item) => item.endsWith(".md"))) aTexts.push(await aVault.readText(path));
    expect(aTexts.some((text) => text.includes("local") || text.includes("remote"))).toBe(true);
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

it("does not finalize or commit a blob when its upload fails", async () => {
  const backend = new MemoryBackend();
  const vault = new MemoryVault();
  const store = new MemoryStore({ vaultId: backend.vaultId, serverEpoch: backend.serverEpoch });
  await vault.writeBytes("attachment.bin", new Uint8Array([1, 2, 3]));
  vi.spyOn(backend, "beginBlobUpload").mockResolvedValue({
    blobId: crypto.randomUUID(), stagingKey: "staging", transfer: { url: "https://storage.example.test/upload", method: "PUT", headers: {} },
  });
  const finalize = vi.spyOn(backend, "finalizeBlob");
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 }));
  const engine = new SyncEngine({ api: backend, vault, store, vaultId: backend.vaultId, fetch: transport });
  await expect(engine.cycle()).rejects.toThrow("Attachment upload failed (HTTP 503)");
  expect(transport).toHaveBeenCalledOnce();
  expect(finalize).not.toHaveBeenCalled();
  expect(await vault.readBytes("attachment.bin")).toEqual(new Uint8Array([1, 2, 3]));
});

it.each([503, 200])("does not write a failed or corrupt attachment download (HTTP %s)", async (status) => {
  const backend = new MemoryBackend();
  const source = await client("source", backend, new MemoryVault());
  await source.vault.writeBytes("attachment.bin", new Uint8Array([1, 2, 3]));
  await source.engine.cycle();
  vi.spyOn(backend, "getBlobDownload").mockResolvedValue({
    transfer: { url: "https://storage.example.test/download", method: "GET", headers: {} },
    verifiedSha256: "expected-hash", verifiedLength: 3,
  });
  const target = new MemoryVault();
  const engine = new SyncEngine({
    api: backend, vault: target, store: new MemoryStore({ vaultId: backend.vaultId }), vaultId: backend.vaultId,
    fetch: async () => new Response(new Uint8Array([9, 9, 9]), { status }),
  });
  await expect(engine.cycle()).rejects.toThrow(status === 503 ? "Attachment download failed" : "integrity verification");
  expect(await target.exists("attachment.bin")).toBe(false);
});
