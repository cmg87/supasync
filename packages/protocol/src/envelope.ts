import { PROTOCOL_VERSION } from "./constants.ts";
import { digestCanonical } from "./hash.ts";
import { ProtocolError } from "./errors.ts";
import type { CommitEnvelope, MutationType } from "./types.ts";

const MUTATION_TYPES: MutationType[] = [
  "create",
  "update",
  "delete",
  "rename",
  "convert_kind",
  "create_conflict_copy",
  "resolve_conflict",
  "restore_revision",
];

export function assertEnvelope(value: unknown): CommitEnvelope {
  if (!value || typeof value !== "object") {
    throw new ProtocolError("UNAVAILABLE", "operation envelope is missing");
  }
  const env = value as Record<string, unknown>;
  const type = env.type;
  if (typeof type !== "string" || !MUTATION_TYPES.includes(type as MutationType)) {
    throw new ProtocolError("UNAVAILABLE", "operation type is invalid");
  }
  if (env.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError("PROTOCOL_UPGRADE_REQUIRED", "client protocol is not supported", {
      protocolVersion: env.protocolVersion,
    });
  }
  for (const key of ["serverEpoch", "vaultId", "clientId", "operationId"] as const) {
    if (typeof env[key] !== "string" || env[key] === "") {
      throw new ProtocolError("UNAVAILABLE", `envelope field ${key} is required`);
    }
  }
  if (typeof env.clientGeneration !== "number" || env.clientGeneration < 1) {
    throw new ProtocolError("CLIENT_GENERATION_EXPIRED", "client generation is invalid");
  }
  if (env.payload === null || typeof env.payload !== "object" || Array.isArray(env.payload)) {
    throw new ProtocolError("UNAVAILABLE", "envelope payload must be an object");
  }
  return env as unknown as CommitEnvelope;
}

export async function envelopeDigest(envelope: CommitEnvelope): Promise<string> {
  return digestCanonical({
    protocolVersion: envelope.protocolVersion,
    serverEpoch: envelope.serverEpoch,
    vaultId: envelope.vaultId,
    clientId: envelope.clientId,
    clientGeneration: envelope.clientGeneration,
    operationId: envelope.operationId,
    type: envelope.type,
    entryId: envelope.entryId ?? null,
    baseRevisionId: envelope.baseRevisionId ?? null,
    payload: envelope.payload,
  });
}

export function createEnvelope(input: Omit<CommitEnvelope, "protocolVersion">): CommitEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    ...input,
  };
}
