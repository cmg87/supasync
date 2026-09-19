export {
  DEFAULT_LIMITS,
  DIAGNOSTIC_PREFIX,
  DEFAULT_STORAGE_BUCKET,
  MIN_OBSIDIAN_VERSION,
  PATH_CANON_VERSION,
  PLUGIN_ID,
  PROTOCOL_VERSION,
} from "./constants.ts";
export {
  ERROR_CODES,
  ProtocolError,
  errorFromWire,
  isProtocolError,
  type ErrorCode,
} from "./errors.ts";
export {
  compareSeq,
  maxSeq,
  seqFromBigInt,
  seqToBigInt,
  seqZero,
  type Seq,
} from "./seq.ts";
export { canonicalJson } from "./canonical-json.ts";
export {
  bytesContainNul,
  digestCanonical,
  hashBytes,
  hashMarkdown,
  sha256Hex,
  textContainsNul,
  utf8Bytes,
} from "./hash.ts";
export {
  canonicalizePath,
  foldPathComponent,
  isMarkdownPath,
  joinDisplayPath,
  parentDisplayPath,
  replacePrefix,
  type CanonicalPath,
} from "./path/canonicalize.ts";
export { PATH_CANON_FIXTURES, type PathFixture } from "./path/fixtures.ts";
export { assertEnvelope, createEnvelope, envelopeDigest } from "./envelope.ts";
export { prepareMarkdownBody, requireBlobPath, requireMarkdownPath } from "./text.ts";
export type {
  ApiOperation,
  BlobState,
  Capabilities,
  ClientBinding,
  CommitEnvelope,
  CommitOutcomeKind,
  CommitResult,
  EntryKind,
  MemberRole,
  MemberStatus,
  MutationType,
  PullPage,
  RevisionRecord,
  SignedTransfer,
  SnapshotBegin,
  SnapshotItem,
  StorageBackendInfo,
  StorageProvider,
  TextBody,
  VaultInfo,
} from "./types.ts";
export * from './v2.ts';
