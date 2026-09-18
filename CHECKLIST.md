# Implementation checklist

## Stage 0 — protocol skeleton

- [x] Package boundaries and strict TypeScript
- [x] Operation envelopes, typed errors, canonical paths, content hashes
- [x] Path canonicalization fixtures
- [x] `ARCHITECTURE.md` and `PROTOCOL.md`
- [ ] Plugin loads in a real Obsidian instance (bundle is produced; desktop load unverified here)

## Stage 1 — database and authorization

- [x] Schema, grants, RLS, service-only RPCs
- [x] Gateway JWT verification
- [x] Membership roles, client generations, ordered revisions, receipts, snapshots
- [x] Tests with two Auth users on the running local stack
- [x] Gate: outsider cannot read another vault; stale writes fail; duplicate ops are idempotent

## Stage 2 — sync core

- [x] Memory vault/store adapters
- [x] Outbox/inbox, bootstrap, pull/push, crash intents, merge, conflict copies
- [x] Three simulated clients converge or preserve explicit conflicts

## Stage 3 — attachments

- [x] Staged upload + sealed objects in RPCs and Edge gateway
- [x] R2 adapter on the same contract (unsigned until credentials exist)
- [ ] Local real-storage tests against `supabase start`
- [ ] R2 smoke recorded separately

## Stage 4 — Obsidian desktop

- [x] Vault events, editor `Vault.process`, wizard settings, status/conflict/history views, commands, release asset pipeline
- [ ] Two disposable vaults on a real Obsidian desktop

## Stage 5 — mobile and lifecycle

- [x] `isDesktopOnly: false`, secret store, requestUrl fetch adapter, bounded concurrency constants
- [ ] Android/iOS explicit result records

## Stage 6 — agents, recovery, release

- [x] CLI/Hermes example, restore RPC, runbooks, GC pass, diagnostics command
- [x] Installable artifacts after `npm run build`
