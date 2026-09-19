import { SupaSyncClient } from "@supasync/client";
import {
  canonicalizePath,
  hashBytes,
  hashMarkdown,
  type CommitEnvelope,
  type CommitResult,
  type RevisionRecord,
  type WireRevision,
  type WireMutation,
  type EncryptedEntry,
  type PullPage,
  type SnapshotBegin,
} from "@supasync/protocol";
import {
  encryptName,
  decryptName,
  nameToken,
  sealObject,
  openObject,
  encode,
  unencode,
  type Context,
} from "@supasync/crypto";
import type { LocalStore, SyncApi } from "./types.ts";
type Cache = { head: string; entries: Record<string, WireRevision> };
type Plan = {
  envelope: WireMutation;
  object?: { id: string; bytes: string; hash: string; length: number };
};
/** Encryption boundary: the existing reconciler sees local paths/bodies; the network never does. */
export class EncryptedSyncApi implements SyncApi {
  private cache: Cache = { head: "0", entries: {} };
  private loaded = false;
  private snapshots = new Map<string, string>();
  constructor(
    private client: SupaSyncClient,
    private store: LocalStore,
    private vaultId: string,
    private master: Uint8Array,
    private transport: typeof fetch,
    private serverUrl: string,
  ) {}
  private async rpc<T>(
    operation: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const meta = await this.store.getMeta();
    return this.client.rpc<T>(operation, {
      vaultId: this.vaultId,
      clientId: meta.clientId,
      ...payload,
    });
  }
  async capabilities(_vaultId: string) {
    const caps = await this.rpc<{
      serverEpoch: string;
      headSeq: string;
      namespaceSeq: string;
      replayFloor: string;
      protocolVersion: number;
    }>("capabilities");
    if (caps.protocolVersion !== 2)
      throw new Error("PROTOCOL_UPGRADE_REQUIRED");
    if (!this.loaded) {
      this.cache =
        (await this.store.getCache<Cache>("encrypted-tree")) ?? this.cache;
      this.loaded = true;
    }
    let after = this.cache.head;
    while (BigInt(after) < BigInt(caps.headSeq)) {
      const page = await this.rpc<{
        revisions: WireRevision[];
        nextCursor: string;
        exhausted: boolean;
      }>("get_tree", { afterSeq: after, ceiling: caps.headSeq });
      for (const r of page.revisions) {
        this.cache.entries[r.entryId] = r;
        await this.store.putCache(`wire-revision:${r.seq}`, r);
        if (r.objectId) await this.store.putCache(`object:${r.objectId}`, r);
      }
      if (page.nextCursor === after && !page.exhausted)
        throw new Error("CURSOR_STALLED");
      after = page.nextCursor;
      this.cache.head = after;
      await this.store.putCache("encrypted-tree", this.cache);
      if (page.exhausted) break;
    }
    return caps;
  }
  private context(
    r: Pick<WireRevision, "entryId" | "objectId" | "kind" | "keyVersion">,
  ): Context {
    return {
      vaultId: this.vaultId,
      entryId: r.entryId,
      objectId: r.objectId!,
      keyVersion: r.keyVersion,
      purpose: r.kind === "blob" ? "attachment" : "content",
    };
  }
  private path(r: WireRevision, visited = new Set<string>()): string {
    if (visited.has(r.entryId)) throw new Error("INVALID_PARENT");
    visited.add(r.entryId);
    const name = decryptName(this.master, r.encryptedName, {
      vaultId: this.vaultId,
      entryId: r.entryId,
      objectId: r.nameObjectId,
      keyVersion: r.keyVersion,
    });
    if (
      nameToken(this.master, this.vaultId, r.parentEntryId, name) !==
      r.nameToken
    )
      throw new Error("INVALID_NAME_TOKEN");
    if (!r.parentEntryId) return name;
    const parent = this.cache.entries[r.parentEntryId];
    if (!parent) throw new Error("MISSING_ENCRYPTED_PARENT");
    return `${this.path(parent, visited)}/${name}`;
  }
  private async content(r: WireRevision): Promise<Uint8Array> {
    if (!r.objectId) return new Uint8Array();
    const cached = await this.store.getCache<string>(
      `plaintext-object:${r.objectId}`,
    );
    if (cached !== null) return unencode(cached);
    const signed = await this.rpc<{
      transfer: {
        url: string;
        method: string;
        headers: Record<string, string>;
      };
      ciphertextSha256: string;
      ciphertextLength: number;
    }>("get_object", { objectId: r.objectId });
    const response = await this.transport(
      new URL(signed.transfer.url, this.serverUrl),
      { method: signed.transfer.method, headers: signed.transfer.headers },
    );
    if (!response.ok) throw new Error(`RETRYABLE_STORAGE:${response.status}`);
    const ciphertext = new Uint8Array(await response.arrayBuffer());
    if (
      ciphertext.length !== signed.ciphertextLength ||
      (await hashBytes(ciphertext)) !== signed.ciphertextSha256
    )
      throw new Error("HASH_MISMATCH");
    const bytes = openObject(this.master, ciphertext, this.context(r));
    await this.store.putCache(`plaintext-object:${r.objectId}`, encode(bytes));
    if (r.kind === "markdown") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      await this.store.putCache(`body:${await hashMarkdown(text)}`, text);
    }
    return bytes;
  }
  private async local(r: WireRevision): Promise<RevisionRecord> {
    let hash: string | null = null;
    if (!r.tombstone && r.kind !== "folder")
      hash = await hashBytes(await this.content(r));
    const path = this.path(r);
    return {
      ...r,
      path,
      pathKey: canonicalizePath(path).pathKey,
      textSha256: hash,
      blobId: r.kind === "blob" ? r.objectId : null,
      conflictOf: null,
      conflictOperationId: null,
    };
  }
  async commit(local: CommitEnvelope): Promise<CommitResult> {
    const row = (await this.store.listOutbox()).find(
      (row) => row.operationId === local.operationId,
    );
    if (!row) throw new Error("PERSISTENT_OUTBOX_REQUIRED");
    let plan = row.wire as Plan | undefined;
    if (!plan) {
      const current = this.cache.entries[local.entryId!];
      const path = canonicalizePath(
        String(local.payload.path ?? (current ? this.path(current) : "")),
      ).display;
      let payload: EncryptedEntry | Record<string, never> = {};
      let object: Plan["object"];
      if (local.type !== "delete") {
        const parts = path.split("/");
        const name = parts.pop()!;
        const parentPath = parts.join("/");
        const parent = parentPath
          ? Object.values(this.cache.entries).find(
              (r) =>
                !r.tombstone &&
                r.kind === "folder" &&
                this.path(r) === parentPath,
            )
          : null;
        if (parentPath && !parent) throw new Error("MISSING_ENCRYPTED_PARENT");
        const kind = (local.payload.kind ??
          current?.kind ??
          "markdown") as EncryptedEntry["kind"];
        let objectId = current?.objectId ?? null;
        if (
          kind !== "folder" &&
          (typeof local.payload.text === "string" ||
            typeof local.payload.bytes === "string")
        ) {
          objectId = crypto.randomUUID();
          const bytes =
            typeof local.payload.text === "string"
              ? new TextEncoder().encode(local.payload.text)
              : unencode(String(local.payload.bytes));
          const sealed = sealObject(
            this.master,
            bytes,
            this.context({
              entryId: local.entryId!,
              objectId,
              kind,
              keyVersion: 1,
            }),
          );
          object = {
            id: objectId,
            bytes: encode(sealed),
            hash: await hashBytes(sealed),
            length: sealed.length,
          };
          await this.store.putCache(
            `plaintext-object:${objectId}`,
            encode(bytes),
          );
          if (kind === "markdown")
            await this.store.putCache(
              `body:${await hashBytes(bytes)}`,
              new TextDecoder().decode(bytes),
            );
        }
        const nameObjectId = crypto.randomUUID();
        const parentEntryId = parent?.entryId ?? null;
        payload = {
          parentEntryId,
          nameObjectId,
          encryptedName: encryptName(this.master, name, {
            vaultId: this.vaultId,
            entryId: local.entryId!,
            objectId: nameObjectId,
            keyVersion: 1,
          }),
          nameToken: nameToken(this.master, this.vaultId, parentEntryId, name),
          kind,
          objectId,
          keyVersion: 1,
        };
      }
      plan = {
        envelope: {
          protocolVersion: 2,
          cryptoVersion: 1,
          serverEpoch: local.serverEpoch,
          vaultId: this.vaultId,
          clientId: local.clientId,
          clientGeneration: local.clientGeneration,
          operationId: local.operationId,
          entryId: local.entryId!,
          baseRevisionId: local.baseRevisionId,
          type: local.type as WireMutation["type"],
          payload,
        },
        object,
      };
      // Persist the exact randomized ciphertext before reserving, uploading or sending anything.
      await this.store.putOutbox({ ...row, wire: plan });
    }
    if (plan.object) {
      const o = plan.object;
      const request = {
        objectId: o.id,
        ciphertextSha256: o.hash,
        ciphertextLength: o.length,
      };
      const reserved = await this.rpc<{
        ready: boolean;
        transfer?: {
          url: string;
          method: string;
          headers: Record<string, string>;
        };
      }>("reserve_object", request);
      if (!reserved.ready) {
        if (!reserved.transfer) throw new Error("BLOB_NOT_READY");
        const res = await this.transport(
          new URL(reserved.transfer.url, this.serverUrl),
          {
            method: reserved.transfer.method,
            headers: reserved.transfer.headers,
            body: unencode(o.bytes) as BodyInit,
          },
        );
        if (!res.ok) throw new Error(`RETRYABLE_STORAGE:${res.status}`);
        await this.rpc("finalize_object", request);
      }
    }
    const result = await this.rpc<{
      outcome: "accepted" | "noop" | "conflict";
      operationId: string;
      revision?: WireRevision;
      current?: WireRevision;
      message?: string;
    }>("commit", { envelope: plan.envelope });
    for (const r of [result.revision, result.current])
      if (r) {
        this.cache.entries[r.entryId] = r;
        await this.store.putCache(`wire-revision:${r.seq}`, r);
        if (r.objectId) await this.store.putCache(`object:${r.objectId}`, r);
      }
    await this.store.putCache("encrypted-tree", this.cache);
    return {
      ...result,
      revision: result.revision ? await this.local(result.revision) : undefined,
      current: result.current ? await this.local(result.current) : undefined,
    };
  }
  async pullChanges(input: {
    vaultId: string;
    afterSeq: string;
    ceiling?: string;
    limit?: number;
  }): Promise<PullPage> {
    const page = await this.rpc<
      Omit<PullPage, "revisions"> & { revisions: WireRevision[] }
    >("pull_changes", {
      afterSeq: input.afterSeq,
      ceiling: input.ceiling,
      limit: input.limit,
    });
    const revisions: RevisionRecord[] = [];
    for (const r of page.revisions) {
      this.cache.entries[r.entryId] = r;
      revisions.push(await this.local(r));
    }
    return { ...page, revisions };
  }
  async beginSnapshot(_input: unknown): Promise<SnapshotBegin> {
    return this.rpc("begin_snapshot");
  }
  async listSnapshot(input: {
    snapshotId: string;
    afterEntryId?: string;
    limit?: number;
  }) {
    const page = await this.rpc<{
      items: Array<{ entryId: string; revision: WireRevision }>;
      nextCursor: string | null;
      exhausted: boolean;
    }>("list_snapshot", input);
    return {
      ...page,
      items: await Promise.all(
        page.items.map(async (item) => ({
          ...item,
          revision: await this.local(item.revision),
        })),
      ),
    };
  }
  async getBodies(_vaultId: string, hashes: string[]) {
    const bodies = [];
    for (const hash of hashes) {
      let text = await this.store.getCache<string>(`body:${hash}`);
      if (text === null) {
        // Only needed when recovering an old merge base after restart; no plaintext hash is sent remotely.
        for (let seq = 1n; seq <= BigInt(this.cache.head); seq++) {
          const r = await this.store.getCache<WireRevision>(
            `wire-revision:${seq}`,
          );
          if (r?.kind === "markdown" && r.objectId) await this.content(r);
          text = await this.store.getCache<string>(`body:${hash}`);
          if (text !== null) break;
        }
      }
      if (text !== null)
        bodies.push({
          sha256: hash,
          text,
          byteLength: new TextEncoder().encode(text).length,
        });
    }
    return { bodies };
  }
  async history(entryId: string) {
    const revisions: WireRevision[] = [];
    let afterSeq = "0";
    for (;;) {
      const page = await this.rpc<{
        revisions: WireRevision[];
        nextCursor: string;
        exhausted: boolean;
      }>("list_history", { entryId, afterSeq });
      revisions.push(...page.revisions);
      if (page.exhausted) break;
      if (page.nextCursor === afterSeq) throw new Error("CURSOR_STALLED");
      afterSeq = page.nextCursor;
    }
    return revisions.map((r) => ({
      entryId: r.entryId,
      seq: r.seq,
      path: this.path(r),
      kind: r.kind,
      tombstone: r.tombstone,
      serverTime: r.serverTime,
    }));
  }
  async revisionBytes(entryId: string, seq: string) {
    const r = await this.store.getCache<WireRevision>(`wire-revision:${seq}`);
    if (!r || r.entryId !== entryId || r.tombstone || r.kind === "folder")
      throw new Error("Revision content is unavailable");
    return this.content(r);
  }
  async readBlob(blobId: string): Promise<Uint8Array> {
    const r =
      (await this.store.getCache<WireRevision>(`object:${blobId}`)) ??
      Object.values(this.cache.entries).find((r) => r.objectId === blobId);
    if (!r) throw new Error("BLOB_NOT_READY");
    return this.content(r);
  }
  ackApplied(input: { appliedSeq: string }) {
    return this.rpc("ack_applied", { appliedSeq: input.appliedSeq });
  }
  async beginBlobUpload(): Promise<Record<string, unknown>> {
    throw new Error("PLAINTEXT_UPLOAD_FORBIDDEN");
  }
  async finalizeBlob(): Promise<{ blobId: string; state: string }> {
    throw new Error("PLAINTEXT_UPLOAD_FORBIDDEN");
  }
  async getBlobDownload(): Promise<{
    transfer: { url: string; method: string; headers: Record<string, string> };
    verifiedSha256: string;
    verifiedLength: number;
  }> {
    throw new Error("USE_ENCRYPTED_READ");
  }
  async renameTree(): Promise<unknown> {
    throw new Error("USE_CONDITIONAL_ENTRY_RENAME");
  }
  async deleteTree(): Promise<unknown> {
    throw new Error("DELETE_CHILDREN_WITH_EXACT_BASES");
  }
}
