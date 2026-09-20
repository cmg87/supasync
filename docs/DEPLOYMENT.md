# Deployment

Build and install the tarball as described in the README. Normal local setup uses the official `self-hosted/v0.8.1` Supabase release, resolved commit `8c7a4d9dbbaf8b552893822e89d7bf06f33f9220`. Service image versions come from that pinned Compose file. Each installation has a separate Docker project derived from its backend directory. Only the existing Supabase gateway is published, on `127.0.0.1`; Studio, Postgres and the pooler are not separately exposed.

```bash
supasync setup --mode local --port 8000 --dry-run
supasync setup --mode local --port 8000 --yes
supasync doctor
supasync backend status
```

Setup discovers dependencies, prepares private backend configuration, starts persistent containers, installs schema/functions, checks health, and exports a public profile. `--vault-path` additionally installs the plugin into that explicitly selected vault. Repeating setup preserves generated credentials and installation identity. Failure leaves completed task records for diagnosis/retry. No setup path runs a database reset or deletes volumes.

For private second-device access, install Tailscale and sign in on the host first, then use `--mode local-tailnet` in a new installation. Setup calls Tailscale Serve to publish the gateway over tailnet HTTPS, never Funnel. Sign in to Tailscale on the second device and scan the connection profile. Private HTTPS, mobile and host-reboot behavior require the manual tests in TESTING.md.

Existing/managed Supabase must already have the v2 schema and `supasync-api` deployed by its operator. Use the SQL under `supabase/migrations` and deploy `supabase/functions/supasync-api`. The function validates the user's JWT with Auth and is the only caller of the private dispatcher. Configure its server-side Supabase URL and service-role key; never put that key into a profile or plugin. The dispatcher is unavailable to `anon` and `authenticated`. Then connect with:

```bash
supasync setup --mode existing --url https://your-backend --anon-key PUBLIC_KEY
```

## Developer stack

For a **fresh project-local test stack**, run `npm run dev:backend`; this starts the Supabase CLI development stack and serves functions. Apply the v2 migration using the local Supabase migration workflow. Do not reset an existing database to hide migration or encryption failures. The v1 migration chain is preserved in Git at `supasync-v1-baseline-20260919`; fresh v2 installs do not create plaintext v1 tables. Existing v1 operators must back up and choose an explicit cutover. V2 retires the old dispatcher but does not erase old data.

## Updates and removal

`supasync backend update --dry-run` reports the installed and supported pinned release. Cross-release automated backend upgrades are not implemented yet; the command refuses an unsupported change. Make and verify a backup before an operator-managed upgrade. Plugin updates use `supasync plugin update --vault-path PATH` and preserve settings.

`supasync backend down` stops/removes containers while retaining persistent volumes. `supasync service uninstall` removes the per-user service, retaining local data and keys. Never delete the installation directory as an update procedure.
