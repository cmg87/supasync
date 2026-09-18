# SupaSync agent notes

This repository implements the specification in `SupaSync-Architecture-and-Build-Plan.md`. Do not replace requested v1 capabilities with TODOs. Do not touch production Supabase projects or a user's real vault. Keep credentials out of source and release assets.

## Non-negotiable invariants

1. Preserve conflicting work. Timestamps, file sizes, and arrival order must never silently discard a competing edit.
2. Entry UUIDs survive renames and content updates. Paths are mutable properties.
3. Updates and deletions declare the exact remote revision they were derived from. The server rejects stale writes.
4. The same operation ID and identical request return the original result. Reusing an ID with different content fails.
5. Entry update, revision, ordered journal record, and mutation receipt succeed or fail in one Postgres transaction. The revision table is the journal.
6. A persistent queue precedes network work. Process loss after send must not lose the pending operation or its payload.
7. Realtime is optional. Polling or manual sync must still converge.
8. Never infer deletion from an empty listing or missing local state.
9. A file revision can reference only an authorized, verified, ready blob.
10. Fetching a journal page is not proof that local changes are durable. Keep `received_cursor` distinct from `applied_cursor`.
11. Device clocks and filesystem mtimes are display/scan hints, not sync authority.
12. Hermes, import tools, and the plugin use the same protocol. Ordinary table updates that skip receipts/history are forbidden.

## Package boundaries

- `packages/protocol`: schemas, errors, path canonicalization, hashes, envelopes. Browser-compatible. No Node or Obsidian imports.
- `packages/sync-core`: bootstrap, pull/push, reconciliation, conflicts, retries, recovery. No Obsidian or Node filesystem imports.
- `packages/client`: authenticated API client for plugin, CLI, and tests.
- `apps/obsidian`: public Obsidian APIs only. `isDesktopOnly: false`. No Node `fs`/`path`/`crypto`/`child_process` at runtime.
- `apps/cli`: Node filesystem adapter for Hermes and automation.
- `supabase`: migrations, RPCs, Edge Functions, pgTAP tests.

## Implementation stages

See `CHECKLIST.md`. Work in project-local Supabase. When a real device or R2 credential is unavailable, deliver code plus a reproducible procedure and mark the target unverified. Do not fabricate passing tests.
