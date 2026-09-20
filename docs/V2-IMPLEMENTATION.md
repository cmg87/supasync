# V2 implementation and verification record

Work is on `codex/v2-e2ee-local-first`. The v1 baseline is tag `supasync-v1-baseline-20260919`, commit `05da3ec`. Its original checks passed 70 tests with one optional skip. No production Supabase project or personal Obsidian vault was modified. Existing local v1 database contents were retained; the plaintext dispatcher was retired.

## Implemented

- Mandatory client encryption for names, labels, Markdown and attachments; versioned crypto, independent recovery, device wrapping and sibling-name tokens.
- Ciphertext-only transactional protocol, exact-base checks, exact-operation receipts, immutable verified objects, private RLS tables, snapshots, history and revocation.
- Persisted ciphertext retries, durable received/applied checkpoints, conflicting-edit preservation, stable folder/file IDs through renames and concurrent disk-store serialization.
- Plugin Auth/recovery/pairing/QR/settings, history/restore and optional daemon delegation; no Node runtime imports in its browser bundle.
- Bundled npm CLI and daemon, pinned official Docker installer, separate Compose projects, loopback gateway, safe profiles, explicit plugin installation, resumable setup, doctor and backup/restore.
- Headless list/get/history and exact-base write/rename/delete/restore; persistent per-vault locks and authenticated loopback daemon control.
- Tailscale Serve integration and per-user service definitions. These are implemented but require the platform checks below.

## Evidence from September 19, 2026

- TypeScript typecheck and both production bundles pass.
- Vitest: **82 passed, one optional direct-RPC test skipped**. Tests include server pairing/consumption, revocation, actor isolation, stale bases, ciphertext retries, competing edits, folder moves, binary updates, recovery and concurrent store durability.
- pgTAP: **7 passed**, covering private schema/RLS and dispatcher authorization.
- Packed `supasync-0.2.0.tgz` installed independently of the workspace. Version/help, dry-run, actual official Docker setup and a second setup run passed on Linux. Dependency images were pulled from the pinned upstream release.
- Installed CLI: fixture account creation, recovery confirmation, two local folders exchanging encrypted Markdown and binary bytes passed. Reproduce against an explicitly disposable loopback installation with `node scripts/verify-installed.mjs /path/to/installed/supasync/dist/cli.js` and SUPASYNC_HOME set.
- Foreground daemon: unauthenticated loopback request rejected, concurrent one-shot sync ownership rejected, file sync, ownership release and second-client pull passed.
- Headless list/get/history and exact-base encrypted write passed against the installed backend.
- Backup creation and an isolated restore into another empty official Docker installation passed. After restoring, an authenticated client decrypted a note and binary file and their bytes matched the originals. The recovery/key material was supplied separately from the server backup.
- Private test markers were absent from scoped v2 database records, outgoing requests, uploaded ciphertext and Edge logs.

## Remaining release gates and limitations

This is a development implementation, **not completion of every production-release gate in the specification**.

- Actual Obsidian desktop UI/restart, Android, iOS, private Tailscale HTTPS across devices, and host reboot were not exercised. The environment had no signed-in Tailscale connection or mobile device. Follow TESTING.md.
- macOS LaunchAgent and Windows scheduled-task lifecycle need testing on those systems; Linux foreground daemon tests do not prove per-user startup after reboot.
- Objects use authenticated chunks but currently buffer the complete object. True bounded-memory streaming and large-vault/mobile performance work remains. Local capture limits are 2 MiB Markdown and 25 MiB attachments; the server limits ciphertext to 50 MiB.
- The optional plaintext-v1 server importer and automated cross-release backend upgrades are not implemented. The supported cutover copies an independently backed-up local plaintext vault into a separate v2 installation. Update reports the pinned version and refuses unsupported changes.
- CLI credentials currently use a disclosed user-only file fallback, not an OS keychain integration. The optional decrypted local agent HTTP API is not implemented; agents use the CLI and common protocol.
- Retention is preserve-all. Automatic garbage collection and key rotation are not implemented. Backup consistency relies on immutable ready objects being retained.
- Historical full-vault tree hydration and JSON file-state persistence need scale testing. Pairing/history UI code is compiled and its underlying API/crypto paths are tested, but its real-device UX is unverified.

The README, deployment, security, protocol, recovery and headless instructions describe the current implementation rather than assuming these remaining gates passed.
