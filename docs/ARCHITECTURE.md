# Architecture

SupaSync is one trusted installation with multiple named vaults, one Obsidian Auth administrator, and a trusted PostgreSQL role for Hermes. Vaults have no owners, members, invitations, or device access grants.

- `protocol`: browser-compatible paths, exact-byte hashes, mutation envelopes, decimal sequence values, and shared types.
- `sync-core`: reconciliation, persistent payload queues, conflict copies, apply intents, snapshots, and separate received/applied cursors. No filesystem or Obsidian imports.
- `client`: public-key validation, session lifecycle, PostgREST calls, and binary transfer requests.
- Obsidian: public vault/request APIs, IndexedDB durability, SecretStorage sessions, and a small settings screen.
- CLI: setup and administration plus direct PostgreSQL operations with a durable mutation outbox. No daemon or local mirror is required.
- Installer: pinned official Supabase Compose distribution, resumable provisioning, plugin configuration, TLS credentials, backup/restore.

Canonical `supasync.files` rows contain text or a reference to a verified immutable binary. `revisions` stores full historical states and is the journal. `changes` is a security-invoker projection, not a second journal. `mutation_receipts` guarantees identical retries. `settings` holds the one admin UID, protocol, installation epoch, and committed head. `blobs` and private transfer capabilities protect Storage finalization.

A transaction-scoped installation lock precedes row locks and journal allocation. Triggers validate prepared mutations and atomically maintain file state, hashes, history, and receipts. Raw guarded SQL and PostgREST mutations use the same behavior. Application roles cannot modify the journal or disable triggers.

Snapshots select the latest immutable state per file at a fixed journal ceiling. They need no persistent snapshot tables. History and blobs are retained indefinitely; automatic garbage collection is deliberately absent.

Only binary transfers use an Edge Function: it signs staging uploads, verifies bytes, writes immutable final objects, and marks them ready. Plaintext note synchronization goes directly through PostgREST. Hermes obtains blob-scoped capabilities through its DB connection without an Auth session.
