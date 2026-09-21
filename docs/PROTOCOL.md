# Protocol 3

PostgREST exposes the `supasync` schema. Obsidian sends its public key as `apikey`, its user session as `Authorization: Bearer …`, and the appropriate `Accept-Profile`/`Content-Profile` headers. Authorization requires the UID configured in `supasync.settings`; authentication alone is insufficient.

SQL functions: `capabilities`, `list_vaults`, `create_vault`, `mutate`, `prepare_mutation`, `pull_changes`, `snapshot`, `get_bodies`, `history`, `search`, and `reserve_blob`.

`mutate(p_request jsonb)` accepts:

```json
{
  "protocolVersion": 3,
  "serverEpoch": "installation-uuid",
  "vaultId": "vault-uuid",
  "clientId": "diagnostic-label",
  "operationId": "persistent-operation-uuid",
  "entryId": "stable-file-uuid",
  "type": "update",
  "baseRevisionId": "7",
  "payload": {"text": "Exact new content\n"}
}
```

Supported mutations are create, update, rename, delete, and restore_revision. Create supplies `path`, `kind`, and content. Internal wire kinds `markdown`/`blob` map to database `text`/`binary`; ordinary UTF-8 text need not have a `.md` extension. Rename supplies the new `path`. Binary mutations supply `blob_id` after verified upload. Delete creates a tombstone. Restore is a new mutation against the current revision, not a history rewrite.

File `revision` and global journal `seq` are different. Both travel to JavaScript as decimal strings. Device clocks, arrival order, and filesystem mtimes never decide authority. `clientId` is diagnostic metadata, not enrollment or an access grant.

An operation UUID binds the complete canonical JSON request. Identical retries return the original accepted/conflict result; changed requests fail with ID_REUSE. Stale updates/deletions return a conflict. Folder moves/deletions also declare a `treeBase` map of affected UUIDs to revisions; changes to the subtree reject the complete operation. Every affected row is journaled in one transaction.

For handwritten SQL, call `prepare_mutation` in a transaction and proceed only when its outcome is `ready`; then issue the corresponding INSERT/UPDATE. The trigger verifies the resulting fields against the prepared payload. Finish by reading `mutation_receipts.result` and committing. Use `mutate` when possible because it handles replay and subtree operations directly. Unguarded table writes fail; physical deletion is unavailable to application roles.

The client persists exact content/attachment bytes before network activity. A fetched page advances received_cursor; only durable local application advances applied_cursor. A lost response leaves the operation queued. Conflict copies and rejected request records preserve local work before retiring stale requests. An incomplete listing never means deletion; explicit local events are persisted separately.

The server retains every revision and ready blob. A new installation epoch prevents old queues from writing to a replacement/restored backend. Protocol 2 requests are rejected.
