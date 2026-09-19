# Protocol 2

POST `/functions/v1/supasync-api` with `{protocolVersion:2, operation, payload}`. Send the authenticated user's JWT as Authorization and the public Supabase key as apikey. Protocol 1 is rejected. Private RPC calls require an actor and verified Auth session ID, supplied only by the gateway.

Operations cover encrypted vault creation/listing, client registration, capabilities, recovery envelopes, pairing/revocation, ciphertext reservation/finalization/download, commits, snapshots, paged journal/history and applied acknowledgments. Wire entries contain a stable UUID, parent UUID, encrypted basename, opaque sibling token, name-encryption object ID, entry kind, content object ID and key version. No plaintext path, content hash, text or MIME label is accepted in a commit.

A mutation carries a UUID operation ID, client identity/generation, server epoch and exact base revision. Its canonical JSON digest is stored with the result. Identical retries return the original receipt; changed payloads under the same ID fail. Stale writes produce a conflict result. Vault-row locking serializes entry updates, ordered revisions and receipts in one transaction. Folder moves update the folder entry; descendant IDs and content ciphertext remain unchanged.

Clients persist exact encrypted payloads before network activity. Object reservations bind random object ID, actor, ciphertext hash and length. Finalization verifies staging bytes and writes those exact bytes to an immutable final key. A revision cannot reference an unready object.

The client reconciles decrypted data locally. Received and applied cursors are separate; an acknowledgment advances only after durable application. Polling/manual sync works independently of Realtime. Empty listings are never sufficient proof of deletion. History and ciphertext are currently retained indefinitely; maintenance does not prune them.
