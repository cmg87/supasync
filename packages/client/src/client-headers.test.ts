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
        return new Response(JSON.stringify({ ok: true, data: { vaults: [] } }), { status: 200 });
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

describe("local storage transfer URLs", () => {
  it("uses the configured API origin for Docker-internal upload and download URLs", async () => {
    const internal = "http://kong:8000/storage/v1/object/upload/sign/bucket/file?token=opaque%2Btoken";
    const client = new SupaSyncClient({
      url: "http://127.0.0.1:54321", anonKey: "public", session: { getAccessToken: async () => "jwt" },
      fetch: async () => new Response(JSON.stringify({ ok: true, data: { blobId: "blob", transfer: { url: internal, method: "PUT", headers: {} } } })),
    });
    const upload = await client.beginBlobUpload({ vaultId: "vault", expectedLength: 4, expectedSha256: "hash" });
    const download = await client.getBlobDownload({ vaultId: "vault", blobId: "blob" });
    expect(upload.transfer?.url).toBe(internal.replace("http://kong:8000", "http://127.0.0.1:54321"));
    expect(download.transfer.url).toBe(upload.transfer?.url);
  });

  it("does not rewrite external signed URLs", async () => {
    const external = "https://account.r2.cloudflarestorage.com/bucket/file?X-Amz-Signature=opaque";
    const client = new SupaSyncClient({
      url: "http://127.0.0.1:54321", anonKey: "public", session: { getAccessToken: async () => "jwt" },
      fetch: async () => new Response(JSON.stringify({ ok: true, data: { transfer: { url: external, method: "GET", headers: {} } } })),
    });
    expect((await client.getBlobDownload({ vaultId: "vault", blobId: "blob" })).transfer.url).toBe(external);
  });
});
