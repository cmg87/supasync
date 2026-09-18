import { describe, expect, it } from "vitest";
import { sessionSecretId } from "@supasync/client";
import { syncStoreId } from "./sync-state.ts";

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
