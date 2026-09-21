# Plaintext simplification: refactor decisions

This is the implementation record for the approved personal, single-owner design. The old root v1/v2 specifications are historical, not additional requirements.

## Delete outright

Removed the crypto and daemon-client packages, daemon application, recovery/key/pairing UI and client, encrypted API adapter, encrypted protocol types, ciphertext dispatcher, encrypted v2 migration, and fixture-seeding install flows. There is no replacement Hono server. The only Edge Function performs verified, immutable binary transfers, which require the Storage API rather than metadata-only SQL writes.

## Retain and simplify

The protocol, client, sync-core, Obsidian adapters, and installer remain separate packages. The client now calls PostgREST directly. The CLI uses a dedicated TLS PostgreSQL role. Auth session refresh and Obsidian SecretStorage remain; device identities are local diagnostic/idempotency labels, not access grants. The installer retains pinned official Docker assets, resumable setup, connection profiles, and backup tooling.

## Replace the database

The encrypted baseline is replaced with a protocol-3 baseline: plaintext vaults/files, append-only revisions, a changes view, mutation receipts, installation settings, and verified binary metadata. Private helpers implement authorization, transactional journal triggers, and temporary Storage transfer capabilities. No ownership, memberships, enrolled devices, encrypted indexes, or recovery envelopes remain. One configured Auth UID authorizes the plugin. Hermes has guarded DML/read permissions without superuser, schema ownership, or history mutation privileges.

## Preserve sync correctness

Stable entry UUIDs, exact base revisions, operation-ID receipts, atomic file/history/journal updates, folder-tree revision checks, durable payload-before-network outboxes, separate received/applied cursors, crash recovery, immutable verified blobs, and conflict copies survive. A transaction-wide write lock makes journal order safe for committed cursors. Direct SQL uses prepare_mutation plus a matching update, or mutate; bypass attempts fail in database triggers. Missing local listings never imply deletion. Realtime is not required.

## Tests

Removed E2EE, pairing, daemon, and unrelated-user isolation tests. Replaced them with actual PostgreSQL role/trigger/rollback/concurrent-commit tests, two-client PostgREST reconciliation, Auth/SecretStorage plugin tests, durable IndexedDB restart tests, binary failure checks, and disposable full-stack setup/backup tests. Pure path, merge, exclusion, hash, and protocol tests remain. See TESTING.md and CHECKLIST.md for executed versus device-only checks.

## Existing v2 databases

The existing v2 data is testing-only, so no decryption/import compatibility layer is retained. Setup rejects old installation state and never resets old databases or vaults. Use a fresh installation directory and ports. Protocol version and epoch checks prevent old queues from being silently replayed against the new backend. Existing test volumes remain separate from normal setup.

## Implementation order

1. Inventory old components and record the single-owner boundary.
2. Introduce and test the plaintext schema and guarded writer contract.
3. Replace protocol/client adapters while retaining the tested reconciliation core.
4. Simplify plugin authentication/settings and switch Hermes to direct SQL.
5. Replace setup provisioning and separate explicit development commands.
6. Delete obsolete components, rewrite operational docs, and verify builds/tests.
7. Exercise the packaged installer, Storage round trip, and fresh backup restoration in disposable installations. Real desktop/mobile/private-network checks remain explicit manual gates.
