# Security

- Plugin settings may contain the Supabase URL and public/anon key only. Session tokens go in Obsidian `SecretStorage` (1.11.4+). Service-role keys, S3 access keys, and R2 credentials are server-only.
- Mutation RPCs are executable solely by `service_role`. They still check membership because the service role bypasses RLS.
- The `supasync` schema is not in the Data API schema list. `public.supasync_notes` is `security_invoker`.
- Realtime wakeups contain vault id and head sequence, never note bodies.
- Signed object URLs are bound to an authorized blob id and configured backend. Clients cannot supply an arbitrary bucket or key.
- Blocking a client id is not the same as revoking an Auth session. Sign out or revoke refresh tokens to invalidate access. Short-lived signed URLs remain valid until they expire.
- Disconnecting a device does not delete the local vault or reset the remote vault.

Authentication, RLS, TLS, and provider-side encryption are not end-to-end encryption.
