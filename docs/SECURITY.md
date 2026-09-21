# Security

The server is trusted with plaintext vault names, filenames, text, history, and attachments. There is no application-level E2EE. Host/storage/backup encryption is an independent operator concern.

Obsidian uses atomic text updates. Binary replacement has no equivalent public Obsidian API, so the previous file is retained in vault-local trash before creating the new version. Remote deletes also use trash and never recursively remove untracked local descendants.

Obsidian receives a public Supabase key and an ordinary session for the configured admin Auth UID. RLS and guarded functions enforce this single administrator. Public signup is disabled. Tokens are held in Obsidian SecretStorage; plugin data.json contains connection configuration only.

Hermes uses a dedicated PostgreSQL login with application read/write/function permissions. It has no superuser, role creation, schema ownership, bypass-RLS, trigger alteration, or history-editing rights. Runtime SQL writes still require an exact base and operation identity. Installer/backend server credentials remain outside the vault in user-only installation files.

Use HTTPS for network-accessible plugin endpoints. HTTP is allowed only on loopback. Hermes uses TLS with CA/hostname verification; the default exposed DB port is loopback-only. Never disable certificate validation to reach a remote host.

Binary uploads go to staging. Finalization verifies the downloaded bytes and stores those same bytes under an immutable final key. Canonical revisions cannot reference an unready or cross-vault blob. Public clients cannot overwrite final objects. Short-lived capability tokens authorize only one reserved binary object.

History, receipts, and referenced objects are retained. Backups contain sensitive plaintext and Auth data. Restrict access to backups and verify restoration in an isolated installation.
