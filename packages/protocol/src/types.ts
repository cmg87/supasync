import type { Seq } from "./seq.ts";

export type MemberRole = "owner" | "editor" | "reader";
export type MemberStatus = "enabled" | "revoked";
export type EntryKind = "markdown" | "blob" | "folder";
export type StorageProvider = "supabase_storage";
export type BlobState =
  | "reserved"
  | "uploading"
  | "finalizing"
  | "ready"
  | "failed"
  | "deleting";
export type SnapshotState = "active" | "complete" | "expired";
export type CommitOutcomeKind = "accepted" | "noop" | "conflict";

export type MutationType =
  | "create"
  | "update"
  | "delete"
  | "rename"
  | "convert_kind"
  | "create_conflict_copy"
  | "resolve_conflict"
  | "restore_revision";

export type ApiOperation =
  | "capabilities"
  | "list_vaults"
  | "create_vault"
  | "register_client"
  | "begin_snapshot"
  | "list_snapshot"
  | "get_tree"
  | "pull_changes"
  | "commit"
  | "ack_applied"
  | "reserve_object"
  | "finalize_object"
  | "get_object"
  | "list_history"
  | "get_vault_keys"
  | "list_devices"
  | "revoke_device"
  | "pair_begin"
  | "pair_get"
  | "pair_approve"
  | "pair_consume";

export type StorageBackendInfo = {
  id: string;
  provider: StorageProvider;
  label: string;
  bucket: string;
  region?: string;
  endpoint?: string;
  isDefault: boolean;
};

export type VaultInfo = {
  encryptedLabel?: import("./v2.ts").EncryptedValue;
  recoveryEnvelope?: import("./v2.ts").EncryptedValue;
  id: string;
  name: string;
  role: MemberRole;
  protocolVersion: number;
  serverEpoch: string;
  headSeq: Seq;
  namespaceSeq: Seq;
  replayFloor: Seq;
  defaultStorageBackendId: string | null;
  retentionDays: number;
  minVersionsPerEntry: number;
  maxBlobBytes: number;
  maxTextBytes: number;
};

export type ClientBinding = {
  vaultId: string;
  clientId: string;
  generation: number;
  label: string;
  platform: string;
  appliedCursor: Seq;
  bootstrapState: string;
};

export type RevisionRecord = {
  vaultId: string;
  seq: Seq;
  entryId: string;
  version: number;
  parentSeq: Seq | null;
  path: string;
  pathKey: string;
  kind: EntryKind;
  textSha256: string | null;
  blobId: string | null;
  tombstone: boolean;
  actorId: string;
  clientId: string;
  operationId: string;
  serverTime: string;
  conflictOf: string | null;
  conflictOperationId: string | null;
};

export type TextBody = {
  sha256: string;
  text: string;
  byteLength: number;
};

export type SignedTransfer = {
  url: string;
  method: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type CommitEnvelope = {
  protocolVersion: number;
  serverEpoch: string;
  vaultId: string;
  clientId: string;
  clientGeneration: number;
  operationId: string;
  type: MutationType;
  entryId?: string;
  baseRevisionId?: Seq;
  payload: Record<string, unknown>;
};

export type CommitResult = {
  outcome: CommitOutcomeKind;
  operationId: string;
  revision?: RevisionRecord;
  current?: RevisionRecord;
  message?: string;
};

export type PullPage = {
  afterSeq: Seq;
  ceiling: Seq;
  nextCursor: Seq;
  exhausted: boolean;
  replayFloor: Seq;
  revisions: RevisionRecord[];
};

export type SnapshotBegin = {
  snapshotId: string;
  headSeq: Seq;
  serverEpoch: string;
  expiresAt: string;
  itemCount: number;
};

export type SnapshotItem = {
  entryId: string;
  revision: RevisionRecord;
};

export type Capabilities = {
  protocolVersion: number;
  compatibleProtocolVersions: number[];
  pathCanonVersion: string;
  serverEpoch: string;
  vaultId: string;
  headSeq: Seq;
  namespaceSeq: Seq;
  replayFloor: Seq;
  retentionDays: number;
  minVersionsPerEntry: number;
  maxBlobBytes: number;
  maxTextBytes: number;
  pullPageSize: number;
  storageBackends: StorageBackendInfo[];
};
