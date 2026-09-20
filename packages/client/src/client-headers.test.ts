import { describe, expect, it } from "vitest";
import { SupaSyncClient } from "./index.ts";

describe("SupaSyncClient headers", () => {
  it("sends the user JWT as Authorization and the public key as apikey", async () => {
    let captured: Headers | undefined;
    const client = new SupaSyncClient({
      url: "http://127.0.0.1:54321",
      anonKey: "public-anon-key",
      session: { getAccessToken: async () => "user-jwt-token" },
      fetch: async (_input, init) => {
        captured = new Headers(init?.headers);
        return new Response(
          JSON.stringify({ ok: true, data: { vaults: [] } }),
          { status: 200 },
        );
      },
    });
    await client.listVaults();
    expect(captured?.get("Authorization")).toBe("Bearer user-jwt-token");
    expect(captured?.get("apikey")).toBe("public-anon-key");
    expect(captured?.get("apikey")).not.toBe("user-jwt-token");
  });

  it("rejects service-role keys as the public API key", () => {
    expect(
      () =>
        new SupaSyncClient({
          url: "http://127.0.0.1:54321",
          anonKey: "sb_secret_abc",
          session: { getAccessToken: async () => "user-jwt-token" },
          fetch,
        }),
    ).toThrow(/secret|service-role/i);
  });
});
