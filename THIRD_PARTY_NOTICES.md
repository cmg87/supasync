# Third-party notices

- Obsidian API typings and sample-plugin packaging: see the Obsidian package license and official sample's 0-BSD license.
- `@noble/ciphers` 2.4.0, `@noble/hashes` 2.2.0, `@noble/curves` 2.4.0: MIT, Paul Miller and contributors. Established cryptographic implementations; SupaSync adds domain separation and versioned framing.
- `qrcode` 1.5.4: MIT; `jsqr` 1.4.0: Apache-2.0. Used for local QR generation and image decoding.
- `yaml` 2.9.1: ISC. Used to adapt official Compose configuration.
- Supabase Docker release `self-hosted/v0.8.1`, resolved commit `8c7a4d9dbbaf8b552893822e89d7bf06f33f9220`: obtained from the official upstream repository at installation time. SupaSync retains pinned images, isolates Compose projects and publishes only the gateway on loopback. Vendor images retain their upstream licenses.

The npm lockfile records dependency versions. This repository does not copy Remotely Save or Self-hosted LiveSync source.
