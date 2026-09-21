import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
vi.mock("obsidian", () => ({
  Plugin: class {
    constructor(public app: unknown) {}
    async loadData() {
      return {};
    }
    async saveData(_v: unknown) {}
  },
  PluginSettingTab: class {},
  ItemView: class {},
  Notice: class {},
  TFile: class {},
  Setting: class {},
  normalizePath: (p: string) => p,
  requestUrl: vi.fn(),
}));
import { requestUrl } from "obsidian";
import SupaSyncPlugin from "./main.ts";

it("signs in without enrollment and stores sessions only in SecretStorage across restarts", async () => {
  const secrets = new Map<string, string>();
  const app = {
    secretStorage: {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => secrets.set(id, value),
    },
    vault: { getName: () => "Personal" },
  } as unknown as App;
  let saved: Record<string, unknown> = {
    supabaseUrl: "http://127.0.0.1:8000",
    anonKey: "public-key",
    autoSync: false,
    email: "admin@example.test",
    recoveryKey: "legacy-secret",
  };
  const requests: string[] = [];
  vi.mocked(requestUrl).mockImplementation((options) => {
    const url = typeof options === "string" ? options : options.url;
    requests.push(url);
    const data = url.includes("/token?")
      ? {
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          user: { id: crypto.randomUUID(), email: "admin@example.test" },
        }
      : url.endsWith("/list_vaults")
        ? { vaults: [{ id: "vault", name: "Personal" }] }
        : null;
    const text = data ? JSON.stringify(data) : "";
    const response = {
      status: data ? 200 : 204,
      headers: {},
      arrayBuffer: new TextEncoder().encode(text).buffer,
      text,
      json: data,
    };
    return Object.assign(Promise.resolve(response), {
      arrayBuffer: Promise.resolve(response.arrayBuffer),
      text: Promise.resolve(response.text),
      json: Promise.resolve(data),
    });
  });
  const instantiate = async () => {
    const plugin = new SupaSyncPlugin(app, {} as PluginManifest);
    vi.spyOn(plugin, "loadData").mockImplementation(async () =>
      structuredClone(saved),
    );
    vi.spyOn(plugin, "saveData").mockImplementation(async (value) => {
      saved = structuredClone(value);
    });
    await plugin.loadSettings();
    return plugin;
  };
  const plugin = await instantiate();
  plugin.pendingPassword = "password-secret";
  await plugin.signIn();
  expect(plugin.status).toBe("Connected");
  expect(plugin.settings.vaultId).toBe("vault");
  expect(plugin.pendingPassword).toBe("");
  expect(JSON.stringify(saved)).not.toMatch(
    /password-secret|access-secret|refresh-secret|legacy-secret/,
  );
  expect([...secrets.values()].join()).toContain("refresh-secret");
  const restarted = await instantiate();
  await restarted.connect();
  expect(restarted.status).toBe("Connected");
  expect(requests.filter((x) => x.includes("/token?"))).toHaveLength(1);
  expect(requests.some((x) => /pair|enroll|recovery|daemon/.test(x))).toBe(
    false,
  );
  await restarted.signOut();
  expect([...secrets.values()].every((v) => !v)).toBe(true);
});

it("retains the pending remote vault UUID when settings are reloaded", async () => {
  const plugin = new SupaSyncPlugin({} as App, {} as PluginManifest);
  vi.spyOn(plugin, "loadData").mockResolvedValue({
    pendingVaultId: "stable-create-id",
  });
  vi.spyOn(plugin, "saveData").mockResolvedValue();
  await plugin.loadSettings();
  expect(plugin.settings.pendingVaultId).toBe("stable-create-id");
});
