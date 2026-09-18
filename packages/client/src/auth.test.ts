import { describe, expect, it } from "vitest";
import { AuthError, PasswordAuth, type SecretStore } from "./index.ts";

class MemorySecrets implements SecretStore {
  map = new Map<string, string>();
  async get(id: string): Promise<string | null> {
    return this.map.get(id) ?? null;
  }
  async set(id: string, value: string): Promise<void> {
    if (!value) this.map.delete(id);
    else this.map.set(id, value);
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

const anon = "anon-public-key";
const url = "http://127.0.0.1:54321";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("PasswordAuth", () => {
  it("signs up and persists a session when confirmation is disabled", async () => {
    const secrets = new MemorySecrets();
    const auth = new PasswordAuth(url, anon, async () =>
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        user: { id: "user-1", email: "new@example.com" },
      }), secrets);
    const result = await auth.signUp("new@example.com", "hunter2");
    expect(result.status).toBe("authenticated");
    if (result.status !== "authenticated") return;
    expect(result.session.email).toBe("new@example.com");
    expect(await auth.getAccessToken()).toBe("access");
    const stored = JSON.parse([...secrets.map.values()][0] ?? "{}") as Record<string, unknown>;
    expect(stored.password).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("hunter2");
  });

  it("does not invent a session when signup requires confirmation", async () => {
    const secrets = new MemorySecrets();
    const auth = new PasswordAuth(url, anon, async () =>
      jsonResponse({
        user: { id: "user-1", email: "new@example.com" },
        session: null,
      }), secrets);
    const result = await auth.signUp("new@example.com", "hunter2");
    expect(result).toEqual({ status: "confirmation_required", email: "new@example.com" });
    expect(await auth.getAccessToken()).toBeNull();
    expect(secrets.map.size).toBe(0);
  });

  it("sends the public API key on signup and does not send the password as a header", async () => {
    let captured: Headers | undefined;
    const auth = new PasswordAuth(
      url,
      anon,
      async (_input, init) => {
        captured = new Headers(init?.headers);
        return jsonResponse({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          user: { id: "user-1", email: "new@example.com" },
        });
      },
      new MemorySecrets(),
    );
    await auth.signUp("new@example.com", "hunter2");
    expect(captured?.get("apikey")).toBe(anon);
    expect(captured?.get("Authorization")).toBeNull();
    expect(JSON.stringify({
      apikey: captured?.get("apikey"),
      authorization: captured?.get("Authorization"),
    })).not.toContain("hunter2");
  });

  it("signs in and persists a session", async () => {
    const secrets = new MemorySecrets();
    const auth = new PasswordAuth(url, anon, async () =>
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        user: { id: "user-1", email: "a@b.c" },
      }), secrets);
    const session = await auth.signIn("a@b.c", "secret");
    expect(session.email).toBe("a@b.c");
    expect(await auth.getAccessToken()).toBe("access");
    expect(JSON.stringify([...secrets.map.values()])).not.toContain("secret");
  });

  it("signs in and surfaces the server error message", async () => {
    const secrets = new MemorySecrets();
    const auth = new PasswordAuth(url, anon, async () =>
      jsonResponse({ msg: "Invalid login credentials" }, 400), secrets);
    await expect(auth.signIn("a@b.c", "nope")).rejects.toBeInstanceOf(AuthError);
    await expect(auth.signIn("a@b.c", "nope")).rejects.toThrow("Invalid login credentials");
  });

  it("refreshes an expired session", async () => {
    const secrets = new MemorySecrets();
    let calls = 0;
    const auth = new PasswordAuth(url, anon, async (input) => {
      calls += 1;
      const href = String(input);
      if (href.includes("grant_type=password")) {
        return jsonResponse({
          access_token: "old",
          refresh_token: "refresh",
          expires_in: 0,
          user: { id: "user-1", email: "a@b.c" },
        });
      }
      expect(href).toContain("grant_type=refresh_token");
      return jsonResponse({
        access_token: "new-access",
        refresh_token: "refresh-2",
        expires_in: 3600,
        user: { id: "user-1", email: "a@b.c" },
      });
    }, secrets);
    await auth.signIn("a@b.c", "secret");
    const token = await auth.getAccessToken();
    expect(token).toBe("new-access");
    expect(calls).toBe(2);
  });

  it("clears the session on sign-out", async () => {
    const secrets = new MemorySecrets();
    const auth = new PasswordAuth(url, anon, async () =>
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        user: { id: "user-1", email: "a@b.c" },
      }), secrets);
    await auth.signIn("a@b.c", "secret");
    await auth.signOut();
    expect(await auth.getAccessToken()).toBeNull();
    expect(secrets.map.size).toBe(0);
  });

  it("rejects service-role keys", () => {
    expect(() => new PasswordAuth(url, "sb_secret_abc", fetch, new MemorySecrets())).toThrow(/secret|service-role/i);
  });
});

describe("session lifecycle", () => {
  const body = (expiresIn = 0) => ({ access_token: "access", refresh_token: "refresh", expires_in: expiresIn, user: { id: "u", email: "a@b.c" } });

  it("shares one refresh across concurrent requests", async () => {
    let refreshes = 0;
    const auth = new PasswordAuth(url, anon, async (input) => {
      if (String(input).includes("refresh_token")) {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse({ ...body(3600), access_token: "rotated" });
      }
      return jsonResponse(body());
    }, new MemorySecrets());
    await auth.signIn("a@b.c", "password");
    expect(await Promise.all(Array.from({ length: 8 }, () => auth.getAccessToken()))).toEqual(Array(8).fill("rotated"));
    expect(refreshes).toBe(1);
  });

  it("clears rejected refresh tokens but retains sessions on a temporary outage", async () => {
    let status = 503;
    const auth = new PasswordAuth(url, anon, async (input) => String(input).includes("refresh_token")
      ? jsonResponse({}, status) : jsonResponse(body()), new MemorySecrets());
    await auth.signIn("a@b.c", "password");
    await expect(auth.getAccessToken()).rejects.toThrow("Check the connection");
    expect(await auth.getSession()).not.toBeNull();
    status = 400;
    expect(await auth.getAccessToken()).toBeNull();
    expect(await auth.getSession()).toBeNull();
  });

  it("revokes only the current session and clears secrets even if offline", async () => {
    const auth = new PasswordAuth(url, anon, async (input, init) => {
      if (String(input).includes("logout")) {
        expect(String(input)).toContain("scope=local");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access");
        throw new Error("offline");
      }
      return jsonResponse(body(3600));
    }, new MemorySecrets());
    await auth.signIn("a@b.c", "password");
    await expect(auth.signOut()).rejects.toThrow("offline");
    expect(await auth.getSession()).toBeNull();
  });

  it("does not restore a session when sign-out overlaps refresh", async () => {
    let finish!: () => void;
    let started!: () => void;
    const refreshing = new Promise<void>((resolve) => { started = resolve; });
    const auth = new PasswordAuth(url, anon, async (input) => {
      if (String(input).includes("refresh_token")) {
        started();
        await new Promise<void>((resolve) => { finish = resolve; });
        return jsonResponse(body(3600));
      }
      if (String(input).includes("logout")) return new Response(null, { status: 204 });
      return jsonResponse(body());
    }, new MemorySecrets());
    await auth.signIn("a@b.c", "password");
    const refresh = auth.getAccessToken();
    await refreshing;
    const logout = auth.signOut();
    expect(await auth.getAccessToken()).toBeNull();
    finish();
    await Promise.all([refresh, logout]);
    expect(await auth.getSession()).toBeNull();
  });

  it("rejects corrupt persisted sessions", async () => {
    const secrets = new MemorySecrets();
    const auth = new PasswordAuth(url, anon, fetch, secrets, "test");
    for (const value of ["null", "{}", '{"accessToken":"a","refreshToken":"r"}', '"bad"']) {
      await secrets.set("test", value);
      expect(await auth.getSession()).toBeNull();
    }
  });
});
