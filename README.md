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

## Development

Node 22+, Docker, and the Supabase CLI are required for the backend.

```bash
npm install
npm test
npm run build
npm run dev:backend
```

Plugin release assets are `apps/obsidian/main.js`, `manifest.json`, `styles.css`, and `versions.json`.

Install for testing: copy those four files into `<vault>/.obsidian/plugins/supasync/` or use BRAT against this repository.

Never put a service-role key in plugin settings. The plugin needs the project URL, the public/anon key, and a user session.

## Headless / Hermes

```bash
node apps/cli/dist/cli.js config --url http://127.0.0.1:54321 --anon-key <anon>
node apps/cli/dist/cli.js login --email you@example.com --password '…'
node apps/cli/dist/cli.js create-vault --name Notes
node apps/cli/dist/cli.js sync --dir /path/to/vault --vault <vault-id>
```

See `docs/DEPLOYMENT.md`, `docs/TESTING.md`, and `docs/RECOVERY.md`.
