import {
  ProtocolError,
  canonicalizePath,
  envelopeDigest,
  errorFromWire,
  hashMarkdown,
  type ApiOperation,
  type Capabilities,
  type CommitEnvelope,
  type CommitResult,
  type PullPage,
  type SignedTransfer,
  type SnapshotBegin,
  type SnapshotItem,
  type VaultInfo,
} from "@supasync/protocol";
import { assertPublicApiKey } from "./keys.ts";

export type FetchLike = typeof fetch;

export type SessionProvider = {
  getAccessToken(): Promise<string | null>;
};

export type ClientConfig = {
  url: string;
  anonKey: string;
  fetch: FetchLike;
  session: SessionProvider;
  functionName?: string;
};

export type WireResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

export class SupaSyncClient {
  constructor(private readonly config: ClientConfig) {
    assertPublicApiKey(config.anonKey);
  }

  async rpc<T>(operation: ApiOperation | string, payload: unknown): Promise<T> {
    const token = await this.config.session.getAccessToken();
    if (!token) {
      throw new ProtocolError("AUTH_REQUIRED", "sign in to continue");
    }
    const endpoint = `${this.config.url.replace(/\/$/, "")}/functions/v1/${this.config.functionName ?? "supasync-api"}`;
    const response = await this.config.fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: this.config.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation, payload }),
    });
    if (response.status === 401) {
      throw new ProtocolError("AUTH_REQUIRED", "session expired or missing");
    }
    if (response.status === 429) {
      throw new ProtocolError("RATE_LIMITED", "the server asked the client to slow down");
    }
    if (response.status >= 500) {
      throw new ProtocolError("RETRYABLE_TRANSPORT", `server error ${response.status}`);
    }
    const body = (await response.json()) as WireResult<T>;
    if (!body.ok) {
      throw errorFromWire(body.error);
    }
    return body.data;
  }

  capabilities(vaultId: string): Promise<Capabilities> {
    return this.rpc("capabilities", { vault_id: vaultId });
  }

  listVaults(): Promise<{ vaults: VaultInfo[] }> {
    return this.rpc("list_vaults", {});
  }

  createVault(name: string): Promise<{ vault: VaultInfo }> {
    return this.rpc("create_vault", { name });
  }

  registerClient(input: {
    vaultId: string;
    clientId: string;
    label: string;
    platform: string;
    resetGeneration?: boolean;
  }) {
    return this.rpc("register_client", {
      vault_id: input.vaultId,
      client_id: input.clientId,
      label: input.label,
      platform: input.platform,
      reset_generation: input.resetGeneration ?? false,
    });
  }

  async commit(envelope: CommitEnvelope, extras: { pathKey?: string; textSha256?: string } = {}): Promise<CommitResult> {
    const requestDigest = await envelopeDigest(envelope);
    const result = await this.rpc<CommitResult>("commit", {
      envelope: toSnakeEnvelope(envelope),
      request_digest: requestDigest,
      path_key: extras.pathKey ?? (typeof envelope.payload.path === "string" ? canonicalizePath(envelope.payload.path).pathKey : undefined),
      text_sha256: extras.textSha256,
    });
    return result;
  }

  pullChanges(input: { vaultId: string; afterSeq: string; ceiling?: string; limit?: number }): Promise<PullPage> {
    return this.rpc("pull_changes", {
      vault_id: input.vaultId,
      after_seq: input.afterSeq,
      ceiling: input.ceiling,
      limit: input.limit,
    });
  }

  beginSnapshot(input: { vaultId: string; clientId: string; clientGeneration: number }): Promise<SnapshotBegin> {
    return this.rpc("begin_snapshot", {
      vault_id: input.vaultId,
      client_id: input.clientId,
      client_generation: input.clientGeneration,
    });
  }

  listSnapshot(input: { snapshotId: string; afterEntryId?: string; limit?: number }): Promise<{ items: SnapshotItem[]; nextCursor: string | null; exhausted: boolean }> {
    return this.rpc("list_snapshot", {
      snapshot_id: input.snapshotId,
      after_entry_id: input.afterEntryId,
      limit: input.limit,
    });
  }

  getBodies(vaultId: string, sha256s: string[]): Promise<{ bodies: Array<{ sha256: string; text: string; byteLength: number }> }> {
    return this.rpc("get_bodies", { vault_id: vaultId, sha256s });
  }

  ackApplied(input: { vaultId: string; clientId: string; clientGeneration: number; appliedSeq: string }) {
    return this.rpc("ack_applied", {
      vault_id: input.vaultId,
      client_id: input.clientId,
      client_generation: input.clientGeneration,
      applied_seq: input.appliedSeq,
    });
  }

  async beginBlobUpload(input: {
    vaultId: string;
    expectedSha256: string;
    expectedLength: number;
    mimeHint?: string;
  }): Promise<{ blobId: string; stagingKey: string; transfer?: SignedTransfer } & Record<string, unknown>> {
    const result = await this.rpc<{ blobId: string; stagingKey: string; transfer?: SignedTransfer } & Record<string, unknown>>("begin_blob_upload", {
      vault_id: input.vaultId,
      expected_sha256: input.expectedSha256,
      expected_length: input.expectedLength,
      mime_hint: input.mimeHint,
    });
    if (result.transfer) result.transfer = this.reachableTransfer(result.transfer);
    return result;
  }

  finalizeBlob(input: { vaultId: string; blobId: string }): Promise<{ blobId: string; state: string }> {
    return this.rpc("finalize_blob", { vault_id: input.vaultId, blob_id: input.blobId });
  }

  async getBlobDownload(input: { vaultId: string; blobId: string }): Promise<{ transfer: SignedTransfer; verifiedSha256: string; verifiedLength: number }> {
    const result = await this.rpc<{ transfer: SignedTransfer; verifiedSha256: string; verifiedLength: number }>("get_blob_download", { vault_id: input.vaultId, blob_id: input.blobId });
    return { ...result, transfer: this.reachableTransfer(result.transfer) };
  }

  private reachableTransfer(transfer: SignedTransfer): SignedTransfer {
    const url = new URL(transfer.url);
    // Local Edge Functions sign with their Docker-internal Supabase URL.
    // Supabase Storage signs the path/token, so its public API origin can be used.
    // Leave hosted Storage and external providers (including R2) untouched.
    if (url.origin === "http://kong:8000" && url.pathname.startsWith("/storage/v1/")) {
      const backend = new URL(this.config.url);
      url.protocol = backend.protocol;
      url.host = backend.host;
      return { ...transfer, url: url.toString() };
    }
    return transfer;
  }

  listHistory(vaultId: string, entryId: string) {
    return this.rpc("list_history", { vault_id: vaultId, entry_id: entryId });
  }

  renameTree(input: Record<string, unknown>) {
    return this.rpc("rename_tree", input);
  }

  deleteTree(input: Record<string, unknown>) {
    return this.rpc("delete_tree", input);
  }

  addMember(input: { vaultId: string; userId: string; role: string }) {
    return this.rpc("add_member", { vault_id: input.vaultId, user_id: input.userId, role: input.role });
  }
}

export async function digestMarkdownOrThrow(text: string): Promise<string> {
  return hashMarkdown(text);
}

function toSnakeEnvelope(envelope: CommitEnvelope): Record<string, unknown> {
  return {
    protocol_version: envelope.protocolVersion,
    server_epoch: envelope.serverEpoch,
    vault_id: envelope.vaultId,
    client_id: envelope.clientId,
    client_generation: envelope.clientGeneration,
    operation_id: envelope.operationId,
    type: envelope.type,
    entry_id: envelope.entryId,
    base_revision_id: envelope.baseRevisionId,
    payload: envelope.payload,
  };
}

export { envelopeDigest };
export type { VaultInfo };
export {
  AuthError,
  PasswordAuth,
  type SecretStore,
  type SignUpResult,
  type StoredSession,
} from "./auth.ts";
export { assertPublicApiKey, backendKeyFromUrl, isPublicApiKey, looksLikeSecretKey, sessionSecretId } from "./keys.ts";
export { decideVaultSelection, vaultAccessible, type VaultDecision } from "./onboarding.ts";
