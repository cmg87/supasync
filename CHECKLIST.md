# Plaintext v3 implementation

The current architecture is documented in docs/ARCHITECTURE.md. The original v1/v2 plans are historical; this single-owner plaintext design supersedes their tenancy and E2EE requirements.

- [x] Plaintext canonical schema, guarded direct SQL, transactional revisions/journal/receipts.
- [x] Single configured Auth admin and dedicated Hermes role.
- [x] Plaintext client, durable outbox, conflict preservation, polling, history/restore.
- [x] Simplified mobile-compatible plugin and direct PostgreSQL CLI.
- [x] Installer provisioning and complete non-secret plugin settings.
- [x] Separate dev commands and disposable PostgreSQL/PostgREST tests.
- [x] Typecheck, production bundles, local tests, and SQL/HTTP integration exercised.
- [x] Full official-stack installer: repeat setup, multiple vault bindings, non-secret plugin settings, Auth, Hermes TLS enforcement, Storage bytes, and fresh-install backup restore.
- [x] Standalone packaged CLI and plugin runtime-import/mobile-manifest checks.
- [ ] Actual Obsidian desktop, Android, iOS, and private HTTPS device checks.

Do not interpret historical v2 verification as evidence for v3. No real vault or production backend was used for this refactor.

Verification: 80 local tests, 26 disposable PostgreSQL checks, 20 HTTP integration tests, and 8 pgTAP authorization checks. The installer smoke test verified a binary round trip and restored account access, note identities, and attachment bytes into a second empty backend. Real Obsidian desktop/mobile and private HTTPS device behavior remain unverified.
