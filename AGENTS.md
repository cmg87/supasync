# SupaSync agent notes

This repository implements the single-owner plaintext design in `docs/ARCHITECTURE.md` and protocol 3 in `docs/PROTOCOL.md`. The root v1/v2 plans are historical. Do not replace requested capabilities with TODOs. Do not touch production Supabase projects or a user's real vault. Keep credentials out of source and release assets.

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
12. Hermes uses direct PostgreSQL. Guarded table writes and plugin RPCs use the same trigger-enforced mutation contract; writes that skip receipts/history are forbidden.

## Package boundaries

- `packages/protocol`: schemas, errors, path canonicalization, hashes, envelopes. Browser-compatible. No Node or Obsidian imports.
- `packages/sync-core`: bootstrap, pull/push, reconciliation, conflicts, retries, recovery. No Obsidian or Node filesystem imports.
- `packages/client`: public-key authenticated PostgREST/Storage client for the plugin and tests.
- `apps/obsidian`: public Obsidian APIs only. `isDesktopOnly: false`. No Node `fs`/`path`/`crypto`/`child_process` at runtime.
- `apps/cli`: setup/administration and direct PostgreSQL operations for Hermes. No Auth login or daemon requirement.
- `supabase`: migrations, RPCs, Edge Functions, pgTAP tests.

## Implementation stages

See `CHECKLIST.md`. Work only in disposable or explicitly selected development backends. Production setup never seeds fixtures. When a real device is unavailable, deliver code plus a reproducible procedure and mark the target unverified. Do not fabricate passing tests.
