export { SyncEngine, type EngineOptions, type SyncReport } from "./engine/sync-engine.ts";
export { MemoryStore } from "./persist/memory-store.ts";
export { MemoryVault } from "./adapters/memory-vault.ts";
export { MemoryBackend } from "./testing/memory-backend.ts";
export { mergeMarkdown } from "./merge/three-way.ts";
export { conflictCopyPath } from "./reconcile/conflict-path.ts";
export { isExcluded } from "./exclusions.ts";
export type { LocalStore, SyncApi, VaultAdapter, VaultStat, ManifestRow, OutboxRow, ApplyIntent, MetaState } from "./types.ts";
export { EncryptedSyncApi } from './encrypted-api.ts';
