# SupaSync

A personal, self-hosted Obsidian sync backend. PostgreSQL is the canonical vault: text, filenames, and history are queryable plaintext. Supabase Storage holds immutable binary objects. One configured Supabase Auth account connects Obsidian; Hermes connects directly to PostgreSQL using a dedicated role.

## Install

Requires Node.js 22+, Git, Docker Engine, and Docker Compose. The installer detects prerequisites; it does not install privileged host software.

```sh
npm ci
npm run typecheck
npm run build
npm pack -w supasync
npm install -g ./supasync-0.3.0.tgz
supasync setup
```

This repository has not been published to npm. Setup offers local or private Tailscale HTTPS access, selects a local vault, creates your admin account and remote vault, installs the plugin, and writes its non-secret connection settings. Open Obsidian, enable SupaSync, and sign in once. Sessions live in Obsidian SecretStorage; passwords are never saved in plugin configuration. Obsidian 1.11.4+ is required; the same plugin bundle supports desktop and mobile.

Normal settings show account, vault, last sync, Sync now, and Auto Sync. Connection details, vault selection, and diagnostics are under Advanced. History/restore is available through the command palette. Polling and manual sync work without Realtime.

There is no encryption enrollment, recovery key, pairing, daemon, or multi-user tenancy model. The server is trusted with plaintext. Secure the host and backups accordingly.

## Hermes

```sh
supasync hermes connection    # Displays a secret DB connection string and CA
supasync vault list
supasync list --vault UUID
supasync search --vault UUID --query "meeting"
supasync write --vault UUID --path Notes/today.md --file draft.md --base-revision 0
```

The CLI uses the dedicated DB role and certificate-verified TLS, without a Supabase login or local vault mirror. SQL clients can search/read tables and perform revision-checked writes. See [direct SQL examples](docs/hermes-skill.md).

## Development and verification

```sh
supasync dev start
supasync dev seed             # Explicit opt-in fixtures in the isolated dev project
supasync dev reset --yes
supasync dev stop
npm test
npm run test:database
npm run test:integration
```

Normal setup never creates fixtures or resets a database. Database/HTTP integration tests create and remove their own containers. The default Supabase seed remains empty.

Protocol 3 is a clean break from the unreleased encrypted v2 development implementation. Use a fresh installation; old databases and local queues are never silently converted or reset. No v2 data migration is provided because existing v2 data was testing-only.

See [deployment](docs/DEPLOYMENT.md), [protocol](docs/PROTOCOL.md), [security](docs/SECURITY.md), and [verification status](CHECKLIST.md).
