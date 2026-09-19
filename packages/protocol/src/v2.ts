/** v2 wire records contain only opaque IDs, ciphertext and routing metadata. */
export type EncryptedValue = {
  cryptoVersion: 1;
  keyVersion: number;
  algorithm: "xchacha20poly1305";
  nonce: string;
  ciphertext: string;
};
export type EncryptedEntry = {
  parentEntryId: string | null;
  encryptedName: EncryptedValue;
  nameToken: string;
  nameObjectId: string;
  kind: "markdown" | "blob" | "folder";
  objectId: string | null;
  keyVersion: number;
};
export type WireRevision = EncryptedEntry & {
  vaultId: string;
  entryId: string;
  seq: string;
  parentSeq: string | null;
  version: number;
  tombstone: boolean;
  operationId: string;
  clientId: string;
  actorId: string;
  serverTime: string;
};
export type WireMutation = {
  protocolVersion: 2;
  cryptoVersion: 1;
  serverEpoch: string;
  vaultId: string;
  clientId: string;
  clientGeneration: number;
  operationId: string;
  entryId: string;
  baseRevisionId?: string;
  type: "create" | "update" | "delete" | "rename" | "restore_revision";
  payload: EncryptedEntry | Record<string, never>;
};
export type ConnectionProfile = {
  version: 1;
  serverUrl: string;
  publicKey: string;
  vaultId?: string;
  deployment: "local" | "local-tailnet" | "managed" | "existing";
};
export function parseConnectionProfile(value: unknown): ConnectionProfile {
  if (!value || typeof value !== "object")
    throw new Error("Invalid connection profile");
  const p = value as ConnectionProfile;
  if (
    Object.keys(p).some(
      (k) =>
        ![
          "version",
          "serverUrl",
          "publicKey",
          "vaultId",
          "deployment",
        ].includes(k),
    ) ||
    p.version !== 1 ||
    typeof p.publicKey !== "string"
  )
    throw new Error("Unsupported connection profile");
  if (
    !["local", "local-tailnet", "managed", "existing"].includes(p.deployment) ||
    !p.publicKey.trim() ||
    (p.vaultId !== undefined && !/^[0-9a-f-]{36}$/i.test(p.vaultId))
  )
    throw new Error("Invalid connection profile");
  const url = new URL(p.serverUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid server URL");
  return p;
}
