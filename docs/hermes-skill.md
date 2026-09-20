# Headless / agent usage

Install the same SupaSync CLI as desktop users. Authenticate using hidden password input (`login --email EMAIL`), list vaults, and enroll with `recovery verify --vault ID`. For unattended input, pass the secret through stdin, not shell arguments or environment logs. Credentials use a user-only file fallback. Never give an agent a service-role key or direct database write access.

All commands below require `--vault ID --dir /absolute/path/to/local-vault`. The directory must already exist. A running daemon owns attached vaults; one-shot CLI sync refuses an active ownership lock.

```text
sync
list
get --path note.md
history --path note.md
write --path note.md --file /local/draft.md --base-revision REV
write --path new.md --file /local/draft.md --base-revision 0
rename --path note.md --to renamed.md --base-revision REV
delete --path note.md --base-revision REV
restore --path note.md --revision OLD_REV --base-revision CURRENT_REV
```

Reads decrypt locally. `list` returns stable entry IDs and current revision IDs. Conditional mutations persist their exact payload before network work, return a receipt, and use exit code 2 for a competing remote revision. `--operation-id UUID` can identify a durable mutation; a pending operation must be retried with `sync`, using its saved ciphertext. Do not reissue modified content under its ID.

Synchronize again to apply accepted remote changes to the local filesystem. Importing existing plaintext folders uses the ordinary initial sync and preserves conflicts; a dedicated v1 server importer is not implemented. Export plaintext only from an enrolled local vault and keep it separate from encrypted server backups. Ordinary SQL/table writes are unsupported because they bypass receipts and history.
