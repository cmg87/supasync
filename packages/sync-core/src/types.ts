import type { EntryKind, Seq } from "@supasync/protocol";

export type FileKind = "file" | "folder";

export type VaultStat = {
  path: string;
  kind: FileKind;
  byteLength: number;
};

export interface VaultAdapter {
  list(): Promise<VaultStat[]>;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(
    path: string,
    text: string,
    expected?: string | null,
  ): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  configDir(): string;
}

export type ManifestRow = {
  entryId: string;
  path: string;
  kind: EntryKind;
  remoteSeq: Seq;
  remoteHash: string | null;
  localHash: string | null;
  baseSeq: Seq;
  baseHash: string | null;
  deleted: boolean;
  blobId: string | null;
};

export type OutboxRow = {
  operationId: string;
  envelope: unknown;
  extras: { pathKey?: string; textSha256?: string };
  status: "queued" | "in_flight" | "done";
  sentHash: string | null;
  wire?: unknown;
};

export type ApplyIntent = {
  fromPath?: string;
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  seq: Seq;
  entryId: string;
};

export type MetaState = {
  installationId: string;
  clientId: string;
  vaultId: string | null;
  serverEpoch: string | null;
  receivedCursor: Seq;
  appliedCursor: Seq;
  label: string;
  platform: string;
};

export interface LocalStore {
  getCache<T>(key: string): Promise<T | null>;
  putCache(key: string, value: unknown): Promise<void>;
  getMeta(): Promise<MetaState>;
  putMeta(meta: MetaState): Promise<void>;
  getManifest(): Promise<Map<string, ManifestRow>>;
  putManifest(row: ManifestRow): Promise<void>;
  deleteManifest(entryId: string): Promise<void>;
  listOutbox(): Promise<OutboxRow[]>;
  putOutbox(row: OutboxRow): Promise<void>;
  deleteOutbox(operationId: string): Promise<void>;
  putIntent(intent: ApplyIntent): Promise<void>;
  getIntent(path: string): Promise<ApplyIntent | null>;
  deleteIntent(path: string): Promise<void>;
  listIntents(): Promise<ApplyIntent[]>;
}

export type SyncApi = {
  readBlob(blobId: string): Promise<Uint8Array>;
  capabilities(vaultId: string): Promise<{
    serverEpoch: string;
    headSeq: string;
    namespaceSeq: string;
    replayFloor: string;
    protocolVersion: number;
  }>;
  commit(
    envelope: import("@supasync/protocol").CommitEnvelope,
    extras?: { pathKey?: string; textSha256?: string },
  ): Promise<import("@supasync/protocol").CommitResult>;
  pullChanges(input: {
    vaultId: string;
    afterSeq: string;
    ceiling?: string;
    limit?: number;
  }): Promise<import("@supasync/protocol").PullPage>;
  beginSnapshot(input: {
    vaultId: string;
    clientId: string;
  }): Promise<import("@supasync/protocol").SnapshotBegin>;
  listSnapshot(input: {
    snapshotId: string;
    afterEntryId?: string;
    limit?: number;
  }): Promise<{
    items: import("@supasync/protocol").SnapshotItem[];
    nextCursor: string | null;
    exhausted: boolean;
  }>;
  getBodies(
    vaultId: string,
    sha256s: string[],
  ): Promise<{
    bodies: Array<{ sha256: string; text: string; byteLength: number }>;
  }>;
};
