# Deployment

Build locally, pack the CLI workspace, install the resulting tarball, and run `supasync setup`. The package includes plugin assets, schema, binary Edge Function, and development configuration.

Setup uses the pinned official Supabase Docker distribution recorded in installer constants. It creates a distinct Compose project per installation directory. Install state defaults to `~/.config/supasync`, overridable through `SUPASYNC_HOME` or `--home`.

```sh
supasync setup --mode local --vault-path /absolute/path/to/vault
supasync setup --mode local-tailnet --vault-path /absolute/path/to/vault
supasync doctor
supasync backend status
```

Interactive setup uses select prompts. Automated setup supplies `--email`, `--password-stdin`, `--vault-path`, and `--yes`; secrets should not be placed in arguments. `--port` and `--database-port` choose unused loopback ports. `--dry-run` performs no installation.

The installer writes URL, public key, vault UUID, and admin email into `.obsidian/plugins/supasync/data.json`. Sign in once from Obsidian; the installer never writes its admin password or tokens into the vault. A non-secret connection.json/profile QR can configure other devices. Mobile clients need the host's private HTTPS URL; their localhost is not the backend host.

Tailscale mode requires an installed, signed-in Tailscale client and uses Serve, never Funnel. External networking changes and real mobile connectivity require the checks in TESTING.md. Direct PostgreSQL is loopback-only by default, with TLS; remote Hermes can use an SSH tunnel to that port and the generated CA.

Normal setup provisions only the requested admin and vault. It does not import fixture users, run dev seeds, or reset data. Re-running setup preserves identities. It refuses an existing protocol-2 installation: select a fresh installation directory and ports.

Setting up another local vault creates a separate remote vault by default. Pass `--vault-id UUID` to bind it to an existing remote vault instead. Local-to-remote choices are persisted before provisioning so interrupted runs reuse the same UUID.

Development commands use a separate cache directory, project ID `supasync-dev-v3`, and ports 55320–55324. `dev seed` explicitly creates development-only credentials. `dev reset --yes` resets that marked development project only. The checked-in seed SQL remains empty.

Back up with `supasync backup create --file DIRECTORY`, verify checksums with `backup verify`, and restore only into a separate empty matching backend. Backup data includes Auth, canonical files, revisions, receipts, settings, and Storage bytes. Keep the backup private.

`supasync restore-backup --home /new/installation --file /backup --port 8001 --database-port 55433` creates an empty matching backend, restores it, regenerates Hermes credentials, and assigns a new epoch. It refuses to overwrite populated targets.
