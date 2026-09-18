# Protocol

Protocol version: `1`  
Path canonicalizer: `pathcanon-1` (NFC display path, NFC + Unicode lower-case + `ß→ss` comparison key)

Cursors are decimal strings. Hashes are lowercase SHA-256 hex of exact UTF-8 bytes. Markdown is never YAML-parsed during sync.

## Envelope

Every mutation includes `protocolVersion`, `serverEpoch`, `vaultId`, `clientId`, `clientGeneration`, `operationId`, `type`, optional `entryId`, optional `baseRevisionId`, and an immutable `payload`. The gateway recomputes `requestDigest` from the canonical JSON of those fields.

Identical `operationId` + digest returns the original outcome. The same `operationId` with a different digest fails with `ID_REUSE`. A conflict is a completed outcome; the follow-up uses a new operation ID.

## Operations

`capabilities`, `list_vaults`, `create_vault`, `register_client`, `begin_snapshot`, `list_snapshot`, `get_revisions`, `get_bodies`, `pull_changes`, `commit`, `rename_tree`, `delete_tree`, `ack_applied`, `begin_blob_upload`, `finalize_blob`, `get_blob_download`, `list_history`, `restore_revision`, `create_conflict_copy`, `resolve_conflict`, `start_storage_migration`, `migration_status`, `add_member`.

Creates require an unused path. Updates and deletes require the exact current `baseRevisionId` (the revision sequence as a decimal string). Folder rename/delete are namespace transactions.

## Errors

`AUTH_REQUIRED`, `PERMISSION_DENIED`, `BASE_CONFLICT`, `PATH_COLLISION`, `STALE_NAMESPACE`, `CURSOR_EXPIRED`, `EPOCH_MISMATCH`, `CLIENT_GENERATION_EXPIRED`, `BLOB_NOT_READY`, `HASH_MISMATCH`, `LIMIT_EXCEEDED`, `PROTOCOL_UPGRADE_REQUIRED`, plus retryable transport/storage codes.

Authentication errors pause for sign-in. Protocol conflicts are not retried unchanged.
