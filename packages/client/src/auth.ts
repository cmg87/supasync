import { AuthError, assertPublicApiKey, sessionSecretId } from "./keys.ts";

export type StoredSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  email: string;
};

export type SecretStore = {
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
  delete?(id: string): Promise<void>;
};

export type SignUpResult =
  | { status: "authenticated"; session: StoredSession }
  | { status: "confirmation_required"; email: string };

export { AuthError } from "./keys.ts";

export class PasswordAuth {
  private readonly secretId: string;
  private refreshing?: Promise<string | null>;
  private signingOut = false;

  constructor(
    private readonly url: string,
    private readonly anonKey: string,
    private readonly fetchImpl: typeof fetch,
    private readonly secrets: SecretStore,
    secretId?: string,
  ) {
    assertPublicApiKey(anonKey);
    this.secretId = secretId ?? sessionSecretId(url);
  }

  async signUp(email: string, password: string): Promise<SignUpResult> {
    const res = await this.fetchImpl(`${this.authUrl()}/signup`, {
      method: "POST",
      headers: this.publicHeaders(),
      body: JSON.stringify({ email, password }),
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw new AuthError(messageFromAuthBody(body, "Could not create the account"), res.status);
    }
    const session = sessionFromAuthBody(body, email);
    if (!session) {
      return { status: "confirmation_required", email };
    }
    await this.persist(session);
    return { status: "authenticated", session };
  }

  async signIn(email: string, password: string): Promise<StoredSession> {
    const res = await this.fetchImpl(`${this.authUrl()}/token?grant_type=password`, {
      method: "POST",
      headers: this.publicHeaders(),
      body: JSON.stringify({ email, password }),
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw new AuthError(messageFromAuthBody(body, "Could not sign in"), res.status);
    }
    const session = sessionFromAuthBody(body, email);
    if (!session) {
      throw new AuthError("Sign-in did not return a session");
    }
    await this.persist(session);
    return session;
  }

  async signOut(): Promise<void> {
    this.signingOut = true;
    try {
      // Finish token rotation before revoking the current session.
      await this.refreshing?.catch(() => null);
      const session = await this.getSession();
      if (session) {
        const res = await this.fetchImpl(`${this.authUrl()}/logout?scope=local`, {
          method: "POST",
          headers: { ...this.publicHeaders(), Authorization: `Bearer ${session.accessToken}` },
        });
        if (!res.ok && res.status !== 401 && res.status !== 403 && res.status !== 404) {
          throw new AuthError("Signed out locally. Server session revocation could not be confirmed.", res.status);
        }
      }
    } finally {
      await this.clearSession();
      this.signingOut = false;
    }
  }

  private async clearSession(): Promise<void> {
    if (this.secrets.delete) await this.secrets.delete(this.secretId);
    else await this.secrets.set(this.secretId, "");
  }

  async getSession(): Promise<StoredSession | null> {
    const raw = await this.secrets.get(this.secretId);
    if (!raw) return null;
    try {
      const session = JSON.parse(raw) as StoredSession;
      if (typeof session?.accessToken !== "string" || !session.accessToken ||
          typeof session.refreshToken !== "string" || !session.refreshToken ||
          typeof session.expiresAt !== "number" || !Number.isFinite(session.expiresAt) ||
          typeof session.userId !== "string" || typeof session.email !== "string") return null;
      return session;
    } catch {
      return null;
    }
  }

  async getAccessToken(): Promise<string | null> {
    if (this.signingOut) return null;
    const session = await this.getSession();
    if (!session || this.signingOut) return null;
    if (Date.now() < session.expiresAt - 30_000) return session.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.refresh(session).finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  private async refresh(session: StoredSession): Promise<string | null> {
    const res = await this.fetchImpl(`${this.authUrl()}/token?grant_type=refresh_token`, {
      method: "POST",
      headers: this.publicHeaders(),
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        await this.clearSession();
        return null;
      }
      throw new AuthError("Could not refresh your session. Check the connection and try again.", res.status);
    }
    const body = await readJson(res);
    const next = sessionFromAuthBody(body, session.email);
    if (!next) return null;
    next.userId = next.userId || session.userId;
    next.email = next.email || session.email;
    await this.persist(next);
    return next.accessToken;
  }

  private async persist(session: StoredSession): Promise<void> {
    const stored: StoredSession = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      userId: session.userId,
      email: session.email,
    };
    await this.secrets.set(this.secretId, JSON.stringify(stored));
  }

  private authUrl(): string {
    return `${this.url.replace(/\/$/, "")}/auth/v1`;
  }

  private publicHeaders(): Record<string, string> {
    return {
      apikey: this.anonKey,
      "Content-Type": "application/json",
    };
  }
}

function sessionFromAuthBody(body: unknown, fallbackEmail: string): StoredSession | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  const nested = rec.session && typeof rec.session === "object" ? (rec.session as Record<string, unknown>) : rec;
  const accessToken = str(nested.access_token);
  const refreshToken = str(nested.refresh_token);
  if (!accessToken || !refreshToken) return null;
  const user = (nested.user ?? rec.user ?? rec) as Record<string, unknown>;
  return {
    accessToken,
    refreshToken,
    expiresAt: expiryFromAuthBody(nested),
    userId: str(user.id) ?? "",
    email: str(user.email) ?? fallbackEmail,
  };
}

function expiryFromAuthBody(body: Record<string, unknown>): number {
  if (typeof body.expires_at === "number" && Number.isFinite(body.expires_at)) return body.expires_at * 1000;
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return Date.now() + expiresIn * 1000;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messageFromAuthBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const rec = body as Record<string, unknown>;
  for (const key of ["msg", "message", "error_description", "error"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim() && !looksLikeToken(value)) {
      return value.trim();
    }
  }
  return fallback;
}

function looksLikeToken(value: string): boolean {
  return value.length > 80 || value.startsWith("eyJ");
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export { assertPublicApiKey, sessionSecretId };
