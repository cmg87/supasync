# Architecture

The v2 specification is `SupaSync-v2-E2EE-Local-First-Architecture.md`. The earlier architecture/build plan describes the v1 baseline and is historical.

- `packages/protocol`: browser-compatible paths, local models and ciphertext-only wire types.
- `packages/crypto`: authenticated encryption, key derivation, name tokens, recovery and device envelopes.
- `packages/client`: Auth, public-key checks, authenticated RPC transport and secret-store key lifecycle.
- `packages/sync-core`: durable queue, reconciliation, conflict preservation, snapshots and the encryption boundary. Its internal plaintext records never go directly to the v2 server.
- `apps/obsidian`: public Obsidian APIs, IndexedDB durability, SecretStorage, QR/recovery/pairing and optional loopback daemon delegation.
- `apps/cli`: bundled npm commands, filesystem adapter, exact-base headless operations and persistent state outside the vault.
- `apps/daemon`: foreground/background engine with per-vault locks, watchers plus periodic scans and authenticated loopback control.
- `packages/installer`: pinned official Docker deployment, profiles, plugin installation, service definitions and backup tools.
- `supabase`: private transactional schema, authenticated Edge API and Supabase Storage ciphertext bucket.

The daemon is optional. It runs client-side reconciliation and encryption, not server authorization. Edge Functions validate sessions, gate ciphertext operations and invoke transactions; they never receive vault keys. Supabase Storage is the only storage API used by SupaSync.
