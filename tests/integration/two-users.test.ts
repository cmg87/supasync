import { expect, it } from "vitest";
import { PasswordAuth, SupaSyncClient, VaultKeys } from "@supasync/client";
import {
  deviceKeypair,
  wrapDevice,
  unwrapDevice,
  type DeviceEnvelope,
  encryptName,
  nameToken,
} from "@supasync/crypto";
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
// The development gateway accepts this public key; no service credential is used by clients.
const localAnon =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
async function user() {
  const map = new Map<string, string>();
  const secrets = {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => {
      map.set(k, v);
    },
  };
  const auth = new PasswordAuth(
    url,
    process.env.SUPABASE_ANON_KEY ?? localAnon,
    fetch,
    secrets,
  );
  await auth.signUp(
    `supasync-fixture-${crypto.randomUUID()}@example.test`,
    "test-password-v2",
  );
  return {
    auth,
    client: new SupaSyncClient({
      url,
      anonKey: process.env.SUPABASE_ANON_KEY ?? localAnon,
      fetch,
      session: auth,
    }),
    keys: new VaultKeys(secrets, url, "test"),
  };
}
it("v2 enforces actor isolation, exact retries, stale bases, encrypted-only payloads and revocation", async () => {
  const owner = await user();
  const other = await user();
  const vaultId = crypto.randomUUID();
  const prepared = await owner.keys.prepare(vaultId, "private test");
  await owner.client.rpc("create_vault", prepared);
  await owner.keys.recover(
    vaultId,
    prepared.recoveryEnvelope,
    (await owner.keys.pendingRecovery(vaultId))!,
  );
  const key = (await owner.keys.get(vaultId))!;
  const clientId = crypto.randomUUID();
  await owner.client.registerClient({
    vaultId,
    clientId,
    label: "test",
    platform: "test",
  });
  await expect(other.client.rpc("capabilities", { vaultId })).rejects.toThrow(
    "PERMISSION_DENIED",
  );
  const caps = await owner.client.rpc<{ serverEpoch: string }>("capabilities", {
    vaultId,
  });
  const entryId = crypto.randomUUID();
  const nameObjectId = crypto.randomUUID();
  const envelope = {
    protocolVersion: 2,
    cryptoVersion: 1,
    serverEpoch: caps.serverEpoch,
    vaultId,
    clientId,
    clientGeneration: 1,
    operationId: crypto.randomUUID(),
    entryId,
    type: "create",
    payload: {
      parentEntryId: null,
      nameObjectId,
      encryptedName: encryptName(key, "folder", {
        vaultId,
        entryId,
        objectId: nameObjectId,
        keyVersion: 1,
      }),
      nameToken: nameToken(key, vaultId, null, "folder"),
      kind: "folder",
      objectId: null,
      keyVersion: 1,
    },
  };
  const accepted = await owner.client.rpc<{ revision: { seq: string } }>(
    "commit",
    { vaultId, clientId, envelope },
  );
  expect(
    await owner.client.rpc("commit", { vaultId, clientId, envelope }),
  ).toEqual(accepted);
  await expect(
    owner.client.rpc("commit", {
      vaultId,
      clientId,
      envelope: { ...envelope, type: "delete" },
    }),
  ).rejects.toThrow("ID_REUSE");
  expect(
    await owner.client.rpc("commit", {
      vaultId,
      clientId,
      envelope: {
        ...envelope,
        type: "update",
        baseRevisionId: "0",
        operationId: crypto.randomUUID(),
      },
    }),
  ).toMatchObject({ outcome: "conflict" });
  await expect(
    owner.client.rpc("commit", {
      vaultId,
      clientId,
      envelope: {
        ...envelope,
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        payload: { ...envelope.payload, path: "plaintext" },
      },
    }),
  ).rejects.toThrow();
  const recipient = deviceKeypair();
  const newClientId = crypto.randomUUID();
  const pairingId = crypto.randomUUID();
  await owner.client.registerClient({
    vaultId,
    clientId: newClientId,
    label: "new device",
    platform: "test",
  });
  await owner.client.rpc("pair_begin", {
    vaultId,
    clientId: newClientId,
    pairingId,
    publicKey: recipient.publicKey,
  });
  const context = {
    vaultId,
    entryId: newClientId,
    objectId: pairingId,
    purpose: "device" as const,
    keyVersion: 1,
  };
  await owner.client.rpc("pair_approve", {
    vaultId,
    clientId,
    pairingId,
    envelope: wrapDevice(key, recipient.publicKey, context),
  });
  const paired = await owner.client.rpc<{ envelope: DeviceEnvelope }>(
    "pair_get",
    { vaultId, clientId: newClientId, pairingId },
  );
  expect(unwrapDevice(paired.envelope, recipient.privateKey, context)).toEqual(
    key,
  );
  await expect(
    owner.client.rpc("pair_consume", { vaultId, clientId, pairingId }),
  ).rejects.toThrow("PERMISSION_DENIED");
  await owner.client.rpc("pair_consume", {
    vaultId,
    clientId: newClientId,
    pairingId,
  });
  await expect(
    owner.client.rpc("pair_get", { vaultId, clientId: newClientId, pairingId }),
  ).rejects.toThrow("PAIRING_EXPIRED");
  recipient.privateKey.fill(0);
  await owner.client.rpc("revoke_device", {
    vaultId,
    clientId,
    targetClientId: clientId,
  });
  await expect(owner.client.rpc("get_vault_keys", { vaultId })).rejects.toThrow(
    "CLIENT_REVOKED",
  );
  await expect(
    owner.client.registerClient({
      vaultId,
      clientId: crypto.randomUUID(),
      label: "bypass",
      platform: "test",
    }),
  ).rejects.toThrow("CLIENT_REVOKED");
  key.fill(0);
  await owner.auth.signOut();
  await other.auth.signOut();
}, 30000);
