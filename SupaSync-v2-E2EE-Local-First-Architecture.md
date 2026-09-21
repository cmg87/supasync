# SupaSync v2 — E2EE, Local-First Installer, Daemon, and Deployment Architecture

> Historical, superseded development architecture. Do not implement its E2EE, tenancy, enrollment, or daemon requirements. See docs/ARCHITECTURE.md for the current plaintext design.

**Revision:** 2.0  
**Prepared:** September 19, 2026  
**Repository:** https://github.com/cmg87/supasync  
**Status:** Build specification for the next architecture revision  
**Primary audience:** Coding agent implementing the changes end to end

---

## 0. Executive directive

Refactor SupaSync now, while the project is still young, around three product decisions:

1. **End-to-end encryption is a core invariant, not a future mode.**
2. **Local/self-hosted setup must become wizard-driven and nearly one-click.**
3. **SupaSync must ship as an installable npm CLI/package with an optional always-on daemon.**

The current sync correctness work is valuable and should be preserved: stable entry IDs, explicit base revisions, ordered revision history, idempotent mutation receipts, persistent outbox/inbox state, conflict preservation, restart recovery, snapshots, mobile compatibility, and one protocol shared by Obsidian and headless clients.

The parts that should change are the trust model, local deployment experience, and runtime lifecycle.

### v2 fixed decisions

- Plaintext note content must no longer be stored in Supabase.
- Plaintext filenames/paths must no longer be stored in Supabase.
- Supabase Auth remains the authorization/account layer.
- Supabase Postgres remains the authoritative ordered synchronization journal and metadata authority.
- Supabase Storage is the only attachment/object-storage interface SupaSync itself supports.
- **Direct Cloudflare R2 support is removed.**
- No SupaSync R2 credentials, R2 signing code, provider selector, R2 migrations, or R2-specific tests remain.
- If a self-hosted Supabase operator chooses a different physical backend underneath Supabase Storage, that is an infrastructure detail below SupaSync and not a SupaSync storage provider.
- The local “production-like” path uses the official self-hosted Supabase Docker deployment, not `supabase start`.
- `supabase start` remains a developer/test command only.
- Self-hosted Supabase’s built-in API gateway is used rather than inventing another general-purpose gateway.
- Tailscale is an optional but first-class wizard path for private remote access to a local SupaSync server.
- Edge Functions must not require a terminal to remain open in a normal local install.
- An optional per-user `supasyncd` daemon provides always-on desktop/headless vault synchronization and local orchestration.
- The Obsidian plugin must still work without the daemon, especially on Android and iOS.
- Hermes/headless/agent access continues to use the same protocol and conflict rules as Obsidian.
- Future managed Supabase, VPS, and SupaSync Cloud deployment must remain possible without rewriting the synchronization engine.

---


# 0.5 Current repository baseline and direct refactor map

This specification was prepared against the current `cmg87/supasync` repository, not from a hypothetical greenfield design.

The implementing agent should start by inspecting these current paths and changing them rather than creating parallel replacements unnecessarily.

## Current behavior worth preserving

### `packages/sync-core/src/engine/sync-engine.ts`

Already contains the core shape worth keeping:

- pull → reconcile → push → pull cycle;
- persistent manifest/outbox concepts;
- explicit base revisions;
- bootstrap snapshots;
- local/remote conflict detection;
- client-side three-way Markdown merge;
- conflict-copy preservation;
- attachment upload/download integration;
- separate remote sequence tracking.

Refactor the data it transports; do not replace this with a completely unrelated synchronization engine.

### `apps/obsidian/src/main.ts`

Currently:

- owns the sync engine in-process;
- listens to create/modify/delete/rename events;
- performs debounced automatic sync;
- polls while visible;
- stores scoped installation/vault state;
- uses Obsidian `SecretStorage` for Auth sessions;
- supports account creation/sign-in and automatic remote-vault selection.

Preserve these onboarding fixes.

Add daemon delegation and E2EE key state rather than returning to manual UUID/auth setup.

### `packages/client`

Currently provides:

- password Auth;
- public-key validation;
- client API;
- onboarding/vault selection.

Keep authentication transport separate from encryption keys.

### `scripts/dev-backend.mjs`

Currently runs:

```text
supabase start
then
supabase functions serve
```

Keep this script for development, but do not use it as the normal installed local runtime.

The npm wizard should provision the persistent self-hosted Docker deployment instead.

### `supabase/functions/supasync-api/index.ts`

Currently:

- verifies Supabase user sessions;
- prepares plaintext path/hash fields;
- invokes privileged transactional RPCs;
- signs Supabase Storage transfers;
- contains direct R2 signing/get/put support.

Required refactor:

- remove all direct R2 code;
- stop receiving/recomputing plaintext names and plaintext content hashes;
- accept/validate v2 encrypted metadata and ciphertext-object references;
- retain auth verification, membership enforcement, idempotency, transaction RPC calls, and Storage authorization.

### Current database migrations

The current schema was designed around plaintext Markdown bodies and server-readable paths.

Do not add E2EE by merely encrypting one text column.

The schema needs a coherent v2 change covering:

- encrypted names;
- opaque name tokens;
- encrypted content objects;
- crypto/key versions;
- device/key envelopes;
- encrypted revision snapshots.

### `apps/cli/src/cli.ts`

Currently functions as a thin manual config/auth/headless-sync utility.

Evolve this codebase into the publishable `supasync` product CLI and wizard instead of building a completely disconnected installer.

### Current docs

The existing README/architecture/security/deployment docs explicitly describe:

- readable Markdown in Postgres;
- direct R2 as an optional provider;
- manual local development startup;
- no E2EE in v1.

Update all of them after the v2 implementation so there is one architectural truth.

---

# 1. Product definition

SupaSync synchronizes ordinary Obsidian vaults across devices while keeping every device’s vault as normal local files.

The server is an ordered synchronization authority, not a mounted filesystem and not a plaintext notes database.

```text
Desktop Obsidian / Mobile Obsidian / CLI / Hermes
                     |
             shared sync-core
                     |
          client-side E2EE layer
                     |
          authenticated SupaSync API
                     |
             Supabase gateway
                     |
       +-------------+--------------+
       |             |              |
    Auth         Postgres        Storage
                  journal       ciphertext
```

The server may determine:

- whether a user is authorized for a vault;
- whether a base revision is stale;
- whether an operation is a duplicate;
- whether an opaque sibling-name token collides;
- the total order of accepted revisions;
- whether a ciphertext object exists and is complete;
- client progress and retention state.

The server must not need to know:

- Markdown content;
- frontmatter;
- note titles;
- filenames;
- folder names;
- attachment names;
- conflict-copy names;
- plaintext content hashes;
- the vault encryption key.

---

# 2. Why keep Supabase instead of switching to CouchDB

CouchDB remains an excellent fit for replication-first applications and is a major reason Self-hosted LiveSync can offer a natural replication model.

SupaSync should still remain on Supabase because the desired product is broader than database replication:

- Supabase Auth provides account/session infrastructure.
- Postgres gives SupaSync a transactional ordered revision journal.
- RLS and explicit RPC authorization support multiple users/vaults.
- Supabase Storage gives one supported object API for attachments.
- Realtime can remain a wake-up hint.
- Self-hosted Supabase includes one API gateway in front of Auth, PostgREST, Realtime, Storage, and Edge Functions.
- The same platform can run locally, on a VPS, or on managed Supabase.
- The CLI/Hermes layer can use the same explicit sync protocol instead of writing raw replication documents.
- Future SupaSync Cloud can provision the same backend model while E2EE prevents the cloud operator from reading vault contents.

E2EE removes one previous advantage of plaintext Postgres—server-side content queries—but the rest of the Supabase platform still fits the desired product and deployment flexibility.

---

# 3. Goals and non-goals

## 3.1 Goals

v2 must provide:

- bidirectional note and attachment sync;
- desktop, Android, and iOS plugin support;
- client-side E2EE for note content, filenames, folder names, and attachment bytes;
- encrypted revision history;
- deterministic conflict preservation;
- offline edits;
- crash-safe persistent queues;
- idempotent retries;
- mobile foreground/resume sync;
- automatic desktop sync;
- optional always-on desktop sync while Obsidian is closed;
- one-command/npm onboarding;
- local Docker self-hosting;
- Tailscale-assisted phone access;
- existing Supabase / VPS deployment;
- a clean future path to SupaSync Cloud;
- CLI/Hermes/headless access;
- recovery key and device enrollment;
- self-diagnostics and repair;
- versioned migrations and safe updates.

## 3.2 Non-goals

Do not turn this revision into:

- a CRDT editor;
- Google Docs-style simultaneous character collaboration;
- a new notes editor;
- a password manager;
- a custom VPN;
- a replacement for Supabase Auth;
- a custom Postgres database;
- a second generic API gateway when Supabase already provides one;
- an R2 abstraction;
- a generic S3 provider framework;
- a server-side semantic search system over decrypted notes.

Server-side AI/search over plaintext is intentionally incompatible with the E2EE trust boundary. Authorized agents can decrypt locally.

---

# 4. Repository direction

Preserve the existing monorepo separation and add explicit crypto, installer, and daemon layers.

Target layout:

```text
supasync/
  apps/
    obsidian/
    cli/
    daemon/
  packages/
    protocol/
    crypto/
    client/
    sync-core/
    installer/
    daemon-client/
  supabase/
    migrations/
    functions/
      supasync-api/
      supasync-maintenance/
    tests/
  scripts/
  docs/
```

## 4.1 Existing package responsibilities to preserve

### `packages/protocol`

Browser-compatible only.

Own:

- protocol versions;
- crypto envelope schemas;
- operation envelopes;
- errors;
- cursor serialization;
- stable IDs;
- path/name canonicalization rules used before encryption;
- wire types.

No Obsidian, Node filesystem, service-role, Docker, or Tailscale imports.

### `packages/sync-core`

Own:

- scan/capture;
- bootstrap;
- pull/push;
- conflict handling;
- three-way Markdown merge;
- restart recovery;
- outbox/inbox;
- apply intents;
- reconciliation;
- fairness and retry behavior.

No direct Obsidian APIs and no direct Node filesystem calls.

### `packages/client`

Own:

- authenticated SupaSync API transport;
- Supabase session handling;
- capability negotiation;
- blob transfer API;
- retry/error mapping.

### `packages/crypto` — new

Own all E2EE behavior.

It must be usable from:

- Obsidian desktop;
- Obsidian mobile;
- Node CLI;
- daemon;
- tests.

### `apps/obsidian`

Own only Obsidian integration/UI.

On mobile and daemonless desktop, it may run `sync-core` directly.

On desktop with a configured daemon, it may delegate synchronization to `supasyncd` and act as the UI/control surface.

### `apps/cli`

This becomes the user-facing install and administration program.

Target UX:

```bash
npx supasync
npx supasync setup
supasync doctor
supasync status
supasync sync
```

### `apps/daemon` — new

Long-running per-user service for optional desktop/headless synchronization and local orchestration.

---

# 5. NPM packaging

The repository root may remain private as a workspace root.

Publish a dedicated package that exposes the `supasync` executable.

The desired user experience is:

```bash
npx supasync setup
```

and, for persistent installation:

```bash
npm install -g supasync
supasync setup
```

If the unscoped npm name is unavailable, keep the binary name `supasync` even if the package must be scoped.

## 5.1 Package requirements

The published npm package must:

- contain compiled runtime code only;
- use a strict `files` whitelist;
- include its license;
- include a `bin` entry for `supasync`;
- not include test vaults, secrets, `.env` files, service-role keys, or local state;
- not perform privileged system modifications in npm lifecycle hooks;
- perform Docker/Tailscale/service installation only after the user explicitly runs the wizard;
- pin dependencies with a lockfile;
- expose `--version`;
- support noninteractive/CI flags where practical.

## 5.2 Optional bootstrap scripts

Provide small audited bootstrap entrypoints:

```bash
curl -fsSL https://supasync.dev/install.sh | sh
```

and PowerShell equivalent.

The bootstrap script should stay intentionally small. Its job is to:

1. identify the platform;
2. verify or install/locate an acceptable Node runtime when the user approves;
3. install or execute the pinned SupaSync npm package;
4. launch `supasync setup`.

Do not duplicate the installer logic in Bash/PowerShell. The TypeScript CLI is the source of truth.

---

# 6. Setup wizard

The wizard is a product feature, not a convenience script.

Run:

```bash
supasync setup
```

or simply:

```bash
npx supasync
```

for first-run interactive setup.

## 6.1 First screen

```text
SupaSync Setup

How do you want to run SupaSync?

> Local + Tailscale
  Local only
  Existing Supabase / VPS
  Managed Supabase
  Developer mode
```

Future SupaSync Cloud can become another provider without changing the sync protocol.

## 6.2 Environment discovery

Before asking unnecessary questions, detect:

- OS and architecture;
- Node version;
- npm/pnpm/bun availability;
- Docker;
- Docker Compose;
- existing Supabase CLI;
- Tailscale;
- Tailscale login state;
- Tailscale DNS/hostname;
- open/occupied required ports;
- Obsidian installation;
- Obsidian configuration directories;
- known Obsidian vaults;
- existing SupaSync plugin installs;
- existing SupaSync local backend;
- existing SupaSync daemon;
- current SupaSync schema version;
- current protocol version;
- current crypto version.

Example:

```text
Environment

✓ Obsidian detected
✓ 3 vaults found
✓ Docker 28.x
✓ Docker Compose
✓ Tailscale connected
✗ SupaSync backend
✗ SupaSync daemon
```

## 6.3 Idempotent task model

Every wizard action must be an idempotent task.

Examples:

```text
ensureDocker()
ensureSelfHostedSupabase()
ensureSupaSyncSchema()
ensureSupaSyncFunctions()
ensureTailscale()
ensureTailscaleServe()
ensureDaemon()
ensureObsidianPlugin()
ensureVaultRegistration()
ensureEncryption()
testRoundTrip()
```

A rerun must inspect current state and repair/skip rather than blindly reinstall.

Persist a machine-level installer state manifest outside the vault.

The manifest records:

- SupaSync version;
- selected deployment mode;
- installed Supabase release;
- compose directory;
- public endpoint;
- service state;
- selected local vaults;
- daemon ownership;
- schema/protocol/crypto versions.

It must not contain vault master keys, recovery secrets, account passwords, or service-role secrets.

## 6.4 Wizard safety

The installer must:

- show what it is about to modify;
- prompt before privileged installation;
- never silently delete Docker volumes;
- never reset an existing database without explicit destructive confirmation;
- never modify a personal vault until the user selects it;
- support `--dry-run`;
- support resume after interruption;
- redact secrets from logs;
- write a troubleshooting log that is safe to share after redaction.

---

# 7. Local self-hosted backend

The current development workflow:

```bash
supabase start
supabase functions serve
```

must remain a development/test workflow only.

Normal local installation should use the official self-hosted Supabase Docker architecture.

## 7.1 Why

The local Supabase CLI stack is for development and is not the intended externally reachable deployment.

The self-hosted Docker stack provides persistent services including:

- Postgres;
- Auth;
- Storage;
- Realtime;
- API gateway;
- Edge Runtime.

A normal user should never need to keep a terminal open.

## 7.2 Pin the backend release

The installer must pin a tested Supabase self-host release.

Do not clone `latest` forever and hope.

Store the installed Supabase release in installer state.

Provide:

```bash
supasync backend status
supasync backend update --dry-run
supasync backend update
```

Update procedure:

1. verify current health;
2. create/verify backup;
3. preview upstream config changes;
4. apply supported update;
5. run SupaSync migrations;
6. recreate/restart required containers;
7. run health checks;
8. run a test sync transaction.

## 7.3 Minimize services where practical

SupaSync needs:

- Postgres;
- Auth;
- Storage;
- API gateway;
- Edge Functions if the API remains an Edge Function;
- Realtime if enabled.

Studio is useful but not required for normal operation.

Analytics/image transformation/etc. should not become mandatory just because the full default stack includes them.

Do not prematurely hand-maintain a heavily forked Supabase Compose file. Prefer a pinned official self-host release plus a small SupaSync overlay/configuration.

---

# 8. Supabase gateway and Tailscale

Do **not** build a second generic network gateway for v2.

Self-hosted Supabase already provides an API gateway that fronts its services.

The desired local topology is:

```text
Phone / laptop
     |
 Tailscale
     |
 private HTTPS hostname
     |
 Tailscale Serve
     |
 127.0.0.1:<Supabase gateway port>
     |
 Supabase API gateway
     |
 Auth / Functions / Realtime / Storage / PostgREST
```

The Supabase gateway should remain bound so that it is not accidentally exposed directly to the public internet.

Tailscale Serve supplies the private remote HTTPS path.

## 8.1 Wizard flow

If Tailscale is not installed:

```text
Remote phone access

Tailscale is not installed.

> Install Tailscale
  Continue with local-only access
```

If installed but not authenticated:

```text
Tailscale is installed but not connected.

> Connect Tailscale account
  Skip for now
```

The wizard may launch the normal Tailscale authentication flow.

After connection:

1. determine the stable tailnet hostname;
2. configure Tailscale Serve;
3. configure Supabase external/public URL settings consistently;
4. verify Auth;
5. verify SupaSync API;
6. verify Storage upload/download;
7. print or display the mobile connection profile.

## 8.2 Do not use Funnel by default

The local-first default is private tailnet access.

Public internet exposure is a separate advanced deployment mode.

## 8.3 Connection profile

Generate an importable profile or QR containing only non-secret connection information and an optional short-lived pairing reference.

Example logical content:

```json
{
  "version": 1,
  "serverUrl": "https://desktop.example-tailnet.ts.net",
  "vaultId": "opaque-id",
  "deployment": "local-tailnet"
}
```

Do not put:

- service-role keys;
- vault master keys;
- recovery keys;
- long-lived privileged enrollment tokens

inside an ordinary connection QR.

---

# 9. Always-on daemon

Create `supasyncd`.

The daemon is **not** a replacement for the Supabase API gateway.

Its primary jobs are:

- run headless sync for selected desktop vaults;
- keep those vaults syncing when Obsidian is closed;
- watch filesystem changes as a wake-up hint;
- run periodic reconciliation scans;
- expose local status to the CLI/plugin;
- schedule local maintenance tasks;
- report backend health;
- coordinate desktop ownership so the plugin and daemon do not become competing sync engines.

## 9.1 Service model

Prefer a per-user service on desktop:

- Linux: systemd user service;
- macOS: LaunchAgent;
- Windows: per-user service/task mechanism appropriate to the runtime.

For a headless Linux server, a system service is acceptable.

Commands:

```bash
supasync service install
supasync service start
supasync service stop
supasync service restart
supasync service uninstall
supasync service logs
```

## 9.2 Vault ownership

Exactly one process should own synchronization state for one local vault at a time.

Recommended behavior:

### Desktop with daemon enabled

```text
Obsidian plugin
    |
 local daemon client
    |
 supasyncd
    |
 sync-core
    |
 local vault
```

The plugin is UI/control and can trigger sync/status, but the daemon owns the persistent sync engine.

### Desktop without daemon

The Obsidian plugin runs `sync-core` itself, as it does today.

### Mobile

The Obsidian plugin runs `sync-core` in-process.

## 9.3 Locking

Use a machine-local lock keyed by canonical absolute vault path and remote vault identity.

Do not rely on an ignored file inside the user’s notes as the only lock.

If the daemon owns a vault, the plugin must detect that and delegate instead of opening a second state database.

If ownership changes, shut down one engine cleanly before the other starts.

## 9.4 Watchers are hints

Filesystem watchers improve latency but are not sync authority.

The daemon must periodically rescan and reconcile because watch events can be dropped.

Likewise, Realtime notifications remain hints.

Correctness must still converge through the ordered journal and explicit scans.

---

# 10. E2EE threat model

E2EE is now a non-negotiable product property.

## 10.1 Protect against

Assume an attacker may obtain:

- a database dump;
- a Supabase Storage dump;
- server backups;
- server logs;
- object-store files;
- service-role credentials after data was already stored;
- operator access to the self-hosted or managed backend.

Those parties must not be able to read note content or filenames without an authorized endpoint’s encryption material.

## 10.2 E2EE does not protect against

Do not claim protection from:

- a compromised unlocked endpoint;
- malicious code running inside Obsidian;
- malware reading the local plaintext vault;
- a user intentionally exporting plaintext;
- screen/keyboard capture;
- an already-authorized member who previously received the key.

## 10.3 Metadata leakage accepted in v2

The server may still observe:

- account identity;
- vault membership;
- device/client IDs;
- revision counts and ordering;
- entry IDs;
- parent/child graph shape;
- file/folder kind unless later hidden;
- ciphertext sizes;
- timing;
- deletion events;
- opaque deterministic sibling-name tokens.

This leakage must be documented honestly.

---

# 11. Cryptographic design

Do not invent cryptographic primitives.

Use a well-reviewed library that works in browser/mobile and Node environments.

Preferred primitive set:

- XChaCha20-Poly1305 for authenticated encryption;
- HKDF-SHA-256 for subkey derivation;
- HMAC-SHA-256 for opaque deterministic name tokens;
- X25519/sealed-box style device key wrapping where practical;
- cryptographically secure random bytes from the platform.

`libsodium`/`libsodium.js` is a strong candidate because it provides these primitives cross-platform. If it proves incompatible with Obsidian mobile bundle/runtime requirements, choose another established library with equivalent audited primitives rather than implementing crypto manually.

## 11.1 Version everything

Define:

```text
protocol_version = 2
crypto_version = 1
key_version = 1
path_canon_version = existing-version-or-next-explicit-version
```

Never silently change crypto format or path canonicalization because a dependency changed.

---

# 12. Vault key hierarchy

Each remote vault gets a random 256-bit Vault Master Key (`VMK`).

The VMK is generated on a trusted client.

The server never receives the plaintext VMK.

Derive independent subkeys using HKDF and fixed domain-separated context strings.

Example logical hierarchy:

```text
Vault Master Key
  |
  +-- content encryption key
  +-- name encryption key
  +-- name token/index key
  +-- attachment encryption key
  +-- key-envelope/recovery context
```

Exact labels are protocol constants.

## 12.1 Account password is not the vault key

Do not derive the VMK directly from the Supabase account password.

Reasons:

- account password changes should not require re-encrypting the vault;
- server authentication and data encryption should remain separate;
- an Auth compromise should not automatically reveal vault plaintext.

## 12.2 Local key caching

Authorized clients may cache the unlocked vault key locally.

### Obsidian

Use Obsidian `SecretStorage` for the local wrapping material / wrapped VMK.

Do not store the plaintext VMK in ordinary plugin settings.

### CLI / daemon

Prefer OS credential storage where available.

If a cross-platform secure credential API cannot be used initially, use a locked-down user-only file as an explicit fallback and report that in `doctor`.

Never put vault keys in:

- the vault itself;
- `.env`;
- logs;
- diagnostics;
- Git;
- Supabase rows in plaintext.

---

# 13. Recovery model

Every vault must have a recovery mechanism before E2EE is considered complete.

Generate a high-entropy random recovery secret.

The recovery secret protects a recovery envelope containing the VMK.

The server may store the **encrypted recovery envelope**, but never the recovery secret.

The user is shown:

- a human-readable recovery key;
- a QR representation;
- a clear warning that losing every authorized device and the recovery key means the encrypted vault cannot be decrypted.

Use a versioned encoding with checksum.

Do not default to a weak human password as the cryptographic root.

Optional passphrase-based recovery can be added later using a memory-hard KDF such as Argon2id.

---

# 14. Device enrollment and pairing

A new device must not receive the VMK merely because it knows the user’s account password.

Authentication proves account identity.

A separate key-enrollment step authorizes decryption.

Support two enrollment paths.

## 14.1 Recovery-key enrollment

1. User signs into SupaSync.
2. Device fetches vault metadata and encrypted recovery envelope.
3. User enters/scans the recovery key.
4. Client decrypts the VMK.
5. Client creates its own local device key material.
6. Client stores a device-specific wrapped copy locally and, if needed, registers a public key/envelope remotely.

## 14.2 Existing-device approval

Preferred everyday UX:

1. New device signs in.
2. New device generates an ephemeral/device public key.
3. Server creates a short-lived pairing session.
4. Existing authorized device displays or scans a QR/pair code.
5. Existing device encrypts/wraps the VMK for the new device.
6. Server stores only the encrypted key envelope.
7. New device decrypts locally.
8. Pairing token expires and cannot be reused.

The server must not be able to convert the envelope back into the VMK.

---

# 15. Encrypted names and paths

Do not store plaintext full paths in Postgres.

A better v2 model is a tree of stable entry IDs.

Each entry stores:

- `entry_id`;
- `parent_entry_id`;
- encrypted basename;
- basename nonce;
- opaque name token;
- kind;
- current revision;
- tombstone state.

The client reconstructs full paths.

## 15.1 Name token

Canonicalize the basename client-side using the versioned portable-name rules.

Generate an opaque deterministic token such as:

```text
HMAC(name_index_key, parent_entry_id || canonical_basename)
```

The server uses:

```text
(vault_id, parent_entry_id, name_token)
```

for live sibling uniqueness.

This allows collision detection without storing the basename.

Including the parent ID in the token prevents the server from trivially learning that the same filename appears in multiple folders.

## 15.2 Rename/move benefit

Because paths are represented by parent relationships plus encrypted basenames, moving a folder does not require the server to rewrite every descendant plaintext path.

Stable entry IDs survive rename/move exactly as required by the existing sync model.

---

# 16. Encrypted content model

The current `text_bodies` plaintext design must be replaced.

Use immutable encrypted content objects.

Logical record:

```text
content_object
  object_id
  vault_id
  object_type
  crypto_version
  key_version
  nonce / encryption header
  ciphertext or storage reference
  ciphertext_sha256
  ciphertext_length
  created_at
```

## 16.1 Markdown

Markdown is encrypted client-side before upload.

The server stores ciphertext.

The server does not:

- parse YAML;
- hash plaintext;
- merge plaintext;
- index plaintext;
- generate summaries;
- inspect note contents.

Three-way merge remains client-side after decryption, which is already consistent with the current sync-core direction.

## 16.2 Attachments

Attachment bytes are encrypted client-side.

Only encrypted bytes are sent to Supabase Storage.

SupaSync speaks to Supabase Storage only.

Remove:

- `provider = r2`;
- R2 signing;
- R2 credentials;
- R2 upload/download code;
- R2 provider migration;
- R2 backend selection UI;
- R2 smoke tests.

## 16.3 Ciphertext integrity

AEAD authenticates decrypted content.

The server may additionally track a SHA-256 hash of the ciphertext bytes to validate transport/storage integrity.

Do not send a raw plaintext SHA-256 to the server merely for deduplication.

A plaintext SHA can leak equality and enable known-content guesses.

No-op detection can remain local.

---

# 17. Large attachment encryption

Design the crypto API so attachments can eventually be encrypted in chunks/streams.

The wire format must be versioned.

Initial Obsidian APIs may force full-file buffering for some operations, but do not bake “one giant in-memory AEAD buffer forever” into the crypto abstraction.

Expose an interface capable of:

```text
encryptChunk()
decryptChunk()
finalizeObject()
```

or an equivalent stream-oriented design.

The CLI/daemon should use streaming where practical.

Mobile tests must enforce bounded memory and realistic attachment limits.

---

# 18. Auth and E2EE separation

Supabase Auth still determines who may reach vault records.

E2EE determines who can understand the records.

These are separate layers.

A stolen/compromised Auth session without a device key or recovery key should not reveal plaintext vault content.

Likewise, possession of an old encryption key does not grant network access if server membership/session access has been revoked.

## 18.1 Revocation limitation

Revoking a device prevents future authenticated sync.

It cannot make a previously authorized device “forget” plaintext or a key it already possessed.

Document this limitation.

Future collaboration/member removal has the same cryptographic reality: strong post-revocation secrecy requires key rotation/re-encryption.

---

# 19. v2 remote data model

Replace plaintext-oriented fields with encrypted/opaque equivalents.

Suggested high-level relations:

## `vaults`

- id;
- owner;
- display label if server-visible by choice, otherwise encrypted;
- protocol version;
- crypto version;
- active key version;
- server epoch;
- head sequence;
- namespace sequence;
- replay floor;
- limits;
- retention policy.

## `vault_members`

Preserve owner/editor/reader authorization.

Do not store encryption keys in plaintext.

## `clients`

- client ID;
- generation;
- owner user;
- label/platform;
- last seen;
- acknowledged cursor;
- enrollment state;
- optional device public key.

## `vault_key_envelopes`

- vault;
- target device/user;
- key version;
- wrapping algorithm/version;
- ciphertext envelope;
- created/revoked metadata.

No plaintext VMK.

## `entries`

- stable entry UUID;
- vault;
- parent entry ID;
- encrypted basename;
- name nonce/header;
- name token;
- kind;
- current revision;
- deleted;
- conflict relationship fields if needed.

No plaintext path.

## `content_objects`

Immutable ciphertext records/references.

No `text_bodies` plaintext.

## `revisions`

- vault/sequence;
- entry;
- version;
- parent revision;
- parent entry snapshot;
- encrypted name snapshot;
- name token snapshot;
- content object reference;
- tombstone;
- actor/client/op IDs;
- server timestamp.

## `operation_receipts`

Preserve exact idempotency semantics.

The request digest is over the canonical ciphertext operation envelope.

## `snapshots`

Preserve stable bootstrap snapshots.

---

# 20. Server trust changes

The current gateway recomputes plaintext path keys and plaintext content hashes.

It can no longer do that.

v2 server validation should instead verify:

- authenticated actor;
- vault membership/role;
- protocol/crypto version;
- client generation;
- operation idempotency;
- expected base revision;
- stable entry relationships;
- opaque name-token uniqueness;
- content-object ownership/readiness;
- ciphertext size limits;
- allowed algorithms/versions;
- envelope field shape;
- revision ordering.

The client is responsible for plaintext semantic validation and canonicalization.

A malicious authorized client may create semantically strange encrypted data. The server cannot inspect what E2EE deliberately hides.

That is an accepted consequence of the trust model.

---

# 21. Sync protocol v2

Preserve the existing operation philosophy.

Every mutation still contains:

- protocol version;
- server epoch;
- vault ID;
- client ID;
- client generation;
- operation ID;
- operation type;
- entry ID where applicable;
- exact base revision where applicable;
- immutable encrypted payload.

The server still guarantees:

- duplicate operation ID + identical digest returns the original result;
- duplicate operation ID + different digest fails;
- stale base fails;
- accepted entry/revision/receipt changes are atomic;
- revisions have a total per-vault order.

## 21.1 Operations to keep/adapt

Keep equivalents of:

- capabilities;
- list/create vault;
- register client;
- snapshot begin/list;
- pull changes;
- commit;
- rename/move;
- delete;
- acknowledge applied cursor;
- attachment upload/download reservation;
- history;
- restore;
- conflict preservation/resolution.

Remove provider migration operations that exist only for direct R2/provider switching.

## 21.2 Rename tree simplification

Because the server no longer stores full plaintext descendant paths, folder move/rename can become primarily an update to:

- parent ID;
- encrypted basename;
- opaque name token;
- revision metadata.

Client path reconstruction handles descendants.

Any namespace concurrency rules still need explicit revision/base checks.

---

# 22. Realtime

Realtime remains a latency optimization only.

Wake-up payload:

```text
vault_id
head_seq
```

No plaintext metadata.

If every Realtime notification is dropped, polling/manual/daemon sync must still converge.

---

# 23. Obsidian plugin onboarding

The plugin should no longer make normal users manually paste backend internals when the wizard has provisioned the machine.

Support two onboarding paths.

## 23.1 Wizard-managed desktop

The npm wizard:

- installs/builds the plugin;
- writes safe non-secret connection settings;
- optionally registers the selected vault;
- configures daemon delegation;
- launches Obsidian or instructs the user to enable the plugin.

The plugin opens showing:

```text
SupaSync is ready
Backend: Local via Tailscale
Encryption: Locked / Unlocked
Vault: <local display name>
Daemon: Connected
```

## 23.2 Mobile / second device

Plugin provides:

```text
Connect to SupaSync

> Scan setup QR
  Enter server manually
```

Then:

1. connect;
2. sign in;
3. enroll E2EE key via recovery key or existing-device approval;
4. select/create remote vault if not encoded in pairing;
5. bootstrap.

No vault UUID hunting.

No Supabase Studio.

No service-role key.

No manual SQL.

---

# 24. Plugin settings cleanup

Normal settings should expose product concepts, not infrastructure implementation details.

User-facing settings:

- account;
- connected server;
- current vault;
- encryption status;
- device name;
- auto sync;
- daemon status on desktop;
- conflicts;
- diagnostics;
- recovery/device management;
- sign out/disconnect.

Move raw endpoint/public-key fields under an Advanced/manual connection section.

---

# 25. CLI commands

The CLI should evolve from a thin headless sync utility into the SupaSync administration surface.

Target command set:

```text
supasync setup
supasync doctor
supasync status

supasync plugin install
supasync plugin update

supasync backend status
supasync backend up
supasync backend down
supasync backend update
supasync backend logs

supasync tailscale setup
supasync tailscale status

supasync service install
supasync service start
supasync service stop
supasync service restart
supasync service logs

supasync vault list
supasync vault create
supasync vault attach
supasync vault detach
supasync vault sync

supasync device list
supasync device pair
supasync device revoke

supasync recovery show
supasync recovery verify

supasync backup create
supasync backup verify
supasync restore

supasync migrate
```

Some commands can be staged, but command grouping should be designed coherently now.

---

# 26. `supasync doctor`

`doctor` should be one of the strongest parts of the product.

Example:

```text
SupaSync Doctor

Runtime
✓ Node supported
✓ SupaSync CLI 0.x

Backend
✓ Docker running
✓ Supabase containers healthy
✓ API gateway reachable
✓ Auth reachable
✓ Storage reachable
✓ SupaSync API reachable
✓ schema v2
✓ protocol v2

Remote access
✓ Tailscale connected
✓ HTTPS Serve configured
✓ remote endpoint reachable

Encryption
✓ vault crypto v1
✓ local key material available
✓ recovery envelope present
✓ recovery key previously verified

Desktop
✓ Obsidian found
✓ plugin installed
✓ daemon running
✓ daemon owns this vault
✓ last sync 12s ago

No action required.
```

When repair is safe:

```text
Fix automatically? [Y/n]
```

Do not automatically perform destructive database reset/restore.

---

# 27. Edge Functions in local deployment

The current need to run:

```bash
supabase functions serve
```

in a terminal is a developer-workflow artifact.

In the normal self-hosted Docker installation, Supabase’s Edge Runtime should run continuously as a service/container.

The wizard should install/copy SupaSync Edge Functions into the self-hosted functions directory and restart/recreate the functions service when required.

Therefore:

- no terminal stays open;
- container restart policies handle normal service lifecycle;
- Tailscale points at the persistent Supabase gateway;
- the mobile plugin can reach Auth, Storage, and SupaSync API through the same server origin.

Keep `npm run dev:backend` for development only.

---

# 28. SupaSync daemon vs Edge Function responsibilities

Do not make two competing “brains.”

## Edge/API side

Own:

- authentication verification;
- server authorization;
- mutation validation;
- transaction RPC invocation;
- upload/download authorization;
- server-side idempotency;
- ordered journal;
- snapshots;
- server maintenance hooks.

## `supasyncd`

Own:

- local filesystem watch;
- local scan/reconcile;
- local key unlock/cache;
- local persistent sync engine;
- desktop always-on sync;
- local health/status;
- local scheduled calls;
- service lifecycle.

The daemon does not need the Supabase service-role key to sync like a user client.

Installer/backend-management code may need server secrets, but keep those isolated from the vault sync worker and plugin.

---

# 29. Hermes and agent integration under E2EE

E2EE means Hermes cannot obtain readable notes by querying raw Postgres rows.

That is intentional.

Hermes should still bypass Obsidian and operate directly against SupaSync through an authorized local/headless client.

Preferred options:

```text
Hermes
  |
 supasync CLI / SDK
  |
 local device key
  |
 decrypt/encrypt client-side
  |
 SupaSync protocol
```

or, when the daemon is present:

```text
Hermes
  |
 local supasyncd API / optional MCP wrapper
  |
 daemon-owned unlocked vault key
  |
 SupaSync protocol
```

Required headless capabilities remain:

- list vaults;
- list notes;
- read note;
- conditional write;
- create;
- delete;
- rename/move;
- history;
- restore;
- import/export;
- one-off directory sync.

Agent writes must use the same base-revision and conflict semantics as Obsidian.

Do not let Hermes bypass the journal with raw SQL updates.

---

# 30. Local decrypted agent API

A future local daemon endpoint can expose decrypted note operations to trusted local agents.

If implemented:

- bind to loopback by default;
- require explicit local authorization/token;
- do not expose it through Tailscale automatically;
- use the same protocol objects and conflict rules;
- never log note bodies by default.

This provides the convenient “AI can work directly on my vault backend” experience without breaking E2EE at the server.

---

# 31. Migration from the current plaintext v1 architecture

The repository is young enough that v2 should favor correctness over long-lived backwards compatibility.

Treat this as a protocol/schema break.

## 31.1 Recommended development migration

- bump protocol to v2;
- create new crypto-aware schema migrations;
- replace plaintext body/path structures;
- remove R2 fields and functions;
- recreate disposable local development databases;
- rebuild test fixtures around ciphertext.

Do not maintain two full production protocols indefinitely.

## 31.2 Optional one-way v1 importer

If useful, provide a one-way migration command:

```bash
supasync migrate v1-to-v2
```

It must:

1. authenticate;
2. read authorized plaintext v1 content;
3. create/unlock a v2 vault key;
4. encrypt everything client-side;
5. upload v2 objects;
6. verify counts/hashes locally;
7. switch only after verification;
8. preserve a backup until user confirms.

Do not run this silently.

If no real user data depends on v1 yet, a clean reset is preferable to spending large effort on legacy compatibility.

---

# 32. Remove Cloudflare R2 completely

The implementing agent must search the repository for:

```text
R2
r2
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_ENDPOINT
R2_BUCKET
storage_backends provider switching
start_storage_migration
migration_status
```

and remove R2-specific product behavior.

Update:

- README;
- architecture docs;
- deployment docs;
- security docs;
- environment examples;
- Edge Function code;
- migrations;
- protocol types;
- UI;
- tests;
- CLI;
- THIRD_PARTY_NOTICES if applicable.

Do not leave dead R2 credentials or a hidden provider selector.

SupaSync’s abstraction is now:

```text
SupaSync -> Supabase Storage API
```

not:

```text
SupaSync -> Supabase Storage OR R2
```

---

# 33. Backups and recovery

E2EE changes backup semantics.

A valid server backup contains ciphertext and sync metadata.

That backup is useless for plaintext recovery without an encryption recovery path.

Provide:

```bash
supasync backup create
supasync backup verify
```

Back up:

- Postgres data required for SupaSync;
- Supabase Storage ciphertext objects;
- schema version;
- protocol version;
- crypto version.

Do not back up plaintext vault content as part of the server backup.

Warn the user if a recovery envelope does not exist or recovery has never been verified.

A good setup wizard should ask the user to verify the recovery key once before declaring encryption setup complete.

---

# 34. Update strategy

There are several independently versioned components:

- npm CLI;
- daemon;
- Obsidian plugin;
- SupaSync schema;
- protocol;
- crypto format;
- self-hosted Supabase release.

`doctor` and `status` should report all of them.

Do not automatically perform a crypto format migration during a background package update.

Crypto migrations must be explicit, resumable, and testable.

---

# 35. Security rules

Non-negotiable:

1. No service-role key in Obsidian settings.
2. No VMK/recovery key in Supabase plaintext.
3. No account password persisted by the plugin/CLI.
4. No plaintext notes or filenames in server logs.
5. No raw tokens in diagnostics.
6. No direct client DML that bypasses mutation receipts/history.
7. No server claim that TLS/RLS equals E2EE.
8. No nonce reuse under the same AEAD key.
9. No unversioned ciphertext formats.
10. No cryptographic implementation written from scratch.
11. No recovery secret placed in an ordinary connection QR.
12. No silent downgrade from encrypted protocol v2 to plaintext protocol v1.

---

# 36. Diagnostics and observability

Diagnostics should show enough to troubleshoot sync without exposing user content.

Safe examples:

- server hostname;
- protocol/crypto versions;
- last applied sequence;
- pending queue counts;
- error codes;
- response status;
- object sizes;
- container health;
- daemon state;
- Tailscale state;
- plugin version.

Redact:

- access tokens;
- refresh tokens;
- service-role keys;
- recovery secrets;
- VMKs;
- device private keys;
- decrypted note text;
- decrypted filenames;
- signed URLs when they contain credentials.

---

# 37. Testing requirements

## 37.1 Existing sync correctness tests remain required

Preserve tests for:

- create/update/delete;
- rename/move;
- folder changes;
- offline edits;
- idempotent retry;
- stale base;
- conflict preservation;
- clean three-way merge;
- response lost after server commit;
- restart recovery;
- dropped Realtime;
- snapshot bootstrap;
- cursor boundaries;
- mobile lifecycle.

## 37.2 E2EE tests

Add deterministic test vectors for:

- key derivation;
- content encryption/decryption;
- name encryption/decryption;
- name-token derivation;
- wrong-key failure;
- modified-ciphertext failure;
- modified-AAD failure;
- key envelope wrap/unwrap;
- recovery envelope;
- device pairing envelope;
- version mismatch.

Verify nonce generation does not repeat in testable controlled fixtures.

## 37.3 Server plaintext audit

Build an integration test that:

1. creates notes with unique marker text;
2. creates uniquely named files/folders;
3. syncs them;
4. searches database rows, server logs, function logs, Storage object names, and object bytes for those markers;
5. fails if plaintext content or plaintext names are found where v2 says they must be encrypted.

This is a critical E2EE acceptance test.

## 37.4 Local installer tests

Test clean install and rerun on:

- Linux;
- macOS;
- Windows where supported.

Test:

- Docker already installed;
- Docker absent;
- Tailscale installed/logged in;
- Tailscale installed/logged out;
- Tailscale absent;
- port collision;
- existing backend;
- broken backend;
- interrupted wizard;
- rerun after partial completion;
- plugin already installed;
- multiple Obsidian vaults.

## 37.5 Reboot test

After setup:

1. reboot/log out and back in;
2. do not open a terminal;
3. verify backend services recover;
4. verify daemon starts;
5. edit a watched desktop vault;
6. verify change reaches remote;
7. open phone;
8. verify phone receives it.

## 37.6 Mobile test

Real Android/iOS tests must verify:

- connection through Tailscale;
- signup/login;
- recovery enrollment;
- existing-device pairing where implemented;
- bootstrap;
- edit/pull/push;
- attachment;
- suspend/resume;
- network loss;
- auth refresh;
- bounded memory.

Do not infer mobile support from desktop emulation.

---

# 38. Performance requirements

E2EE must not turn every sync into a full-vault decrypt/rescan.

Maintain local manifest state with:

- plaintext local hash stored only locally;
- last remote revision;
- base hash/reference;
- entry ID;
- reconstructed path;
- local mtime/size as scan hints only.

Use event-driven wakeups plus periodic verification scans.

For large vault tests, record:

- bootstrap time;
- one-note edit latency;
- one-note edit bytes transferred;
- daemon idle CPU;
- daemon idle requests;
- plugin memory;
- mobile memory;
- encrypted attachment throughput.

---

# 39. Implementation stages

## Stage 0 — freeze and baseline

- branch/tag current working v1 state;
- run current tests;
- record current schema/protocol;
- document known working desktop flow;
- verify disposable-vault sync.

**Gate:** current behavior has a reproducible baseline before the refactor.

## Stage 1 — remove R2 and simplify storage

- remove direct R2 code/config/docs/tests;
- make Supabase Storage the only SupaSync storage interface;
- simplify schema/provider abstractions that exist only for multi-provider migration.

**Gate:** all attachment tests pass using Supabase Storage; repo-wide R2 search finds no active implementation.

## Stage 2 — crypto package and protocol v2

- create `packages/crypto`;
- implement versioned key hierarchy;
- implement name encryption/tokens;
- implement content encryption;
- implement recovery envelopes;
- implement test vectors;
- define v2 schemas.

**Gate:** crypto unit/property tests pass on Node and browser-compatible test targets.

## Stage 3 — E2EE database/API migration

- replace plaintext bodies;
- replace plaintext paths;
- add key envelopes/device metadata;
- change revisions;
- change snapshots;
- update mutation validation;
- update attachment flow for ciphertext.

**Gate:** server plaintext audit passes.

## Stage 4 — sync-core E2EE integration

- encrypt before persistent remote outbox transmission;
- decrypt after pull;
- reconstruct paths client-side;
- preserve local three-way merge;
- adapt conflicts;
- adapt restore/history.

**Gate:** multi-client convergence and conflict tests pass with server never seeing plaintext.

## Stage 5 — production-like local self-host installer

- add pinned self-hosted Supabase installation;
- apply SupaSync migrations;
- install functions into persistent Edge Runtime;
- configure gateway;
- verify Auth/API/Storage.

**Gate:** no `supabase functions serve` terminal is required after installation.

## Stage 6 — Tailscale wizard path

- detect/install/connect Tailscale;
- configure private HTTPS Serve;
- set correct externally reachable Supabase URL;
- generate mobile connection profile/QR;
- verify remote endpoint from a second device where available.

**Gate:** phone reaches the local backend through the generated endpoint.

## Stage 7 — daemon

- create `supasyncd`;
- create per-user service installer;
- implement vault ownership lock;
- implement filesystem watch + scan fallback;
- expose local status/control;
- integrate plugin delegation.

**Gate:** desktop vault syncs after Obsidian is closed and after reboot/login.

## Stage 8 — npm product wizard

- publishable CLI package;
- `npx supasync setup`;
- idempotent tasks;
- doctor/status/repair;
- plugin installation;
- clear logs/errors;
- optional bootstrap scripts.

**Gate:** a clean machine can move from “nothing installed” to a working local encrypted SupaSync backend with guided steps and no manual SQL/UUID/key copying.

## Stage 9 — device pairing and recovery UX

- recovery key display/verify;
- recovery enrollment;
- pairing sessions;
- existing-device approval;
- device revoke UI.

**Gate:** second device can be enrolled without server access to the VMK.

## Stage 10 — Hermes/headless

- update CLI/SDK to unlock E2EE keys locally;
- preserve conditional writes;
- add optional daemon/local agent API or MCP wrapper;
- update Hermes skill.

**Gate:** Hermes can read/edit encrypted vault content without Obsidian and without raw plaintext in Supabase.

## Stage 11 — release hardening

- backup/restore;
- backend update path;
- migration docs;
- Android/iOS validation;
- installer matrix;
- security review;
- final docs.

---

# 40. Definition of done

v2 is not done until all of the following are true:

- `npx supasync setup` works as the primary onboarding path.
- A local install does not require a terminal to stay open.
- Local self-hosting uses the proper Supabase Docker deployment rather than externally exposing the CLI dev stack.
- Tailscale setup is guided and phone access works.
- The Obsidian plugin still works on mobile without the daemon.
- Desktop can optionally sync through `supasyncd` while Obsidian is closed.
- Server database contains no plaintext note bodies.
- Server database contains no plaintext note/folder names.
- Supabase Storage contains ciphertext, not plaintext attachments.
- Server logs do not contain plaintext content/names.
- The server never receives the VMK or recovery secret in plaintext.
- Recovery has been implemented and tested.
- A second device can be enrolled.
- Existing sync correctness invariants still hold.
- Conflict work is never silently discarded.
- Realtime remains optional for correctness.
- R2 support is removed from active code and documentation.
- Hermes/headless uses the same sync semantics and decrypts client-side.
- `supasync doctor` can identify common broken local states.
- Restart/reboot recovery is tested.
- Actual Android/iOS tests are recorded.
- Installation and upgrade instructions match the shipped code.

---

# 41. Agent implementation instructions

The implementing agent should treat this document as the new architectural authority over the earlier plaintext/R2-oriented architecture plan where they conflict.

Do not throw away the existing correctness work simply because the trust model is changing.

Specifically preserve:

- stable entry identities;
- ordered per-vault revisions;
- explicit base revisions;
- operation receipts;
- crash-safe queues;
- separate received/applied cursors;
- deterministic conflict preservation;
- local ordinary vault files;
- shared protocol between plugin and headless clients.

Refactor the data flowing through those mechanisms from plaintext paths/content into E2EE envelopes.

Work incrementally and keep the repository runnable after each stage.

Run tests after each stage.

Do not claim E2EE until the server plaintext audit passes.

Do not claim one-click local setup until a fresh install has been tested from the actual npm package.

Do not silently defer recovery; encryption without recovery is not a shippable sync product.

Do not reintroduce R2-specific code.

Do not make raw Supabase writes from Hermes or the daemon that bypass the sync protocol.

---

# 42. Current upstream facts to verify during implementation

Supabase and Tailscale change frequently. Re-check their current documentation when implementing the installer rather than hard-coding historical commands.

As of this architecture revision:

- Self-hosted Supabase recommends Docker for self-hosting.
- The Supabase CLI local stack is development/test infrastructure and should not be treated as an externally exposed production deployment.
- Self-hosted Supabase uses an API gateway that routes its services.
- Current self-hosted Supabase uses Envoy as the default API gateway.
- Self-hosted Edge Functions can run continuously in the Docker deployment.
- Tailscale Serve can privately reverse-proxy a local HTTP service over the tailnet with HTTPS.

Useful current references:

- https://supabase.com/docs/guides/self-hosting
- https://supabase.com/docs/guides/self-hosting/docker
- https://supabase.com/docs/guides/self-hosting/self-hosted-envoy
- https://supabase.com/docs/guides/self-hosting/self-hosted-functions
- https://supabase.com/docs/guides/local-development
- https://tailscale.com/docs/features/tailscale-serve
- https://tailscale.com/docs/reference/tailscale-cli/serve
- https://tailscale.com/docs/reference/tailscale-cli/up

---

# 43. Final target experience

The desired product experience should eventually feel like this:

```text
$ npx supasync

SupaSync Setup

✓ Obsidian found
✓ Personal vault found
✓ Docker available
✓ Tailscale connected

Where should SupaSync run?

> This computer + Tailscale

Setting up...
✓ Supabase installed
✓ SupaSync schema installed
✓ SupaSync API installed
✓ Private HTTPS configured
✓ SupaSync daemon installed
✓ Obsidian plugin installed
✓ Vault created
✓ End-to-end encryption enabled
✓ Recovery key verified
✓ Test sync passed

SupaSync is ready.

Phone:
Open SupaSync → Scan QR
```

After that, the user should not need to know:

- which Docker container runs Auth;
- which port Postgres uses;
- how to start Edge Functions;
- what a vault UUID is;
- where to paste an anon key;
- how signed Storage URLs work;
- what the service-role key is;
- how to manually expose localhost.

Those remain implementation details.

That is the v2 product boundary.
