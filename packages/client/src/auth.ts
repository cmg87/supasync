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
    if (this.secrets.delete) {
      await this.secrets.delete(this.secretId);
      return;
    }
    await this.secrets.set(this.secretId, "");
  }

  async getSession(): Promise<StoredSession | null> {
    const raw = await this.secrets.get(this.secretId);
    if (!raw) return null;
    try {
      const session = JSON.parse(raw) as StoredSession;
      if (!session.accessToken || !session.refreshToken) return null;
      return session;
    } catch {
      return null;
    }
  }

  async getAccessToken(): Promise<string | null> {
    const session = await this.getSession();
    if (!session) return null;
    if (Date.now() < session.expiresAt - 30_000) return session.accessToken;
    return this.refresh(session);
  }

  private async refresh(session: StoredSession): Promise<string | null> {
    const res = await this.fetchImpl(`${this.authUrl()}/token?grant_type=refresh_token`, {
      method: "POST",
      headers: this.publicHeaders(),
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) return null;
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
      Authorization: `Bearer ${this.anonKey}`,
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
