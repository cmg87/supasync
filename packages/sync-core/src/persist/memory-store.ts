import { seqZero } from "@supasync/protocol";
import type { ApplyIntent, LocalStore, ManifestRow, MetaState, OutboxRow } from "../types.ts";

export class MemoryStore implements LocalStore {
  private meta: MetaState;
  private manifest = new Map<string, ManifestRow>();
  private outbox = new Map<string, OutboxRow>();
  private intents = new Map<string, ApplyIntent>();

  constructor(seed?: Partial<MetaState>) {
    this.meta = {
      installationId: seed?.installationId ?? crypto.randomUUID(),
      clientId: seed?.clientId ?? crypto.randomUUID(),
      generation: seed?.generation ?? 1,
      vaultId: seed?.vaultId ?? null,
      serverEpoch: seed?.serverEpoch ?? null,
      receivedCursor: seed?.receivedCursor ?? seqZero(),
      appliedCursor: seed?.appliedCursor ?? seqZero(),
      label: seed?.label ?? "test",
      platform: seed?.platform ?? "test",
    };
  }

  async getMeta(): Promise<MetaState> {
    return { ...this.meta };
  }
  async putMeta(meta: MetaState): Promise<void> {
    this.meta = { ...meta };
  }
  async getManifest(): Promise<Map<string, ManifestRow>> {
    return new Map(this.manifest);
  }
  async putManifest(row: ManifestRow): Promise<void> {
    this.manifest.set(row.entryId, { ...row });
  }
  async deleteManifest(entryId: string): Promise<void> {
    this.manifest.delete(entryId);
  }
  async listOutbox(): Promise<OutboxRow[]> {
    return [...this.outbox.values()].map((row) => ({ ...row }));
  }
  async putOutbox(row: OutboxRow): Promise<void> {
    this.outbox.set(row.operationId, { ...row });
  }
  async deleteOutbox(operationId: string): Promise<void> {
    this.outbox.delete(operationId);
  }
  async putIntent(intent: ApplyIntent): Promise<void> {
    this.intents.set(intent.path, { ...intent });
  }
  async getIntent(path: string): Promise<ApplyIntent | null> {
    return this.intents.get(path) ? { ...this.intents.get(path)! } : null;
  }
  async deleteIntent(path: string): Promise<void> {
    this.intents.delete(path);
  }
  async listIntents(): Promise<ApplyIntent[]> {
    return [...this.intents.values()].map((row) => ({ ...row }));
  }
}
