# Recovery and backups

An Auth password and an encryption recovery key are different secrets. Losing every enrolled device and the recovery key makes encrypted server data unrecoverable. Save the recovery key independently and verify it once during vault creation. The setup QR is public connection information; it cannot unlock content.

To enroll a CLI/daemon installation, sign in, run `supasync vault list`, then `supasync recovery verify --vault ID`. The key is read through hidden input. The plugin supports the same recovery flow and image-based QR import. Alternatively, create a device pairing request, approve its exact public key from an unlocked device, then finish enrollment on the requesting device within ten minutes.

## Server backup

```bash
supasync backup create --file /private/backups/supasync-2026-09-19
supasync backup verify --file /private/backups/supasync-2026-09-19
```

The destination must be empty. The archive contains Auth, Storage and v2 database data plus Storage bytes, backend version, protocol/crypto version and SHA-256 checksums. These files contain sensitive account metadata and password hashes, even though note contents are encrypted. It never includes local plaintext vault files or local decryption keys.

Postgres is exported from one consistent snapshot, then Storage is copied. Ready objects are immutable and retained, so the later copy contains at least the objects referenced by that snapshot. This depends on the current no-GC retention policy. `backup verify` verifies archive byte integrity, not recoverability. Keep your recovery key separately and test restoration.

To restore, first create a **separate empty installation** with another SUPASYNC_HOME and unused port, using the same pinned backend release. Then:

```bash
SUPASYNC_HOME=/private/restore-test supasync restore --backup /private/backups/supasync-2026-09-19 --empty-target
```

Restore refuses targets containing Auth users, vaults or Storage objects. It stops the API writers, imports data and Storage bytes, then restarts services. On failure it leaves writers stopped for inspection. Sign in, enroll with your recovery key and verify representative notes, attachments and history before switching devices. Do not point this command at an existing personal installation.

## V1 cutover

The v1 baseline is tagged `supasync-v1-baseline-20260919`. Back up its database and local plaintext vault independently. Use a separate v2 installation and a copy of the plaintext vault to create an encrypted vault. Compare local file counts and hashes after a second-device pull. Keep the v1 backup until verification is complete. There is no automatic destructive reset or dedicated server-side v1 importer.
