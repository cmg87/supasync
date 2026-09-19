# SupaSync v2

End-to-end encrypted Obsidian vault synchronization through Supabase Auth, Postgres, and Supabase Storage. File contents, attachment contents, vault labels, and basenames are encrypted on the client. The backend stores ciphertext, opaque IDs, encrypted names, and an ordered revision journal.

This branch is a **v2 development release**, protocol 2 / crypto 1. It breaks compatibility with plaintext v1. Read [verification status](docs/V2-IMPLEMENTATION.md) before using it for important notes. Keep an independent vault backup and your encryption recovery key.

## Build and install locally

Requires Node.js 22 or newer. Local hosting also requires Git, Docker Engine/Desktop and Docker Compose. Docker must already be available to your user; setup does not silently install privileged system software.

```bash
npm ci
npm run typecheck
npm run build
```

The build creates **`dist/obsidian/`** containing `main.js`, `manifest.json`, `styles.css`, and `versions.json`. Copy those files into `<your-vault>/.obsidian/plugins/supasync/`, restart Obsidian, and enable SupaSync in Settings → Community plugins. Obsidian 1.11.4 or newer is required for SecretStorage. Desktop and mobile use the same bundle.

The CLI bundle is `apps/cli/dist/cli.js`. To test the actual npm distribution:

```bash
npm pack -w supasync
npm install -g ./supasync-0.2.0.tgz
supasync --version
supasync setup --mode local --dry-run
supasync setup --mode local --port 8000 --vault-path /absolute/path/to/test-vault
```

The tarball includes the CLI, daemon, plugin assets, Edge Functions and v2 schema. It does not require a repository checkout or unpublished workspace dependencies. `npx supasync setup` is the intended published entry point; **this branch has not been published to npm**, so install the locally built tarball to test this implementation.

## Connect and sync

1. Run setup using an explicitly selected test vault. Normal local mode installs a pinned official Supabase Docker distribution, bound to loopback. It does not use `supabase start`.
2. Open SupaSync settings in Obsidian. Setup writes the connection fields into the selected vault's plugin settings. On another device, import `connection.json` or scan the `connection.png` QR from your installation directory.
3. Create an account or sign in. SupaSync creates or selects an encrypted remote vault.
4. Save the displayed recovery key **outside the synced vault**, then enter it again to verify. Sync remains locked until verification succeeds.
5. Enable auto sync or use Sync now. On another installation, sign in to the same account and unlock with the recovery key, or approve its pairing request from an unlocked device.

An account password reset does not recover encryption keys. Connection QR codes contain only public connection information. Recovery QR codes contain a decryption secret; keep them private.

## Deployment modes

- `local`: loopback access on this computer.
- `local-tailnet`: private HTTPS through Tailscale Serve. Requires an installed, signed-in Tailscale client. It never enables Funnel.
- `existing` / `managed`: connect to an operator-provisioned v2 endpoint using `--url` and `--anon-key`. These modes validate health; they do not deploy to a remote production project.
- `developer`: explicit Supabase CLI development mode. See [deployment instructions](docs/DEPLOYMENT.md).

State defaults to `~/.config/supasync`; override with `SUPASYNC_HOME` or `--home`. Backend configuration, credentials, daemon state and queues stay outside the vault. CLI credentials currently use a disclosed user-only file fallback (0700 directories, 0600 files). Plugin tokens and vault keys use Obsidian SecretStorage.

## Optional desktop daemon

Mobile requires no daemon. Desktop works in-process by default.

For continuous headless synchronization, first authenticate and unlock the CLI using the same account and recovery key:

```bash
supasync login --email you@example.com
supasync vault list
supasync recovery verify --vault VAULT_ID
```

In the desktop plugin, enable **Delegate sync to daemon** to pause its in-process engine. Then:

```bash
supasync vault attach --vault VAULT_ID --dir /absolute/path/to/vault
supasync daemon run
# In another terminal:
supasync daemon token
```

Paste that local token into the plugin's daemon setting. When delegation is enabled, a missing daemon leaves sync paused. Turning delegation off requires the running daemon to release ownership. To run at login, use `supasync service install`; per-user service definitions are provided for Linux, macOS and Windows. Only the Linux foreground daemon is exercised here; actual login/reboot and other operating systems remain unverified.

## Troubleshooting

Run `supasync doctor` and `supasync backend status`. If the plugin is missing, check the folder name and the four files above, then restart Obsidian and enable Community plugins. If sign-in works but sync fails, check the API and Storage health, confirm that the backend runs v2, and replace the plugin with the rebuilt v2 bundle. The plugin uses Obsidian's public request API for network requests; no Node runtime modules are needed.

A loopback URL points to the current device. Phones need the host's reachable private HTTPS endpoint, not `127.0.0.1`. See [deployment](docs/DEPLOYMENT.md), [recovery](docs/RECOVERY.md), [security](docs/SECURITY.md), [headless usage](docs/hermes-skill.md), and [tests](docs/TESTING.md).
