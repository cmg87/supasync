# SupaSync

Bidirectional Obsidian vault synchronization. Each device keeps a real vault. Supabase Postgres stores Markdown and the ordered revision journal. Attachments live in private Supabase Storage or Cloudflare R2.

This is an implementation of `SupaSync-Architecture-and-Build-Plan.md`. It is not a CRDT editor and it is not end-to-end encrypted in v1.

## Packages

- `packages/protocol` — envelopes, errors, path canon, hashes
- `packages/client` — authenticated API + password auth
- `packages/sync-core` — replica engine, merge, recovery
- `apps/obsidian` — community plugin (`isDesktopOnly: false`)
- `apps/cli` — Hermes / headless client
- `supabase` — schema, RPCs, Edge Functions

## Plugin setup

Install `apps/obsidian/main.js`, `manifest.json`, `styles.css`, and `versions.json` into `<vault>/.obsidian/plugins/supasync/`, or use BRAT against this repository.

In plugin settings:

1. Enter the Supabase project URL and the **publishable / anon** key. Never paste a secret or service-role key.
2. Enter an email and password, then **Create account** or **Sign in**.
3. If the project requires email confirmation, confirm the message and sign in afterward.
4. SupaSync lists only vaults this account can access. A first-time account gets a remote vault named after the current Obsidian vault. If several vaults exist, choose one from the dropdown or create another by name.
5. Sync starts. Use **Sync now** if auto-sync is off.

You do not open Supabase Studio, write SQL, use the CLI, or paste a vault UUID to start syncing. The remote vault id is stored internally and shown only under Advanced.

The password is used for that one sign-in or signup and is not saved in plugin settings. Session tokens are stored in Obsidian SecretStorage, scoped to the Supabase project.

## Development

Node 22+, Docker, and the Supabase CLI are required for the backend.

```bash
npm install
npm test
npm run build
npm run dev:backend
```

`npm run dev:backend` starts the local Supabase stack **and** serves the Edge Functions the plugin calls. Hosted Supabase deploys those functions separately; production does not use this command.

Never put a service-role key in plugin settings.

## Headless / Hermes

The CLI still supports listing and creating vaults for agents and servers:

```bash
node apps/cli/dist/cli.js config --url http://127.0.0.1:54321 --anon-key <anon>
node apps/cli/dist/cli.js signup --email you@example.com --password '…'
node apps/cli/dist/cli.js login --email you@example.com --password '…'
node apps/cli/dist/cli.js create-vault --name Notes
node apps/cli/dist/cli.js vaults
node apps/cli/dist/cli.js sync --dir /path/to/vault --vault <vault-id>
```

See `docs/DEPLOYMENT.md`, `docs/TESTING.md`, and `docs/RECOVERY.md`.
