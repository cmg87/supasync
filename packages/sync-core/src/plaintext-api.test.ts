import { it, expect, vi } from "vitest";
import { SupaSyncClient } from "@supasync/client";
import { createEnvelope, encode, hashBytes } from "@supasync/protocol";
import { MemoryStore } from "./persist/memory-store.ts";
import { PlaintextSyncApi } from "./plaintext-api.ts";

it("failed binary uploads retain bytes and do not finalize or commit", async () => {
  const store = new MemoryStore(),
    calls: string[] = [];
  const client = new SupaSyncClient({
    url: "https://sync.example.test",
    anonKey: "public-key",
    session: { getAccessToken: async () => "session" },
    fetch: async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith("/reserve_blob"))
        return Response.json({ ready: false, token: "temporary" });
      if (String(url).endsWith("/supasync-binary"))
        return Response.json({
          url: "https://storage.example.test/upload",
          method: "PUT",
          headers: {},
        });
      return new Response("unavailable", { status: 503 });
    },
  });
  const api = new PlaintextSyncApi(client, store, "vault");
  const request = createEnvelope({
    serverEpoch: "epoch",
    vaultId: "vault",
    clientId: "client",
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    type: "create",
    payload: {
      path: "a.bin",
      kind: "blob",
      bytes: encode(new Uint8Array([0, 255])),
    },
  });
  await store.putOutbox({
    operationId: request.operationId,
    envelope: request,
    extras: {},
    status: "queued",
    sentHash: await hashBytes(new Uint8Array([0, 255])),
  });
  await expect(api.commit(request)).rejects.toThrow("Attachment upload failed");
  expect(calls.filter((c) => c.endsWith("/supasync-binary"))).toHaveLength(1);
  expect(calls.some((c) => c.endsWith("/mutate"))).toBe(false);
  expect((await store.listOutbox())[0]?.envelope).toEqual(request);
});

it("retries the exact persisted request after a lost response", async () => {
  const store = new MemoryStore();
  const requests: string[] = [];
  let lose = true;
  const client = new SupaSyncClient({
    url: "https://sync.example.test",
    anonKey: "public-key",
    session: { getAccessToken: async () => "session" },
    fetch: async (_url, init) => {
      requests.push(init!.body as string);
      if (lose) {
        lose = false;
        throw new Error("lost response");
      }
      return Response.json({ outcome: "accepted" });
    },
  });
  const api = new PlaintextSyncApi(client, store, "vault");
  const request = createEnvelope({
    serverEpoch: "epoch",
    vaultId: "vault",
    clientId: "client",
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    type: "create",
    payload: { path: "a.md", text: "durable" },
  });
  await store.putOutbox({
    operationId: request.operationId,
    envelope: request,
    extras: {},
    status: "queued",
    sentHash: null,
  });
  await expect(api.commit(request)).rejects.toThrow("lost response");
  await api.commit(request);
  expect(requests[0]).toBe(requests[1]);
});
