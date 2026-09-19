/** Real plugin account methods and HTTP adapter against local Supabase.
 * Obsidian's host and disk adapters are simulated; no personal vault is opened.
 */
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { MemoryVault } from "@supasync/sync-core";

const transportPaths = vi.hoisted(() => [] as string[]);

vi.mock("obsidian", () => ({
  Plugin: class { async saveData() {} },
  PluginSettingTab: class {}, Setting: class {}, ItemView: class {}, TFile: class {},
  Notice: class {},
  requestUrl: async (input: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
    transportPaths.push(new URL(input.url).pathname);
    const res = await fetch(input.url, { method: input.method, headers: input.headers, body: input.body });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => { headers[key] = value; });
    return { status: res.status, headers, arrayBuffer: await res.arrayBuffer() };
  },
}));
vi.mock("../../apps/obsidian/src/adapters/indexeddb-store.ts", async () => {
  const { MemoryStore } = await import("@supasync/sync-core");
  const stores = new Map<string, InstanceType<typeof MemoryStore>>();
  return { IndexedDbStore: class {
    constructor(id: string) {
      if (!stores.has(id)) stores.set(id, new MemoryStore());
      return stores.get(id)!;
    }
  } };
});
vi.mock("../../apps/obsidian/src/adapters/obsidian-vault.ts", () => ({
  ObsidianVaultAdapter: class { constructor(app: { testVault: MemoryVault }) { return app.testVault; } },
}));
import SupaSyncPlugin from "../../apps/obsidian/src/main.ts";

const url = "http://127.0.0.1:54321";
const anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

function plugin(email: string) {
  const secrets = new Map<string, string>();
  const vault = new MemoryVault();
  function validateSecretId(id: string): void {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error("Secret ID is invalid. 64 characters max.");
  }
  const app = {
    vault: { getName: () => "supasync-fixture-plugin" }, testVault: vault,
    secretStorage: {
      getSecret: (id: string) => { validateSecretId(id); return secrets.get(id) ?? null; },
      setSecret: (id: string, value: string) => { validateSecretId(id); secrets.set(id, value); },
    },
  } as unknown as App;
  const instance = new SupaSyncPlugin(app, {} as never);
  instance.app = app;
  instance.settings = { supabaseUrl: url, anonKey: anon, email, vaultId: "", deviceLabel: "test", autoSync: true, installationId: crypto.randomUUID() };
  return { instance, vault, secrets };
}

describe("plugin sign-up → auth → ready", () => {
  it("creates an account, syncs a note, signs out and signs in on another installation", async () => {
    const email = `supasync-fixture-plugin-${crypto.randomUUID()}@example.test`;
    const first = plugin(email);
    await first.vault.writeText("Hello.md", "# Hello from the plugin\n");
    await first.vault.writeBytes("attachment.bin", new Uint8Array([0, 1, 2, 255]));
    first.instance.settings.autoSync = false;
    first.instance.pendingPassword = "local-test-password";
    await first.instance.createAccount();
    expect(first.instance.statusLabel(), first.instance.authMessage).toBe("Ready");
    await first.instance.syncNow();
    expect(first.instance.signedInEmail).toBe(email);
    expect(first.instance.statusLabel(), first.instance.authMessage).toBe("Up to date");
    expect(first.instance.settings.vaultId).not.toBe("");
    expect(first.instance.pendingPassword).toBe("");
    expect(JSON.stringify(first.instance.settings)).not.toContain("local-test-password");

    const second = plugin(email);
    second.instance.pendingPassword = "wrong-password";
    await second.instance.signIn();
    expect(second.instance.signedInEmail).toBeNull();
    expect(second.instance.authMessage).toContain("Invalid login credentials");
    expect(second.instance.pendingPassword).toBe("");
    second.instance.pendingPassword = "local-test-password";
    await second.instance.signIn();
    expect(second.instance.statusLabel(), second.instance.authMessage).toBe("Up to date");
    expect(second.instance.settings.vaultId).toBe(first.instance.settings.vaultId);
    expect(await second.vault.readText("Hello.md")).toBe("# Hello from the plugin\n");
    expect(await second.vault.readBytes("attachment.bin")).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(transportPaths.some((path) => path.startsWith("/storage/v1/object/upload/sign/"))).toBe(true);
    expect(transportPaths.some((path) => path.startsWith("/storage/v1/object/sign/"))).toBe(true);
    // Simulate a restart with a persisted session requiring refresh; no password input.
    for (const [id, raw] of second.secrets) {
      second.secrets.set(id, JSON.stringify({ ...JSON.parse(raw), expiresAt: 0 }));
    }
    const resumed = new SupaSyncPlugin(second.instance.app, {} as never);
    resumed.app = second.instance.app;
    resumed.settings = { ...second.instance.settings, autoSync: false };
    await resumed.syncNow();
    expect(resumed.signedInEmail).toBe(email);

    expect(resumed.statusLabel(), resumed.authMessage).toBe("Up to date");
    await first.instance.signOut();
    expect(first.instance.signedInEmail).toBeNull();
    expect([...first.secrets.values()].every((value) => !value)).toBe(true);
    await second.instance.refreshVaults(); // Signing out one installation must not revoke another.
    expect(second.instance.remoteVaults).toHaveLength(1);
    first.instance.pendingPassword = "local-test-password";
    await first.instance.signIn();
    await first.instance.syncNow();
    expect(first.instance.statusLabel(), first.instance.authMessage).toBe("Up to date");
    expect(first.instance.remoteVaults).toHaveLength(1);
    await Promise.all([first.instance.signOut(), second.instance.signOut()]);
  }, 30_000);
});
