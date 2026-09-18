---
name: supasync-hermes
description: Read and write Obsidian notes that sync through SupaSync. Use when the user asks to list, read, create, update, or rename notes in a SupaSync vault without opening Obsidian.
---

# SupaSync Hermes

Do not UPDATE Postgres tables directly. That skips receipts and history. Call the CLI, which uses the same protocol as the plugin.

Credentials live outside the vault, typically `~/.config/supasync/`. Never write the service-role key into a note.

```bash
node /path/to/supasync/apps/cli/dist/cli.js vaults
node /path/to/supasync/apps/cli/dist/cli.js sync --dir /path/to/vault --vault <vault-id>
```

If a note changed after it was read, the server returns `BASE_CONFLICT`. Re-read, preserve both versions if needed, and commit a new operation id. Do not resend the old envelope.
