# SupaSync — Architecture and Build Plan

**Revision:** 1.0 · **Prepared:** September 18, 2026  
**Status:** Implementation specification, not an implemented or tested plugin.  
**Audience:** Codex, Cursor, or another coding agent implementing the project end to end.

## 1. Product definition and fixed decisions

Build an Obsidian community plugin called **SupaSync**, plugin ID `supasync`, for desktop, Android, and iOS. Each device continues to have a real, ordinary Obsidian vault. Supabase Postgres stores the shared Markdown content and authoritative synchronization history. Non-Markdown file bytes live in either Supabase Storage or Cloudflare R2, selected per remote vault.

| Data | Authoritative remote location | Device representation |
|---|---|---|
| Markdown, including frontmatter | Postgres `text_bodies`, referenced by current entries and immutable revisions | Ordinary `.md` files |
| Images, PDFs, audio, video, other non-Markdown files | Private Supabase Storage or private R2 bucket | Ordinary files at their original vault paths |
| `.canvas`, `.base`, and other non-Markdown formats | Object storage in v1; preserve exact bytes | Ordinary files; no format-specific merge |
| Paths, stable IDs, versions, tombstones, ordered changes | Postgres | Local transactional synchronization state |
| Unsynchronized edits and queued operations | Device vault plus persistent local outbox | Available offline |
| Provider credentials | Backend secret configuration | Never included in plugin configuration |

**Markdown is not duplicated to S3 as a second live authority.** Exporting or backing up Markdown as files is supported, but does not create a second synchronization source.

A local edit is valid before it reaches the server. Postgres orders accepted remote commits; it does not get to overwrite an uncommitted local edit without reconciliation. Obsidian remains usable offline. The plugin is a replica synchronizer, not a database-mounted filesystem.

Supabase Storage's S3, REST, and resumable interfaces access the same storage service; a plugin does not have to carry an S3 SDK just because its storage is S3-compatible. [S1]

### Required v1 scope

Deliver bidirectional Markdown and attachment synchronization; create/update/delete/rename, including folders; foreground automatic and manual sync; offline operation and restart recovery; conflict preservation and resolution; revision restore; selectable Supabase Storage/R2; bootstrap and repair workflows; a headless client usable by Hermes without an open Obsidian instance; installable desktop/mobile release assets; and actual integration tests.

Default deployment is one user's own Supabase project, with multiple vaults and devices. Include owner/editor/reader authorization in the model; a full invitation/sharing product is not required.

### Deliberately outside v1

Do not build Google Docs-style simultaneous character collaboration, a CRDT system, a custom database engine, arbitrary third-party cloud providers, a settings/plugin/theme synchronization system, AI embeddings, or a new notes editor. Do not promise execution while the mobile operating system has suspended Obsidian.

V1 stores readable Markdown in an access-controlled database so an authorized Hermes client can query it. End-to-end encryption is a separate future vault mode: it requires client-side decryption and changes server-side search/agent access. Do not label authentication, RLS, TLS, or provider-side encryption as E2EE.

## 2. Deployment architecture

```text
Obsidian desktop / Android / iOS
  ordinary vault files
       |
  Obsidian adapter + editor coordination
       |
  shared TypeScript sync engine
       |
  persistent local state: manifest, bases, outbox, inbox, receipts
       |
       +-- Supabase Auth ---------------------- user session
       +-- SupaSync API / Edge Function -------- control requests
       +-- Supabase Realtime ------------------ wake-up hints only
       +-- short-lived signed HTTP URLs ------- attachment bytes
                                                   |
                                  Supabase Storage OR Cloudflare R2

SupaSync API, in the user's Supabase deployment
  verifies user JWT; validates typed requests; derives actor identity
  calls transactional, service-only Postgres RPCs
  authorizes attachment transfers and signs URLs
  never holds a database transaction open during storage/network I/O

Postgres
  Markdown bodies + current entries + immutable revisions/change feed
  memberships + clients + idempotency receipts + blob metadata
  snapshot manifests + retention floor + protocol/epoch information

Hermes CLI / SDK
  calls the same authenticated API and uses the same commit preconditions
  does not need to launch Obsidian
```

Keep the backend small: one Supabase project, one primary API Edge Function, and one maintenance entrypoint. No mandatory separate VPS, Redis, message broker, Cloudflare Worker, or custom always-running daemon.

The API is a thin authentication/validation/storage gateway. The database owns transactionality and commit ordering. The shared client engine owns reconciliation and local application. Do not implement three different sync engines for plugin, CLI, and tests.

### Package boundaries

- `packages/protocol`: request/response schemas, version negotiation, typed errors, canonical paths, content hashes, operation envelopes. Browser-compatible.
- `packages/sync-core`: bootstrap, pull/push, reconciliation, conflict handling, retries, local recovery. No Obsidian or Node imports.
- `packages/client`: authenticated backend API client, also usable headlessly.
- `apps/obsidian`: public Obsidian APIs, settings, commands, status, conflict/revision UI.
- `apps/cli`: Node-only filesystem adapter and commands for Hermes and test automation.
- `supabase`: migrations, database tests, Edge Functions, local config, seed fixtures, deployment scripts.

## 3. Non-negotiable correctness invariants

1. **Preserve conflicting work.** No timestamps, file sizes, or arrival order may silently discard a competing edit.
2. **Stable identities.** An entry UUID survives renames and content updates. Paths are mutable properties, not identities.
3. **Conditional writes.** Updates and deletions declare the exact remote revision from which they were derived. The server rejects stale writes.
4. **Idempotent retries.** The same operation ID and identical request return the original result without another mutation. Reusing an ID with different content fails.
5. **Atomic remote commits.** Entry update, revision, ordered journal record, and mutation receipt succeed or fail in one Postgres transaction. In this design, the revision table is also the journal.
6. **A persistent queue precedes network work.** Losing the process after the request is sent must not lose the pending operation or its immutable payload.
7. **Realtime is optional for correctness.** With every notification dropped, polling or manual sync must still converge.
8. **Never infer deletion from an empty listing or missing local state.** Deletion requires a known previously synchronized entry and an explicit local deletion/reconciliation event.
9. **Metadata never publishes an incomplete attachment.** A file revision can reference only an authorized, verified, ready blob.
10. **Receiving is not applying.** Fetching a journal page is not proof that the corresponding local changes are durable.
11. **Clocks are descriptive.** Device times and filesystem mtimes are display/scan hints, not sync authority.
12. **All supported writers use the protocol.** Hermes, an import tool, and the plugin must not bypass revisioning with ordinary table updates.

## 4. Backend data model

Use a dedicated non-exposed `supasync` data schema. Expose only intentional `public.supasync_*` RPC entrypoints and, optionally, an RLS-respecting read view for notes. Explicitly configure grants and Data API exposure; do not assume that placing an object in `public` exposes it. Current Supabase behavior has changed in this area. [S2]

| Relation | Required fields and responsibilities |
|---|---|
| `vaults` | UUID, name, owner, protocol version, server epoch, transactional `head_seq`, `namespace_seq`, replay floor, default storage backend, limits, retention policy |
| `vault_members` | Vault/user composite key, owner/editor/reader role, enabled/revoked status; user identity references Supabase Auth |
| `clients` | Vault/client UUID, owning user, label/platform, client generation, last seen, acknowledged applied cursor, bootstrap state; a client ID is not an authentication credential |
| `entries` | Stable UUID, vault, path, portable path key, parent ID, kind (`markdown`, `blob`, `folder`), current revision/version, deleted status, optional `conflict_of` and originating conflict operation |
| `text_bodies` | Vault-scoped SHA-256, exact Markdown text, UTF-8 byte length; immutable, deduplicated within a vault |
| `revisions` | Vault/sequence key, entry UUID/version, parent revision, full path and kind snapshot, text hash OR blob ID OR neither for a directory, tombstone, actor/client/op IDs, server timestamp; immutable change feed and history |
| `operation_receipts` | Vault/client generation/operation ID, canonical request digest, original outcome and returned revision information; supports ambiguous-success retries |
| `storage_backends` | Authorized vault, provider, endpoint/region/bucket, display label, server-side secret reference, capability/config version; clients cannot supply arbitrary signing targets |
| `blobs` | Blob UUID, vault, expected and verified SHA-256/length, MIME hint, upload reservation, state, expiry, finalization lease/fencing token |
| `blob_locations` | Blob/backend/object key, verified integrity information, state; supports resumable migration and temporary coexistence of providers |
| `snapshots` | Snapshot UUID, vault/client/user, server epoch, fixed head sequence, expiry, complete/active state |
| `snapshot_items` | Snapshot/entry key, pinned immutable revision reference; stable paginated bootstrap catalog |

`entries` holds references rather than duplicating each Markdown body. A read view or API response joins the current revision to `text_bodies` and returns path, Markdown, and revision ID together. A rename reuses the existing body hash.

### Constraints and indexes

Require unique live `(vault_id, path_key)`, unique `(vault_id, entry_id, version)`, unique `(vault_id, seq)`, and unique idempotency keys. Use composite foreign keys where needed so a revision, blob, parent, or body cannot cross vault boundaries.

A live Markdown revision has exactly one Markdown body and no blob reference; a blob revision has exactly one ready blob reference and no Markdown body. Folder revisions have neither. Tombstones retain the identity and sufficient prior references for retention/recovery. Folder parents must exist, belong to the vault, and not create cycles.

Index the sequence feed, live path lookup, entry history, membership checks, client progress, and blob references. Store cursors as Postgres `bigint` and serialize them as decimal strings in JSON; do not allow JavaScript floating-point conversion to corrupt a cursor.

### Exact Markdown handling

Hash exact UTF-8 content, preserving line endings, Unicode, frontmatter, and final newlines. Do not parse and reserialize YAML during sync. The backend recomputes the Markdown hash from the supplied text. A file that is not valid supported text, including a NUL-containing Markdown file, produces a visible actionable error; the local original remains intact.

### Portable paths

Use normalized relative vault paths with `/`. Reject traversal, absolute paths, NULs, invalid components, and names incompatible with the supported desktop/mobile filesystem policy. Preserve display case but compare using one versioned NFC-plus-Unicode-case-fold canonicalizer. Run this shared canonicalizer in the trusted gateway; never trust a client-supplied comparison key. Reject collisions rather than silently renaming user files.

Include canonicalization fixtures for decomposed/composed accents, emoji, non-ASCII case pairs, case-only renames, reserved device names, and trailing dots/spaces. Canonicalization upgrades are protocol/schema migrations, not silent dependency changes.

## 5. Remote transaction protocol

All user requests reach the Edge gateway with a Supabase access token. The gateway verifies the token server-side, derives `actor_id` from the verified identity, validates the operation schema, and calls a database RPC. Ignore or reject client-supplied author/owner IDs.

Mutation RPCs are `SECURITY INVOKER` and callable only by the trusted backend service role; ordinary `anon` and `authenticated` roles cannot execute them or perform direct DML. Explicitly revoke default function execution from `PUBLIC`, `anon`, and `authenticated`, then grant the required execution privilege to `service_role`. Apply equivalent default-privilege rules to future migrations. Since the backend role bypasses RLS, each RPC MUST perform its own explicit actor membership and role checks. Do not assume that using an admin client preserves end-user RLS. [S3]

Within a commit:

1. Lock the vault row with `SELECT ... FOR UPDATE`.
2. Check current membership, protocol/epoch/client generation, and limits. Membership/namespace management uses the same lock discipline.
3. Check the operation receipt. An identical retry returns the stored outcome; mismatched payload reuse fails.
4. Validate the requested base revision and path/parent/blob constraints.
5. Write new immutable content and revision records, update the entry head, advance `head_seq`, and record the outcome atomically.
6. Emit a small private wake-up notification, containing at most vault ID and head sequence, for committed changes.
7. Return the accepted revision and operation outcome. A conflict returns structured current-state references, not an overwritten file.

**Do not use a bare `bigserial` cursor as evidence of commit order.** Sequence allocation is not the same as transaction visibility. A per-vault counter updated under the vault-row lock serializes the small commit section and prevents a later visible sequence from causing a client to skip an earlier uncommitted operation. PostgreSQL documents the special non-transactional visibility of sequence increments. [S4]

On the first `pull_changes` page, a missing ceiling means the server captures the currently committed `head_seq` and returns it; all remaining pages use that fixed ceiling. Advance a local receive cursor only through actually persisted page records, never merely to a Realtime notification's advertised head.

No object upload, external HTTP call, hashing of a large attachment, or user interaction is permitted while this lock is held. Independent vaults do not share the lock. No-op same-content commits return a receipt without manufacturing a new revision.

### Operation envelope

Every mutation includes `protocol_version`, `server_epoch`, `vault_id`, `client_id`, `client_generation`, `operation_id`, operation type, entry ID, and the exact `base_revision_id` when applicable. Creates use an absent entry and an absent-path precondition. The immutable payload and canonical request digest are captured before transmission.

A rejected conflict is a completed outcome for that operation ID. A reconciled follow-up uses a new operation ID and the new explicit base; do not mutate and resend the old envelope.

Keep receipts for the lifetime of an active client generation. Retiring/resetting a generation rejects its old operations before old receipts can be removed. This prevents an ancient retry becoming a new mutation after receipt garbage collection.

### Core API contract

| Operation | Important input | Required result |
|---|---|---|
| `capabilities` | Client protocol/version | Compatible versions, epoch, limits, configured providers, retention floor |
| `register_client` / `list_vaults` | Authenticated identity and vault selection | Bound client generation and available vault metadata |
| `begin_snapshot` | Vault/client | Snapshot token, fixed sequence, expiry, counts |
| `list_snapshot` | Token and keyset cursor | Stable revision references; never a changing offset list |
| `get_revisions` / `get_bodies` | Explicit revision/body IDs | Authorized immutable content, batched by count and bytes |
| `pull_changes` | After sequence, fixed ceiling, page cursor | Ordered revisions, next cursor, ceiling, replay-floor status |
| `commit` | Typed operation envelope | Accepted/no-op/conflict outcome with original operation ID |
| `rename_tree` | Folder ID, expected namespace revision, destination | Atomic path changes for the subtree with unchanged entry IDs |
| `delete_tree` | Folder ID and confirmed expected state | Atomic tombstones, or a stale-state rejection |
| `ack_applied` | Highest contiguous settled sequence | Durable device progress for retention |
| `begin_blob_upload` / `finalize_blob` | Vault, size/hash, reservation | Signed staging transfer and then verified ready blob ID |
| `get_blob_download` | Authorized revision/blob ID | Short-lived URL for an available verified location |
| `list_history` / `restore_revision` | Entry and revision IDs | History or a new conditional head revision; never rewind the journal |
| `create_conflict_copy` / `resolve_conflict` | Source entry, competing content, current bases | Idempotent preservation/resolution revisions |
| `start_storage_migration` / `migration_status` | Authorized source/target backend | Resumable operation and verified copy progress |

Typed errors include `AUTH_REQUIRED`, `PERMISSION_DENIED`, `BASE_CONFLICT`, `PATH_COLLISION`, `STALE_NAMESPACE`, `CURSOR_EXPIRED`, `EPOCH_MISMATCH`, `CLIENT_GENERATION_EXPIRED`, `BLOB_NOT_READY`, `HASH_MISMATCH`, `LIMIT_EXCEEDED`, `PROTOCOL_UPGRADE_REQUIRED`, and retryable transport/storage errors. Authentication errors pause with a sign-in action; protocol conflicts are not retried unchanged.

## 6. Device persistence and synchronization loop

Use IndexedDB through a small transactional abstraction, with the vault files remaining independently recoverable. Namespace state by backend, remote vault, and local installation ID. Store only configuration and secret references in the plugin's ordinary settings file, not the entire sync database.

Persist the local manifest, base text/revision references, immutable outbox payloads, received inbox records, per-file apply intents, staged downloads, and conflict records. Keep `received_cursor` distinct from `applied_cursor` and from the server acknowledgment.

A stored page of revision references is not sufficient reason to acknowledge application. A sequence is settled only when its change is durably applied, its competing contents are durably preserved as a conflict, or an explicit exclusion policy classifies it as intentionally not materialized. Pending attachments or active-editor conflicts remain unsettled while unrelated notes can continue processing.

### Normal cycle

Recover unfinished apply intents, scan for local changes, capture outbox work, fetch a journal ceiling, pull through that ceiling, reconcile each relevant entry, upload ready local operations, and pull again to observe intervening remote work. Process fairly so continuous remote traffic cannot starve local pushes. Run one sync engine per local vault with bounded per-file work; coalesce duplicate triggers.

When recording local changes, preserve the last common base revision. Do not replace it with the latest remote revision merely because a newer row was fetched. If a file changes while an upload is in flight, acknowledge the exact sent snapshot and queue the newer local content against the newly accepted base; never mark the latest contents as already uploaded.

### Crash-safe local application

Before modifying a local file, persist an apply intent containing the expected local hash and the incoming revision/hash. Recheck the file and any active editor buffer. Apply through public Obsidian APIs, verify the resulting state, then mark the intent complete and advance the manifest in a local transaction.

On restart, compare observed disk contents to the before/after hashes and finish, replay, or enter conflict recovery. Do not assume the Obsidian filesystem and IndexedDB participate in one transaction.

For incoming changes to an open note, compare the editor buffer with persisted content and defer while there are unpersisted edits. Use `Vault.process` for guarded read/modify/write of existing Markdown, but still test editor coordination separately; an atomic filesystem API is not proof that every editor race is handled. Obsidian exposes `Vault.process` as an atomic note read/modify/save operation. [S5]

Suppress sync echoes only when an observed event matches the specific expected applied hash/path transition. A global `isSyncing` flag must not hide unrelated user edits.

### Lost state

If local metadata is missing, corrupt, or belongs to another server epoch, enter recovery/bootstrap mode. Preserve the vault and queued content that remains readable. Never conclude that missing metadata means every remote file should be deleted. A copied plugin configuration must not cause two physical installations to reuse an active client generation unknowingly.

## 7. Bootstrap, retention, and recovery

`begin_snapshot` briefly acquires the same vault lock used for commits, records the head sequence, and materializes a catalog of current immutable revision references in `snapshot_items`. Release the lock before downloading any contents. Pin those revisions and blob locations until the snapshot expires or completes.

The client pages that immutable catalog, downloads/materializes content, and then pulls changes after the snapshot sequence. Concurrent edits continue normally. A paginated query over changing current rows is not an acceptable snapshot substitute.

For an empty local vault, download the remote state. For a nonempty vault joining a remote vault without a shared baseline, present a non-destructive import preview: identical path/content can be adopted, different contents are preserved separately, and absence on either side is not deletion. Previously tombstoned or ambiguous local files require explicit recovery/import rather than automatic resurrection.

A snapshot expiry restarts snapshot negotiation without deleting local data. An expired replay cursor returns `CURSOR_EXPIRED`; rebuild from a snapshot while preserving local work and reconciling old intentions.

### Starting retention policy

Use configurable defaults of a 30-day replay horizon, current heads retained indefinitely, and at least 20 historical versions per entry when available. These are product defaults, not provider guarantees. The actual retained set is the union of history policy, replay requirements, active snapshots, and required blob references.

Devices inactive beyond the replay horizon must re-bootstrap and no longer pin unbounded history. Active devices' unacknowledged work remains protected within the configured policy. Retention advances a contiguous replay floor; never delete arbitrary feed rows above that floor. If a storage cap cannot be met without violating a live pin, stop/prioritize capacity management rather than silently removing required data.

Do not collect a blob while any current head, retained revision, snapshot, or active finalization references it. Garbage collection uses mark-and-sweep with a grace period, rechecks references transactionally, and blocks new references once a blob enters deletion. Unfinished uploads and obsolete migration copies have separate cleanup rules.

Provide a restore runbook that rotates the server epoch after database restoration, validates matching object backups, and forces clients to reconcile. Restoring a database backup by itself does not automatically produce a new epoch. Detect a client cursor ahead of the server as a rollback signal too.

## 8. Conflict and namespace behavior

| Situation | Required behavior |
|---|---|
| Only local changed from the common base | Conditional push |
| Only remote changed | Guarded local application |
| Both arrived at identical content and path | Adopt without duplicate content |
| Both edited Markdown, non-overlapping changes | Three-way merge from the preserved common base, then a conditional commit |
| Both edited overlapping Markdown | Keep the remote head and preserve local work as a deterministic conflict copy; show resolution UI |
| No usable common base | Preserve both; never invent a two-way merge as authoritative |
| Competing binary edits | Preserve both; no automatic byte merge |
| Remote delete vs local edit | Keep the remote deletion of the original identity and preserve local work as a recovered/conflict entry; offer explicit restore |
| Local delete vs remote edit | Reject stale deletion; preserve remote work and let the user resolve |
| Rename vs edit | Merge path/content only when independent and bases are known; otherwise preserve and prompt |
| Two creates at the same portable path | Adopt if equivalent; otherwise retain one head plus a conflict copy |
| Same entry renamed to two paths | Surface a namespace conflict; do not arbitrarily choose based on time |

Use a tested three-way text merge library or well-tested implementation. Preserve Markdown source rather than interpreting rendered meaning. Conservative v1 behavior: overlapping edits to frontmatter are manual conflicts. Do not inject conflict markers into the only surviving original note.

Conflict filenames must be deterministic and portable, for example `Plan (conflict laptop a1b2c3).md`. Derive the uniqueness suffix from the originating operation, not the current clock. A repeated retry must not create twenty copies. Mark conflict copies in backend metadata, sync them as normal files, and retain both versions when a user resolves them.

Folder rename is a single namespace transaction. Verify the expected namespace revision and destination; calculate all affected paths; detect collisions/cycles; preserve entry IDs and current content; publish only final revisions. Use staging inside the transaction where needed for uniqueness constraints. A folder delete must additionally detect unseen content edits: use a confirmed head/tree state, not only a folder's own version. Oversized operations return a visible negotiated limit rather than half-completing.

Renaming across the Markdown/non-Markdown boundary is an explicit kind conversion, not just a filename change: validate and store the new representation before publishing the revised head, retain the previous representation through history, and never lose bytes on an unsupported conversion.

Use vault-level rename application for incoming moves. Let normal user-initiated Obsidian link rewrites sync as ordinary Markdown changes; do not run independent backlink rewriting on every receiving device. The headless rename API documents that it changes paths, not the semantics of all Markdown links. Test link behavior with Obsidian's automatic link update setting enabled.

## 9. Attachment storage and provider selection

Implement a server-side storage adapter with operations to sign staging upload/download URLs, inspect/copy/delete objects, verify content, and advertise capabilities. Implement Supabase Storage and R2 against their real endpoints; do not infer identical behavior solely from the label S3-compatible. [S1][S6]

Keep the plugin transport provider-neutral. It receives an authorized URL, HTTP method, and required headers. There is no AWS SDK or permanent storage credential requirement on mobile.

### Two-phase publishing

1. `begin_blob_upload` validates actor membership, expected length/hash, configured limits, and the selected backend; reserve quota and a random staging key.
2. Upload directly to staging with a short-lived signed URL. Persist progress/reservation locally before sending.
3. `finalize_blob` claims a bounded finalization lease, inspects the object, and copies it to a fresh server-only final key.
4. Verify the sealed final object's size and SHA-256; do not treat ETag as a portable SHA-256 checksum. Use bounded/streaming verification and enforce runtime/file-size limits.
5. Persist the verified final location with a compare-and-set on the finalization token. A stale finalizer may leave an orphan, but must not overwrite a winning final object. Each attempt uses a different final key.
6. Only then can an ordinary conditional entry commit reference the ready blob.
7. Cleanup staging and failed/abandoned finalization attempts after their expiry/grace period.

Staging is important because a signed PUT URL can remain reusable until it expires. Never hand a client a reusable upload URL targeting an already-published immutable object. R2 documents URL reuse until expiry. [S7]

Use random immutable object keys, not user paths. A rename does not re-upload bytes. An integrity failure leaves existing local/remote content intact and surfaces a retryable or quarantined transfer, never a successful sync indicator.

V1 may use restartable whole-file transfers under a tested maximum. Set a conservative initial attachment limit, such as 25 MiB, and display oversized files as unsynchronized with a reason. Raise limits only after mobile and hosted runtime tests; implement multipart/resumable support as a later capability rather than silently failing large files. Never claim all files are synchronized while excluded/failed/pending files exist.

### Provider migration

Provider selection is a vault setting, not an independent choice on each device. Existing blobs retain their location records. Changing the preferred provider directs new uploads to the target while a resumable migration copies existing blobs, verifies hashes, records new locations, and preserves source copies until references and a grace period permit deletion. Reads work from an available verified location throughout migration.

Configuration alone must never reinterpret an old object key as belonging to the new bucket. Cancellation, target failure, concurrent edits, and migration restart must be tested. A Markdown-only vault requires no blob migration.

## 10. Authentication, authorization, and secrets

Use normal Supabase Auth sign-in for the plugin and headless client. A practical v1 supports email/password for an existing or provisioned account, without requiring mobile OAuth/deep-link flows. Do not retain the password after authentication. Store session material through a tested secret-store abstraction using Obsidian `SecretStorage` on supported versions; settings store references only. The API exists from Obsidian 1.11.4. [S5]

Reject service-role keys in plugin settings. Supabase-generated S3 access keys bypass Storage RLS and are intended for servers; keep them in backend secrets. R2 credentials are also backend-only. The plugin needs only the Supabase project URL/public key and its user session. [S8]

Enable RLS for all data relations as defense in depth, with explicit membership-based read access where exposed. An optional `supasync_notes` view must be `security_invoker` and granted intentionally. Backend RPCs still authorize independently because their caller is privileged. Test each function with no token, an expired/invalid token, a valid unrelated user, a reader, an editor, and an owner.

Authorize Realtime channels using their exact vault membership; no general `using (true)` subscriber policy. A notification must not contain note content. Backend storage signing accepts authorized blob IDs and configured backends, not arbitrary bucket/key/endpoint parameters from the client. Bind short-lived URLs to the authorized action and redact them in logs.

A client/device record is for state and administration; blocking its ID is not equivalent to revoking an Auth credential. Document session revocation behavior and short-lived signed-URL validity. Disconnecting or revoking a device must not delete its local vault or reset the remote vault.

## 11. Obsidian and mobile implementation

Start with the official sample plugin. Bundle the plugin as CommonJS for Obsidian's loader while targeting browser-compatible dependencies. Externalize Obsidian as required. Enforce no runtime imports of Node `fs`, `path`, `crypto`, Electron, native SQLite, `child_process`, or desktop-only filesystem paths in the plugin/core bundles. Such tools are allowed only in build tooling, tests, and the separate CLI. Obsidian's mobile documentation explicitly distinguishes Node/Electron-dependent desktop-only plugins. [S9]

Use public `Vault`, `DataAdapter`, `TFile`, `TFolder`, `normalizePath`, and platform APIs. Keep file I/O behind a `VaultAdapter`. Use `requestUrl` for finite cross-platform HTTP operations when appropriate; implement and test a proper adapter for libraries expecting `fetch`, rather than assuming they are identical. `requestUrl` accepts text or ArrayBuffer bodies and does not expose a general streaming Fetch API. [S5]

Put `isDesktopOnly: false` in the manifest. Select a minimum Obsidian version consistent with the APIs used; 1.11.4 is the proposed floor for the secret-store integration, subject to actual target-device verification.

### Automatic behavior

Listen for actual vault create/modify/delete/rename events. Default automatic sync debounces persisted modifications around 750 ms with a bounded maximum wait, for example five seconds. Obsidian already saves edits; do not invent a documented universal `save` event or upload on every keystroke. Editor-change events may drive dirty-buffer awareness, not an alternative unsaved content authority.

Sync on initial layout readiness, returning to the foreground, reconnect, and manual command. Use a visible-app polling fallback, initially around 60 seconds, plus private Realtime hints. Pause expensive work when hidden and recover on resume. Timer execution or completion of an unload handler is never required for correctness. Mobile plugin auto-sync cannot be promised while Obsidian is closed/suspended. [S10]

On mobile, use small batches, bounded memory, and low attachment concurrency. Proposed defaults: one binary transfer on mobile, two on desktop, at most 25 commit operations per request with negotiated byte limits, and 100 revision metadata records per pull page. Load bodies separately in byte-bounded batches; do not read the entire vault into memory on startup.

### Configuration and interface

The setup wizard validates the backend/protocol, signs in, selects or creates a remote vault, selects an authorized configured storage backend, previews initial import behavior, and tests a tiny create/download/delete round trip in a dedicated diagnostic namespace that cannot affect real notes.

Provide commands for Sync now, Pause/resume, Show status, Show conflicts, Show history/restore, Reconcile/rebuild local index, Export redacted diagnostics, and Sign out/disconnect. Show last successful sync, pending notes/attachments, blocked files, conflicts, errors, retry state, and active transfer progress. Use a mobile-accessible view/modal and ribbon/commands; desktop status-bar placement alone is insufficient.

Exclude the entire active Obsidian configuration directory, SupaSync's local state/cache, `.git`, `.trash`, OS metadata, and temporary files from v1 content synchronization. Respect a non-default Obsidian config directory. Exclusion is not deletion. Changing filters never sends tombstones for newly excluded files; re-inclusion performs explicit current-state reconciliation. Do not exclude ordinary underscore-prefixed user notes merely because they start with `_`.

Provide release assets `main.js`, `manifest.json`, `styles.css`, and `versions.json`, plus installation instructions. Include manual/BRAT installation for testing and the Community Plugins submission workflow for distribution. Validate actual Android and iOS installation; desktop mobile emulation is a preliminary check, not an actual mobile pass. [S9][S11]

## 12. Hermes and headless use

Implement a thin CLI/SDK around the same client and protocol. Required operations: list vaults/notes, read a note with its revision, conditional write/create/delete/rename, import/export, and run a one-off sync for a local directory. Use a normal authorized Auth identity and a distinct client ID/generation for Hermes.

A successful agent write must appear on another device without a manual full-vault refresh and without an open desktop Obsidian session. If the note changed after Hermes read it, return the same conflict response as a device receives.

Provide an example Hermes skill invoking the CLI and describing how to supply credentials outside the vault. A narrow MCP wrapper may call the same client, but is not necessary to ship the core plugin. Supabase's administrative MCP can inspect/deploy schema; routine note edits should call the sync protocol rather than raw `UPDATE` statements that skip receipts/history.

## 13. Patterns to study, not wholesale architecture to inherit

Remotely Save is useful for storage-provider organization, mobile constraints, exclusions, initial configuration, deletion reasoning, conflict presentation, and protection against surprising bulk changes. Its current documentation includes object-store and mobile support; its algorithm notes explicitly include deletion computation and sync-protection thresholds. [S11][S12]

Self-hosted LiveSync is useful for local persistent state, reconciliation/recovery UX, modular separation between platform-specific and common code, and integration testing against real backends. Its development guide separates Obsidian-specific modules from common replication code and describes browser and backend integration harnesses. [S13]

Do not bolt Postgres onto a CouchDB replication protocol, or preserve object storage as the authority for Markdown because another plugin does so. The reference repositories are behavioral references, not this product's specifications.

Before copying anything, inspect the license of the precise file/version. Remotely Save currently identifies its `src/tests/docs/assets` directories as Apache-2.0 and `pro` as PolyForm Strict; LiveSync identifies MIT. Do not copy Remotely Save's Pro implementation into this project. Record any adapted code and required notices; pin the reviewed upstream commit in the project documentation. [S14][S15]

## 14. Repository and implementation stages

```text
supasync/
  apps/obsidian/src/{main,settings,ui,adapters,editor,commands}/
  apps/cli/src/
  packages/protocol/src/
  packages/client/src/
  packages/sync-core/src/{engine,reconcile,merge,queue,recovery}/
  supabase/migrations/
  supabase/functions/supasync-api/
  supabase/functions/supasync-maintenance/
  supabase/tests/
  tests/{unit,property,integration,faults,obsidian,mobile,fixtures}/
  scripts/{dev-backend,seed,install-test-vault,release,export-vault}/
  docs/{ARCHITECTURE,PROTOCOL,SECURITY,TESTING,DEPLOYMENT,RECOVERY}.md
  AGENTS.md
  README.md
  THIRD_PARTY_NOTICES.md
```

Use strict TypeScript, pinned dependencies/lockfile, a browser-compatible plugin build, and isolated adapters. Choose test libraries that support deterministic unit and property-based tests. Do not install backend tooling in the plugin bundle. Re-check current Supabase CLI commands and compatible Node/tool versions rather than copying historical command flags. Realtime-related objects belong in the application schemas; current Supabase changes restrict modification of the `realtime` schema apart from supported authorization policies. [S16]

### Stage 0 — compatibility and protocol skeleton

Verify real Obsidian desktop/mobile APIs, auth storage, finite HTTP transport, IndexedDB durability, and both storage endpoints with tiny proof-of-concept transfers. Establish the package boundaries, strict types, operation envelopes, errors, and deterministic path fixtures. Record decisions in `ARCHITECTURE.md` and `PROTOCOL.md`.

**Gate:** plugin loads without desktop-only imports; prototype HTTP/auth/state behavior is demonstrated on available real targets, with unavailable targets recorded as unverified.

### Stage 1 — database and authorization

Create schema migrations, explicit grants/RLS, service-only transaction RPCs, gateway JWT verification, membership roles, client generations, ordered revisions, receipts, and snapshot catalogs. Test with at least two independent Auth users.

**Gate:** no unauthorized cross-vault reads/writes; stale writes fail; duplicate operations do not duplicate changes; overlapping transactions cannot create a skipped-cursor scenario.

### Stage 2 — sync core without the Obsidian UI

Implement memory and headless filesystem adapters; persistent outbox/inbox; bootstrap; pull/push; file and folder changes; crash recovery; Markdown merge; deterministic conflict copies; cursor expiry and epoch recovery.

**Gate:** three simulated clients converge under randomized partitions, duplicate requests, delays, restarts, clock skew, and competing edits, or preserve an explicit documented conflict.

### Stage 3 — attachment storage

Implement Supabase Storage first, then R2 using the same contract. Add staged uploads, sealed immutable objects, integrity checks, retries, limits, cleanup, and provider migration.

**Gate:** local real-storage tests pass; real R2 smoke tests are separately recorded. A generic S3 test server is not evidence that R2 is verified.

### Stage 4 — Obsidian desktop integration

Connect actual vault events and editor coordination, settings wizard, status/errors, conflict/history views, bootstrap preview, filters, and release assets.

**Gate:** two real disposable vaults synchronize edits, attachment bytes, deletes, renames, and conflicts; active-editor edits survive an incoming remote update.

### Stage 5 — mobile and lifecycle

Install on Android and iOS, test keyboard/editor behavior, foreground resume, offline edits, forced process termination, network transitions, failed uploads, token refresh, and bounded memory. Resolve incompatible dependencies rather than merely setting the manifest flag.

**Gate:** each tested platform has an explicit result record, not an inference from desktop emulation.

### Stage 6 — agent integration, recovery, and release

Finish CLI/Hermes example, revision restore, backup/export and restore procedure, migration runbooks, retention/garbage collection, release automation, documentation, and support diagnostics. Run the full failure and security matrix.

**Gate:** build artifact is installable; the backend deploys from documented migrations; end-to-end demonstrations and test reports match the code delivered. Every requested v1 capability is implemented, not replaced with a TODO.

## 15. Test matrix and definition of done

Use real local Supabase for database/auth/function/storage integration, plus two users, two vaults, three client identities, and fixture notes/attachments. The CLI-managed stack must be project-isolated. Do not reset an unrelated local Supabase instance or use the user's real vault as a test fixture.

For phone testing, the phone must reach the test backend through a reachable development endpoint. A phone's `localhost` is not the desktop. Verify generated signed URLs use the client-reachable hostname, not a Docker-internal address. Document local versus hosted configuration separately.

| Test family | Required cases |
|---|---|
| CRUD and identity | Note/binary/folder create, edit, delete, restore, case-only rename, folder move, empty folder, binary-to-Markdown extension transition |
| Multi-device | Desktop ↔ desktop, desktop ↔ Android, desktop ↔ iOS, offline create/edit/delete, first import, reconnect after long absence |
| Conflict correctness | Same and different line edits, same content, YAML overlap, delete/edit, rename/edit, rename/rename, same-path create, missing merge base |
| Delivery failures | Dropped/reordered/duplicated notifications, duplicate HTTP requests, response lost after commit, 401/403/429/5xx, delayed success after timeout |
| Durability | Kill before/after outbox persist, after server commit, before receipt acknowledgment, before/after local apply, after inbox persistence, during snapshot download |
| Journal/snapshot | Overlapping database transactions, stable multi-page snapshot during writes, boundary page sizes, missing/expired cursor, epoch reset, client-generation retirement |
| Blob integrity | Empty file, Unicode filename, byte-for-byte hash, oversized file, interrupted transfer, expired URL, staging overwrite, concurrent/stale finalizer, missing remote object |
| Namespace | Unicode normalization, case-fold collisions, traversal, reserved names, conflicting folder move, unseen child edit during folder deletion, link-update behavior |
| Authorization | No token, wrong issuer/expired token, unrelated user, reader mutation, editor owner-action, forged author, direct RPC/DML, cross-vault blob/signing attempts |
| Recovery/migration | Local state missing, tombstone replay, restored server backup, R2 outage, provider migration while editing, aborted migration, stale device reconnect |
| Cleanup | No deletion of pinned/current data, expired staging cleanup, blob reference race, history floor advancement, quota exhaustion |
| Device UX | Actual mobile install, real app suspend/resume/kill, auth refresh, open editor race, progress and error recovery, no green status with pending failures |

Property-test invariants, not just a few examples: histories stay linear on accepted heads; all surviving user variants remain reachable; identities survive renames; applying a response twice is harmless; no observed cursor skips a committed mutation; all clients converge once the network is healthy and work stops, except for explicit unresolved conflicts whose variants remain preserved.

Performance acceptance is evidence-based. Use a documented fixture, initially 10,000 small Markdown files plus representative attachments, and record hardware, cold bootstrap time, subsequent one-note sync work, idle request rate, peak memory, and UI responsiveness. An idle interval must not upload unchanged bodies or list an entire bucket. No bandwidth/latency claim should be made without measurements on that environment.

The final implementation report must include commands run, results, actual platforms tested, downloadable/release artifacts, schema/protocol versions, known size limits, and any unverified real-provider/mobile tests. Compilation, mocks, and a desktop screenshot alone do not establish working cross-device sync.

## 16. Handoff instruction for the implementing agent

> Implement this specification, not merely its happy-path demo. Start by inspecting the repository and available environment, create `AGENTS.md` with the invariants, and maintain a checklist keyed to the stages and tests above. Work in isolated fixtures and a project-local backend. Implement and execute tests alongside each layer; continue fixing failures rather than stopping at a scaffold. Do not touch production projects or the user's real vault. Keep credentials out of source and release assets. Use the same protocol for Obsidian and headless writers. Do not silently defer mobile, R2, conflict preservation, or recovery, since they are part of the requested product. When an actual device/provider credential is unavailable, deliver the code and reproducible test procedure and report that target as unverified. Do not fabricate passing tests. Finish with installable artifacts, backend deployment instructions, and a test/limitations report.

## Source references

These references ground platform capabilities and upstream patterns. Protocol choices, thresholds, schemas, and implementation stages above are this specification's proposed design, not claims that the upstream projects implement the same architecture. Re-verify versions and pin upstream commits when implementation begins.

- **S1 — Supabase S3 compatibility:** `https://supabase.com/docs/guides/storage/s3/compatibility`
- **S2 — Supabase Data API exposure change:** `https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically`
- **S3 — Supabase Row Level Security:** `https://supabase.com/docs/guides/database/postgres/row-level-security`
- **S4 — PostgreSQL transaction isolation / sequence behavior:** `https://www.postgresql.org/docs/current/transaction-iso.html`
- **S5 — Official Obsidian API declarations:** `https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts`
- **S6 — Cloudflare R2 S3 compatibility:** `https://developers.cloudflare.com/r2/api/s3/api/`
- **S7 — Cloudflare R2 presigned URLs:** `https://developers.cloudflare.com/r2/api/s3/presigned-urls/`
- **S8 — Supabase S3 authentication:** `https://supabase.com/docs/guides/storage/s3/authentication`
- **S9 — Official Obsidian mobile development:** `https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Getting%20started/Mobile%20development.md`
- **S10 — Remotely Save browser environment constraints:** `https://github.com/remotely-save/remotely-save/blob/master/docs/browser_env.md`
- **S11 — Remotely Save README:** `https://github.com/remotely-save/remotely-save`
- **S12 — Remotely Save sync algorithm notes:** `https://github.com/remotely-save/remotely-save/blob/master/docs/sync_algorithm/v3/intro.md`
- **S13 — LiveSync development guide:** `https://github.com/vrtmrz/obsidian-livesync/blob/main/devs.md`
- **S14 — Remotely Save license:** `https://github.com/remotely-save/remotely-save/blob/master/LICENSE`
- **S15 — LiveSync license:** `https://github.com/vrtmrz/obsidian-livesync/blob/main/LICENSE`
- **S16 — Supabase Realtime schema change:** `https://supabase.com/changelog/realtime-schema-locked-down-against-modification`
- **S17 — Supabase database function security and grants:** `https://supabase.com/docs/guides/database/functions`
- **S18 — Supabase database-change notification approaches:** `https://supabase.com/docs/guides/realtime/subscribing-to-database-changes`
