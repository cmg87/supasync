export const PLUGIN_ID = "supasync";
export const PROTOCOL_VERSION = 3;
export const PATH_CANON_VERSION = "pathcanon-4";
export const MIN_OBSIDIAN_VERSION = "1.11.4";

export const DEFAULT_LIMITS = {
  maxBlobBytes: 25 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  maxPathBytes: 1024,
  maxComponentBytes: 255,
} as const;

export const DIAGNOSTIC_PREFIX = "__supasync_diag__";
export const DEFAULT_STORAGE_BUCKET = "supasync-blobs";
