import {
  ProtocolError,
  envelopeDigest,
  errorFromWire,
  hashMarkdown,
  type ApiOperation,
  type Capabilities,
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

export type WireResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };

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
      body: JSON.stringify({
        protocolVersion: 2,
        operation,
        payload: camelRequest(payload),
      }),
    });
    if (response.status === 401) {
      throw new ProtocolError("AUTH_REQUIRED", "session expired or missing");
    }
    if (response.status === 429) {
      throw new ProtocolError(
        "RATE_LIMITED",
        "the server asked the client to slow down",
      );
    }
    if (response.status >= 500) {
      throw new ProtocolError(
        "RETRYABLE_TRANSPORT",
        `server error ${response.status}`,
      );
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
    });
  }
}

export async function digestMarkdownOrThrow(text: string): Promise<string> {
  return hashMarkdown(text);
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
export {
  assertPublicApiKey,
  backendKeyFromUrl,
  isPublicApiKey,
  looksLikeSecretKey,
  sessionSecretId,
} from "./keys.ts";
export {
  decideVaultSelection,
  vaultAccessible,
  type VaultDecision,
} from "./onboarding.ts";

function camelRequest(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      item,
    ]),
  );
}
export { VaultKeys } from "./vault-keys.ts";
