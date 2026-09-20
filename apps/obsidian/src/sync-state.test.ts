import { describe, expect, it } from "vitest";
import { sessionSecretId } from "@supasync/client";
import { installationSessionSecretId, syncStoreId } from "./sync-state.ts";

describe("sync state isolation", () => {
  it("namespaces session secrets by backend host", () => {
    expect(sessionSecretId("http://127.0.0.1:54321")).not.toBe(sessionSecretId("https://abc.supabase.co"));
  });

  it("does not reuse IndexedDB names across remote vaults", () => {
    const installationId = "11111111-1111-1111-1111-111111111111";
    const backendUrl = "http://127.0.0.1:54321";
    const storeA = syncStoreId({ installationId, backendUrl, vaultId: "vault-a" });
    const storeB = syncStoreId({ installationId, backendUrl, vaultId: "vault-b" });
    expect(storeA).not.toBe(storeB);
    expect(storeA).toContain("vault-a");
    expect(storeB).toContain("vault-b");
  });
});

describe("Obsidian session secret IDs", () => {
  it("fits the host API for local and long hosted URLs with UUID installations", async () => {
    for (const url of ["http://127.0.0.1:54321", "https://abcdefghijklmnopqrst.supabase.co", `https://${"a".repeat(63)}.example.com`]) {
      const id = await installationSessionSecretId(url, "11111111-1111-1111-1111-111111111111");
      expect(id).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(await installationSessionSecretId(`${url}/`, "11111111-1111-1111-1111-111111111111")).toBe(id);
    }
  });

  it("preserves backend and installation isolation without truncating their differences", async () => {
    const host = `https://${"a".repeat(63)}`;
    const installation = "11111111-1111-1111-1111-111111111111";
    const ids = await Promise.all([
      installationSessionSecretId(`${host}.one.test`, installation),
      installationSessionSecretId(`${host}.two.test`, installation),
      installationSessionSecretId(`${host}.one.test`, `${installation.slice(0, -1)}2`),
    ]);
    expect(new Set(ids).size).toBe(3);
  });
});
