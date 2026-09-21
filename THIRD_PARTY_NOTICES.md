# Third-party notices

- Obsidian API typings and sample-plugin packaging: see the Obsidian package license and official sample's 0-BSD license.
- `qrcode` 1.5.4: MIT. Non-secret connection profile QR generation in the installer.
- `pg` 8.16.3: MIT. Direct PostgreSQL client for Hermes.
- `selfsigned` 5.5.0: MIT. Generates the local PostgreSQL TLS certificate using Node.
- `@inquirer/prompts` 7.8.6: MIT. Interactive installation prompts.
- `yaml` 2.9.1: ISC. Used to adapt official Compose configuration.
- Supabase Docker release `self-hosted/v0.8.1`, resolved commit `8c7a4d9dbbaf8b552893822e89d7bf06f33f9220`: obtained from the official upstream repository at installation time. SupaSync retains pinned images, isolates Compose projects and publishes only the gateway and TLS PostgreSQL on loopback. Vendor images retain their upstream licenses.

The npm lockfile records dependency versions. This repository does not copy Remotely Save or Self-hosted LiveSync source.
