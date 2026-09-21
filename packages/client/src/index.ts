import {
  ProtocolError,
  errorFromWire,
  type Capabilities,
  type VaultInfo,
} from "@supasync/protocol";
import { assertPublicApiKey } from "./keys.ts";
export type FetchLike = typeof fetch;
export type SessionProvider = { getAccessToken(): Promise<string | null> };
export type ClientConfig = {
  url: string;
  anonKey: string;
  fetch: FetchLike;
  session: SessionProvider;
};
export class SupaSyncClient {
  constructor(readonly config: ClientConfig) {
    assertPublicApiKey(config.anonKey);
    const url = new URL(config.url);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("HTTPS_REQUIRED");
  }
  async rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const token = await this.config.session.getAccessToken();
    if (!token) throw new ProtocolError("AUTH_REQUIRED", "Sign in to continue");
    const response = await this.config.fetch(
      `${this.config.url.replace(/\/$/, "")}/rest/v1/rpc/${name}`,
      {
        method: "POST",
        headers: {
          apikey: this.config.anonKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Profile": "supasync",
          "Accept-Profile": "supasync",
        },
        body: JSON.stringify(args),
      },
    );
    if (response.status === 401)
      throw new ProtocolError("AUTH_REQUIRED", "Session expired");
    if (response.status === 429)
      throw new ProtocolError("RATE_LIMITED", "Retry later");
    if (response.status >= 500)
      throw new ProtocolError("RETRYABLE_TRANSPORT", "Backend unavailable");
    const body = await response.json();
    if (!response.ok)
      throw errorFromWire({
        code: body.message ?? "INVALID_REQUEST",
        message: body.message ?? "Request failed",
      });
    return body as T;
  }
  capabilities(vaultId?: string): Promise<Capabilities> {
    return this.rpc("capabilities", { p_vault_id: vaultId });
  }
  listVaults(): Promise<{ vaults: VaultInfo[] }> {
    return this.rpc("list_vaults");
  }
  createVault(id: string, name: string): Promise<{ vault: VaultInfo }> {
    return this.rpc("create_vault", { p_id: id, p_name: name });
  }
  async binary(
    action: "upload" | "finalize" | "download",
    id: string,
    token?: string,
  ): Promise<{ url: string; method: string; headers: Record<string, string> }> {
    const access = await this.config.session.getAccessToken();
    const response = await this.config.fetch(
      `${this.config.url.replace(/\/$/, "")}/functions/v1/supasync-binary`,
      {
        method: "POST",
        headers: {
          apikey: this.config.anonKey,
          ...(access ? { Authorization: `Bearer ${access}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action, id, token }),
      },
    );
    if (!response.ok)
      throw new Error(`Binary transfer failed (${response.status})`);
    const result = await response.json();
    if (result.url?.startsWith("/"))
      result.url = this.config.url.replace(/\/$/, "") + result.url;
    return result;
  }
}
export { envelopeDigest } from "@supasync/protocol";
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
