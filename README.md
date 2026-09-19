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

From the repository root, build the plugin:

```bash
npm install
npm run build
```

The installable plugin is in **`dist/obsidian/`** at the repository root:

```text
dist/obsidian/
  main.js
  manifest.json
  styles.css
  versions.json
```

Copy those four files into `<vault>/.obsidian/plugins/supasync/` (create the folder if needed). When updating, replace those files and keep any existing `data.json`. Restart Obsidian, turn off Restricted mode under **Settings → Community plugins**, and enable **SupaSync** under **Installed plugins**. Obsidian 1.11.4 or newer is required.

`npm run release` builds the same installable folder. The CLI build remains at `apps/cli/dist/cli.js`. For a preconfigured disposable local vault, use the quick start below.

In plugin settings:

1. Enter the Supabase project URL and the **publishable / anon** key. Never paste a secret or service-role key.
2. Enter an email and password, then **Create account** or **Sign in**.
3. If the project requires email confirmation, confirm the message and sign in afterward.
4. SupaSync lists only vaults this account can access. A first-time account gets a remote vault named after the current Obsidian vault. If several vaults exist, choose one from the dropdown or create another by name.
5. Sync starts. Use **Sync now** if auto-sync is off.

You do not open Supabase Studio, write SQL, use the CLI, or paste a vault UUID to start syncing. The remote vault id is stored internally and shown only under Advanced.

The password is used for that one sign-in or signup and is not saved in plugin settings. Session tokens are stored in Obsidian SecretStorage, scoped to the Supabase project and plugin installation. Signing out revokes only that installation’s session. Existing installations using the earlier shared session key need to sign in once after updating.

## Development

Node 22+, Docker, and the Supabase CLI are required for the backend.

```bash
npm install
npm test
npm run build
npm run dev:backend
```

`npm run dev:backend` starts the local Supabase stack **and** serves the Edge Functions the plugin calls. Hosted Supabase deploys those functions separately; production does not use this command.

### Local plugin quick start

With `npm run dev:backend` running in one terminal, run this in another:

```bash
npm run dev:plugin
```

This builds the plugin and creates a **new disposable vault** under `test-vaults/`, with the local URL and public key already configured. Open the printed folder as a vault in Obsidian 1.11.4+, enable community plugins if prompted, and open **Settings → SupaSync**. Create an account or sign in. Local sign-up confirms immediately; SupaSync creates/selects the remote vault and starts syncing.

Run the command again for a second disposable vault and sign in with the same account to test sync. The installer never opens or modifies a personal vault. Keep the backend terminal running. Auth failures remain visible in settings; passwords are cleared after each attempt. The connection settings are under **Supabase connection**.

Never put a service-role key in plugin settings.

## Troubleshooting

If sign-up or sign-in reports **“Secret ID is invalid … 64 characters max”**, update the installed plugin's `main.js` to the latest build and reload the plugin. Earlier builds generated session IDs that exceeded Obsidian's limit. The corrected build uses a bounded hash of the backend URL and installation ID. If signup already created your account, use **Sign in** afterward.

If sign-in succeeds but sync reports **“Failed to fetch”**, update the plugin from `dist/obsidian/` and keep `npm run dev:backend` running. Earlier builds tried to transfer attachments using Docker-only storage URLs and the browser's network API. The corrected build uses the configured Supabase address for local storage and Obsidian's network adapter. Keep your existing `data.json`, reload the plugin, and select **Sync now**.

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
