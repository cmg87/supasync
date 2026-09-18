import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { seqZero } from "@supasync/protocol";
import type { ApplyIntent, LocalStore, ManifestRow, MetaState, OutboxRow } from "@supasync/sync-core";

type DiskState = {
  meta: MetaState;
  manifest: ManifestRow[];
  outbox: OutboxRow[];
  intents: ApplyIntent[];
};

export class FileStore implements LocalStore {
  constructor(private readonly file: string) {}

  async getMeta(): Promise<MetaState> {
    return (await this.load()).meta;
  }
  async putMeta(meta: MetaState): Promise<void> {
    const state = await this.load();
    state.meta = meta;
    await this.save(state);
  }
  async getManifest(): Promise<Map<string, ManifestRow>> {
    return new Map((await this.load()).manifest.map((row) => [row.entryId, row]));
  }
  async putManifest(row: ManifestRow): Promise<void> {
    const state = await this.load();
    state.manifest = state.manifest.filter((item) => item.entryId !== row.entryId);
    state.manifest.push(row);
    await this.save(state);
  }
  async deleteManifest(entryId: string): Promise<void> {
    const state = await this.load();
    state.manifest = state.manifest.filter((item) => item.entryId !== entryId);
    await this.save(state);
  }
  async listOutbox(): Promise<OutboxRow[]> {
    return (await this.load()).outbox;
  }
  async putOutbox(row: OutboxRow): Promise<void> {
    const state = await this.load();
    state.outbox = state.outbox.filter((item) => item.operationId !== row.operationId);
    state.outbox.push(row);
    await this.save(state);
  }
  async deleteOutbox(operationId: string): Promise<void> {
    const state = await this.load();
    state.outbox = state.outbox.filter((item) => item.operationId !== operationId);
    await this.save(state);
  }
  async putIntent(intent: ApplyIntent): Promise<void> {
    const state = await this.load();
    state.intents = state.intents.filter((item) => item.path !== intent.path);
    state.intents.push(intent);
    await this.save(state);
  }
  async getIntent(path: string): Promise<ApplyIntent | null> {
    return (await this.load()).intents.find((item) => item.path === path) ?? null;
  }
  async deleteIntent(path: string): Promise<void> {
    const state = await this.load();
    state.intents = state.intents.filter((item) => item.path !== path);
    await this.save(state);
  }
  async listIntents(): Promise<ApplyIntent[]> {
    return (await this.load()).intents;
  }

  private async load(): Promise<DiskState> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as DiskState;
    } catch {
      return {
        meta: {
          installationId: crypto.randomUUID(),
          clientId: crypto.randomUUID(),
          generation: 1,
          vaultId: null,
          serverEpoch: null,
          receivedCursor: seqZero(),
          appliedCursor: seqZero(),
          label: "hermes",
          platform: "cli",
        },
        manifest: [],
        outbox: [],
        intents: [],
      };
    }
  }

  private async save(state: DiskState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await writeFile(this.file, JSON.stringify(state, null, 2));
  }
}
