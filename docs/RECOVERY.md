# Recovery

## Client

If IndexedDB/local state is missing, corrupt, or from another `server_epoch`, the engine enters bootstrap. Readable vault files are preserved. Missing metadata is never treated as “delete everything remotely.”

Copied plugin settings must not reuse another installation's client generation. The installation id lives in local state, not in `data.json`.

Expired replay cursors return `CURSOR_EXPIRED`. Rebuild from a snapshot while keeping local work.

## Server

Restoring a database backup does not by itself rotate `server_epoch`. After a restore:

1. Confirm object-store backups match the restored blob locations.
2. `update supasync.vaults set server_epoch = gen_random_uuid();`
3. Force every client to reconcile (they will see `EPOCH_MISMATCH`).
4. A client cursor ahead of `head_seq` is also a rollback signal.

Retention default: 30-day replay horizon, current heads kept, at least 20 versions per entry when present. The floor only advances contiguously. Blobs are not collected while a head, retained revision, snapshot, or active finalizer references them.
