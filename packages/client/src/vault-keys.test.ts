import { it, expect } from "vitest";
import { VaultKeys } from "./vault-keys.ts";
it("retries a lost provisioning response with the same vault ID, ciphertext and recovery secret", async () => {
  const values = new Map<string, string>();
  const secrets = {
    get: async (k: string) => values.get(k) ?? null,
    set: async (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const keys = new VaultKeys(secrets, "http://localhost", "installation");
  let saved: unknown;
  await expect(
    keys.create("test", async (p) => {
      saved = p;
      throw new Error("lost");
    }),
  ).rejects.toThrow("lost");
  const reopened = new VaultKeys(secrets, "http://localhost", "installation");
  await reopened.create("test", async (p) => {
    expect(p).toEqual(saved);
    return p;
  });
  const id = (saved as { vaultId: string }).vaultId;
  expect(await reopened.get(id)).toBeNull();
  expect(await reopened.pendingRecovery(id)).toMatch(/^ssr1-/);
});
