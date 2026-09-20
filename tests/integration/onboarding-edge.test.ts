/**
 * Exercises the same Edge Function path the plugin uses.
 * Integration tests create local fixture users/vaults named `supasync-fixture-*`.
 * Those rows are actor-scoped and never appear in another user's listVaults().
 */
import { describe, expect, it } from "vitest";
import { PasswordAuth, SupaSyncClient, VaultKeys, type SecretStore } from "@supasync/client";
import { ProtocolError } from "@supasync/protocol";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const anon =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

class MemorySecrets implements SecretStore {
  map = new Map<string, string>();
  async get(id: string) {
    return this.map.get(id) ?? null;
  }
  async set(id: string, value: string) {
    if (!value) this.map.delete(id);
    else this.map.set(id, value);
  }
  async delete(id: string) {
    this.map.delete(id);
  }
}

describe("plugin onboarding through supasync-api", () => {
  it("signs up, lists zero vaults, creates one, and registers a client", async () => {
    const email = `supasync-fixture-onboard-${Date.now()}@example.test`;
    const password = "test-password-onboard";
    const otherEmail = `supasync-fixture-onboard-other-${Date.now()}@example.test`;
    const ownerSecrets = new MemorySecrets();
    const ownerAuth = new PasswordAuth(url, anon, fetch, ownerSecrets);
    const signup = await ownerAuth.signUp(email, password);
    expect(signup.status).toBe("authenticated");

    const owner = new SupaSyncClient({ url, anonKey: anon, fetch, session: ownerAuth });
    expect((await owner.listVaults()).vaults).toEqual([]);
    const keys = new VaultKeys(ownerSecrets, url, crypto.randomUUID());
    const plan = await keys.prepare(crypto.randomUUID(), `supasync-fixture-${Date.now()}`);
    const created = await owner.rpc<{vault: {id:string;role:string}}>("create_vault", plan);
    expect(created.vault.role).toBe("owner");
    const listed = await owner.listVaults();
    expect(listed.vaults.map((vault) => vault.id)).toContain(created.vault.id);

    const registered = await owner.registerClient({
      vaultId: created.vault.id,
      clientId: crypto.randomUUID(),
      label: "fixture",
      platform: "test",
    });
    expect(registered).toMatchObject({ vaultId: created.vault.id, generation: 1 });

    const otherAuth = new PasswordAuth(url, anon, fetch, new MemorySecrets());
    await otherAuth.signUp(otherEmail, password);
    const other = new SupaSyncClient({ url, anonKey: anon, fetch, session: otherAuth });
    const outsiderVaults = await other.listVaults();
    expect(outsiderVaults.vaults.map((vault) => vault.id)).not.toContain(created.vault.id);
    await expect(
      other.registerClient({
        vaultId: created.vault.id,
        clientId: crypto.randomUUID(),
        label: "outsider",
        platform: "test",
      }),
    ).rejects.toBeInstanceOf(ProtocolError);
  }, 30_000);
});
