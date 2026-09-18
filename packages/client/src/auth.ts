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

export class PasswordAuth {
  constructor(
    private readonly url: string,
    private readonly anonKey: string,
    private readonly fetchImpl: typeof fetch,
    private readonly secrets: SecretStore,
    private readonly secretId = "supasync-session",
  ) {}

  async signIn(email: string, password: string): Promise<StoredSession> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      throw new Error("sign-in failed");
    }
    const body = await res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      user: { id: string; email?: string };
    };
    const session: StoredSession = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
      userId: body.user.id,
      email: body.user.email ?? email,
    };
    await this.secrets.set(this.secretId, JSON.stringify(session));
    return session;
  }

  async signOut(): Promise<void> {
    await this.secrets.set(this.secretId, "");
  }

  async getAccessToken(): Promise<string | null> {
    const raw = await this.secrets.get(this.secretId);
    if (!raw) return null;
    let session: StoredSession;
    try {
      session = JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
    if (!session.accessToken) return null;
    if (Date.now() < session.expiresAt - 30_000) return session.accessToken;
    return this.refresh(session);
  }

  private async refresh(session: StoredSession): Promise<string | null> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, "")}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) return null;
    const body = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    session.accessToken = body.access_token;
    session.refreshToken = body.refresh_token ?? session.refreshToken;
    session.expiresAt = Date.now() + body.expires_in * 1000;
    await this.secrets.set(this.secretId, JSON.stringify(session));
    return session.accessToken;
  }
}
