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
export {
  prepareMarkdownBody,
  requireBlobPath,
  requireMarkdownPath,
} from "./text.ts";
export type {
  Capabilities,
  CommitEnvelope,
  CommitOutcomeKind,
  CommitResult,
  EntryKind,
  MutationType,
  PullPage,
  RevisionRecord,
  SnapshotBegin,
  SnapshotItem,
  TextBody,
  VaultInfo,
} from "./types.ts";
export { encode, unencode } from "./bytes.ts";
