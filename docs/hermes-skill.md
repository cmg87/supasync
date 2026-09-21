# Hermes: direct PostgreSQL

Hermes is trusted infrastructure, not a SupaSync user. Obtain the dedicated connection with `supasync hermes connection` and store it securely. The CLI uses the generated CA and verifies TLS. For another host, set `SUPASYNC_DATABASE_URL` and `SUPASYNC_DATABASE_CA` (a certificate file). The default database port binds to loopback; use an SSH tunnel or an explicitly secured private PostgreSQL listener for remote access.

No Supabase Auth login, JWT, service-role key, enrollment, daemon, or running Obsidian process is required.

```sql
SELECT id, name FROM supasync.vaults;
SELECT id, path, content, revision FROM supasync.files
WHERE vault_id = :'vault_id' AND NOT deleted AND kind = 'text';
SELECT id, path, content FROM supasync.search(:'vault_id', 'meeting notes');
SELECT revision, state FROM supasync.revisions
WHERE file_id = :'file_id' ORDER BY seq;
```

Use bound parameters in application code. A write declares the exact revision read:

```sql
SELECT supasync.mutate(jsonb_build_object(
  'protocolVersion', 3,
  'serverEpoch', supasync.capabilities()->>'serverEpoch',
  'vaultId', :'vault_id', 'entryId', :'file_id',
  'clientId', 'hermes', 'operationId', :'operation_id',
  'type', 'update', 'baseRevisionId', :'revision',
  'payload', jsonb_build_object('text', :'new_content')
));
```

Persist the operation UUID and complete payload before sending, and inspect the returned outcome. Reuse the identical request to resolve a lost response. Never fetch a newer revision and blindly resubmit an older edit. Resolve the conflict first.

Guarded direct table edits are also supported:

```sql
BEGIN;
SELECT supasync.prepare_mutation(:'complete_request'::jsonb);
-- Continue ONLY for outcome=ready. A replay/conflict is already a result.
UPDATE supasync.files SET content = :'new_content' WHERE id = :'file_id';
SELECT result FROM supasync.mutation_receipts WHERE operation_id = :'operation_id';
COMMIT;
```

Use the helper for tree operations. Delete through a mutation/tombstone, never physical DELETE. Do not update revisions, receipts, hashes, counters, or Supabase Storage metadata.

CLI writes accept `--base-revision` and `--operation-id`; pending requests survive process loss outside the vault. `supasync retry` replays saved requests. A conflict exits with status 2 and saves its outcome. `write --binary` uploads through a blob-scoped capability obtained over SQL; `SUPASYNC_URL`/`SUPASYNC_PUBLIC_KEY` provide the public binary endpoint when setup configuration is absent. The DB role never receives a service-role key.
