import { SupaSyncClient } from "@supasync/client";
import {
  hashBytes,
  unencode,
  type CommitEnvelope,
  type CommitResult,
  type PullPage,
  type RevisionRecord,
  type SnapshotBegin,
  type SnapshotItem,
} from "@supasync/protocol";
import type { LocalStore, SyncApi } from "./types.ts";
/** The outbox is durable before this adapter does network work. */
export class PlaintextSyncApi implements SyncApi {
  constructor(
    private client: SupaSyncClient,
    private store: LocalStore,
    private vaultId: string,
  ) {}
  capabilities(vaultId: string) {
    return this.client.capabilities(vaultId);
  }
  async commit(envelope: CommitEnvelope): Promise<CommitResult> {
    const row = (await this.store.listOutbox()).find(
      (r) => r.operationId === envelope.operationId,
    );
    if (!row) throw new Error("Mutation must be persisted before sending");
    let request = row.wire as CommitEnvelope | undefined;
    if (!request) {
      request = structuredClone(envelope);
      if (typeof request.payload.bytes === "string") {
        const bytes = unencode(request.payload.bytes);
        const id = request.operationId;
        const blob = await this.client.rpc<{ ready: boolean; token: string }>(
          "reserve_blob",
          {
            p_id: id,
            p_vault_id: this.vaultId,
            p_sha256: await hashBytes(bytes),
            p_length: bytes.length,
          },
        );
        if (!blob.ready) {
          const transfer = await this.client.binary("upload", id, blob.token);
          const response = await this.client.config.fetch(transfer.url, {
            method: transfer.method,
            headers: transfer.headers,
            body: bytes as unknown as BodyInit,
          });
          if (!response.ok) throw new Error("Attachment upload failed");
          await this.client.binary("finalize", id, blob.token);
        }
        delete request.payload.bytes;
        request.payload.blob_id = id;
      }
      await this.store.putOutbox({ ...row, wire: request });
    }
    return this.client.rpc("mutate", { p_request: request });
  }
  pullChanges(input: {
    vaultId: string;
    afterSeq: string;
    ceiling?: string;
    limit?: number;
  }): Promise<PullPage> {
    return this.client.rpc("pull_changes", {
      p_vault_id: input.vaultId,
      p_after: input.afterSeq,
      p_ceiling: input.ceiling,
      p_limit: input.limit ?? 100,
    });
  }
  async beginSnapshot(): Promise<SnapshotBegin> {
    const caps = await this.capabilities(this.vaultId);
    return {
      snapshotId: caps.headSeq,
      headSeq: caps.headSeq,
      serverEpoch: caps.serverEpoch,
      expiresAt: "",
      itemCount: 0,
    };
  }
  listSnapshot(input: {
    snapshotId: string;
    afterEntryId?: string;
    limit?: number;
  }): Promise<{
    items: SnapshotItem[];
    nextCursor: string | null;
    exhausted: boolean;
  }> {
    return this.client.rpc("snapshot", {
      p_vault_id: this.vaultId,
      p_ceiling: input.snapshotId,
      p_after: input.afterEntryId,
      p_limit: input.limit ?? 100,
    });
  }
  getBodies(
    vaultId: string,
    hashes: string[],
  ): Promise<{
    bodies: Array<{ sha256: string; text: string; byteLength: number }>;
  }> {
    return this.client.rpc("get_bodies", {
      p_vault_id: vaultId,
      p_hashes: hashes,
    });
  }
  async history(entryId: string): Promise<RevisionRecord[]> {
    const rows: RevisionRecord[] = [];
    for (;;) {
      const page = await this.client.rpc<RevisionRecord[]>("history", {
        p_vault_id: this.vaultId,
        p_file_id: entryId,
        p_after: rows.at(-1)?.seq ?? "0",
      });
      rows.push(...page);
      if (page.length < 100) return rows;
    }
  }
  async readBlob(id: string): Promise<Uint8Array> {
    const transfer = await this.client.binary("download", id);
    const response = await this.client.config.fetch(transfer.url, {
      method: transfer.method,
      headers: transfer.headers,
    });
    if (!response.ok) throw new Error("Attachment download failed");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const metadata = transfer as typeof transfer & {
      sha256: string;
      byte_length: number;
    };
    if (
      bytes.length !== metadata.byte_length ||
      (await hashBytes(bytes)) !== metadata.sha256
    )
      throw new Error("HASH_MISMATCH");
    return bytes;
  }
}
