# Testing

Use only project-local Supabase and disposable vault directories. Never run fixture scripts against a production endpoint. Local integration tests create their own fixture accounts and encrypted vaults.

```bash
npm ci
npm run typecheck
npm run test:unit
# With the local v2 schema and Edge Function served:
npm test
supabase test db
npm run build
npm pack -w supasync
```

The v2 suite covers encryption/authentication failures, independent HKDF vectors, recovery/device envelopes, chunk termination, path validation, merges, exact ciphertext retries after lost responses, two-client note/attachment sync, folder rename identity, competing edits, actor isolation, stale bases, payload rejection, revocation, and concurrent disk-state durability. The plaintext audit inspects scoped v2 rows, outgoing requests/uploads and Edge logs for private markers and plaintext hashes. The optional direct PostgREST denial test requires explicit local environment variables.

## Installed-package test

Install the tarball in a directory outside the workspace package graph. Set SUPASYNC_HOME to a disposable path, choose an unused gateway port, and run setup twice. Check doctor, create a fixture account/vault, confirm recovery, synchronize notes and attachments between two disposable local folders, and verify hashes. Confirm only loopback gateway ports are bound and no credentials enter connection profiles or package assets.

Exercise daemon attach/run/status/sync, concurrent ownership rejection, stop/restart and retry after network interruption. Create a backup, verify its checksums and restore into a separate empty installation. Confirm recovered plaintext with the separately held recovery key.

## Required manual release tests

1. Desktop: install plugin into a disposable vault, sign up, verify recovery, create/rename/edit/delete text and binary files, preserve competing edits, restart Obsidian, and confirm convergence.
2. Daemon: configure delegation, install the per-user service, reboot the host, edit while Obsidian is closed, reopen it and verify single ownership and convergence. Test macOS and Windows service definitions on those operating systems.
3. Tailnet: verify private HTTPS on a second device, then temporarily disconnect/reconnect the host and client.
4. Android and iOS: import the public profile, sign in, enroll via recovery and via device approval, sync notes/attachments, background/foreground the app and reconcile offline edits. Verify no desktop daemon or Node APIs are required.
5. Scale: test representative large vaults and attachments under mobile memory limits. The current framed implementation buffers a complete object and has not met the streaming/performance release gate.

Record actual results in V2-IMPLEMENTATION.md. Automated tests are not evidence that mobile, reboot, private HTTPS or large-vault performance passed.
