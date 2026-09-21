import type { Seq } from "./seq.ts";

export type EntryKind = "markdown" | "blob" | "folder";
export type CommitOutcomeKind = "accepted" | "noop" | "conflict";

export type MutationType =
  | "create"
  | "update"
  | "delete"
  | "rename"
  | "restore_revision";

export type VaultInfo = { id: string; name: string };

export type RevisionRecord = {
  revision: Seq;
  content?: string | null;
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

export type CommitEnvelope = {
  protocolVersion: number;
  serverEpoch: string;
  vaultId: string;
  clientId: string;
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
  serverEpoch: string;
  headSeq: Seq;
  namespaceSeq: Seq;
  replayFloor: Seq;
};
