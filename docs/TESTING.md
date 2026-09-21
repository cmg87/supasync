# Verification

```sh
npm run typecheck
npm test
npm run build
npm run test:database
npm run test:integration
node scripts/test-installation.mjs
npm run test:package
```

Local tests cover path canonicalization, hashes, merges, Auth sessions, durable attachment requests, IndexedDB restart recovery, incomplete scans, late edits, and installer settings. Database tests create disposable PostgreSQL 17 containers and remove them in finally blocks. HTTP integration adds disposable PostgREST and exercises the real SQL contract with two sync clients and direct Hermes edits. Those HTTP cases are explicitly skipped in the default unit run; `test:integration` runs them with the required services.

The installation smoke test creates temporary vaults and distinct official Supabase Compose projects. It checks repeated setup, multiple vault bindings, non-secret configuration, pgTAP authorization, certificate-verified Hermes access and rejection of non-TLS connections, real Auth/PostgREST, Storage bytes, and backup restoration into a second empty installation. It never opens a user's vault. Optional `SUPASYNC_SOURCE_CACHE` supplies a checkout of the exact pinned official source to avoid another clone. The runner removes its containers/volumes and successful test data. Failed test artifacts are reported for inspection; `SUPASYNC_KEEP_TEST_ARTIFACTS=1` also keeps successful artifacts.

The packaging check extracts the tarball outside the monorepo, starts the standalone CLI, checks required assets and absence of legacy/secret configuration files, and rejects Node runtime imports in the mobile-compatible plugin. It leaves `dist/supasync-0.3.0.tgz` as an installable artifact.

Before a production release, exercise these device checks with disposable vaults:

1. Desktop: install the built plugin, sign in, edit text and binary attachments, restart Obsidian, verify automatic session refresh and catch-up.
2. Android/iOS: import only the public connection profile, sign in, suspend/offline-edit/reconnect, and verify conflict copies and cursor catch-up.
3. Disable Realtime; repeat sync, rename, deletion, and restore using polling/manual sync.
4. Reach a private HTTPS endpoint from another device; reject untrusted certificates and public non-TLS endpoints.
5. Change notes through the dedicated PostgreSQL role while Obsidian is closed; reopen and confirm convergence.
6. Restore a backup into an isolated matching backend and verify exact text and binary bytes. Keep the original installation intact.

Compiled UI and simulated host tests are not evidence of real-device success. Record actual outcomes in CHECKLIST.md.
