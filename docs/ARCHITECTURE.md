# Architecture

SupaSync keeps an ordinary Obsidian vault on each device. Postgres is the authority for Markdown, identities, revisions, and ordered history. Object storage holds non-Markdown bytes. The plugin is a replica synchronizer, not a mounted database.

```text
Obsidian / CLI
  vault adapter
  sync-core (one engine per local vault)
  local transactional state (manifest, bases, outbox, inbox, receipts)
       |
       +-- Supabase Auth
       +-- Edge Function `supasync-api`
       +-- Realtime wake-up hints (vault id + head seq only)
       +-- short-lived signed HTTP URLs for attachments
```

## Trust boundaries

- The Edge Function verifies the user JWT, ignores client-supplied actor IDs, recomputes path keys and content hashes, and calls service-only RPCs.
- Mutation RPCs are `SECURITY INVOKER`, executable only by `service_role`, and perform their own membership checks because the service role bypasses RLS.
- Data lives in the non-exposed `supasync` schema. `public` contains `supasync_*` RPC wrappers, an optional `supasync_notes` view, and a Realtime wake-up table.
- Storage credentials never enter plugin settings. The plugin stores the project URL, public key, and secret-store references only.

## Sequence numbers

`vaults.head_seq` is a per-vault counter updated under `SELECT ... FOR UPDATE` on the vault row. Sequence objects are not used as the commit cursor. JSON transports sequences as decimal strings.

## Local durability

IndexedDB (plugin) or a filesystem JSON store (CLI) holds the manifest, bases, outbox, inbox, apply intents, and cursors. `received_cursor` is not `applied_cursor`. A journal page is not an ack. File application uses a persisted apply intent because the vault and the metadata store are not one transaction.

## Realtime

Wake-ups are optional. Dropped notifications must not prevent convergence. The wakeup row contains only `vault_id` and `head_seq`.
