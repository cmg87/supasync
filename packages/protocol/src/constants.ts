export const PLUGIN_ID = "supasync";
export const PROTOCOL_VERSION = 1;
export const PATH_CANON_VERSION = "pathcanon-1";
export const MIN_OBSIDIAN_VERSION = "1.11.4";

export const DEFAULT_LIMITS = {
  maxBlobBytes: 25 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  pullPageSize: 100,
  commitBatchSize: 25,
  debounceMs: 750,
  debounceMaxMs: 5_000,
  pollIntervalMs: 60_000,
  replayHorizonDays: 30,
  minVersionsPerEntry: 20,
  snapshotExpiryHours: 24,
  signedUrlTtlSec: 120,
  blobUploadTtlSec: 30 * 60,
  finalizationLeaseSec: 120,
  mobileBlobConcurrency: 1,
  desktopBlobConcurrency: 2,
  maxPathBytes: 1024,
  maxComponentBytes: 255,
} as const;

export const DIAGNOSTIC_PREFIX = "__supasync_diag__";
export const DEFAULT_STORAGE_BUCKET = "supasync-blobs";
