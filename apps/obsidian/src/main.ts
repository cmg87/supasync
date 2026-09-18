import { Notice, Plugin, TFile } from "obsidian";
import { PasswordAuth, SupaSyncClient } from "@supasync/client";
import { DEFAULT_LIMITS, PLUGIN_ID } from "@supasync/protocol";
import { SyncEngine, type SyncReport } from "@supasync/sync-core";
import { createObsidianFetch } from "./adapters/obsidian-fetch.ts";
import { IndexedDbStore } from "./adapters/indexeddb-store.ts";
import { ObsidianVaultAdapter } from "./adapters/obsidian-vault.ts";
import { SupaSyncSettingTab } from "./settings/tab.ts";
import { CONFLICT_VIEW, ConflictView, HISTORY_VIEW, HistoryView, STATUS_VIEW, StatusView } from "./ui/views.ts";

export interface SupaSyncSettings {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  vaultId: string;
  deviceLabel: string;
  autoSync: boolean;
}

const DEFAULT_SETTINGS: SupaSyncSettings = {
  supabaseUrl: "",
  anonKey: "",
  email: "",
  vaultId: "",
  deviceLabel: "obsidian",
  autoSync: true,
};

export default class SupaSyncPlugin extends Plugin {
  override settings: SupaSyncSettings = DEFAULT_SETTINGS;
  pendingPassword = "";
  private engine?: SyncEngine;
  private paused = false;
  private lastReport: SyncReport = { pulled: 0, pushed: 0, conflicts: 0, applied: 0, errors: [] };
  private lastStatus = "idle";
  private debounceTimer?: number;
  private pollTimer?: number;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SupaSyncSettingTab(this.app, this));
    this.addRibbonIcon("sync", "SupaSync: sync now", () => {
      void this.syncNow();
    });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addCommand({
      id: "pause",
      name: "Pause/resume",
      callback: () => {
        this.paused = !this.paused;
        this.engine?.[this.paused ? "pause" : "resume"]();
        new Notice(this.paused ? "SupaSync paused" : "SupaSync resumed");
      },
    });
    this.addCommand({
      id: "show-status",
      name: "Show status",
      callback: () => void this.app.workspace.getRightLeaf(false)?.setViewState({ type: STATUS_VIEW, active: true }),
    });
    this.addCommand({
      id: "show-conflicts",
      name: "Show conflicts",
      callback: () => void this.app.workspace.getRightLeaf(false)?.setViewState({ type: CONFLICT_VIEW, active: true }),
    });
    this.addCommand({
      id: "show-history",
      name: "Show history/restore",
      callback: () => void this.app.workspace.getRightLeaf(false)?.setViewState({ type: HISTORY_VIEW, active: true }),
    });
    this.addCommand({ id: "rebuild-index", name: "Reconcile/rebuild local index", callback: () => void this.rebuild() });
    this.addCommand({
      id: "export-diagnostics",
      name: "Export redacted diagnostics",
      callback: () => void this.exportDiagnostics(),
    });
    this.addCommand({ id: "sign-out", name: "Sign out/disconnect", callback: () => void this.signOut() });

    this.registerView(STATUS_VIEW, (leaf) => new StatusView(leaf, () => this.statusText()));
    this.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf, () => this.conflictText()));
    this.registerView(HISTORY_VIEW, (leaf) => new HistoryView(leaf, () => this.historyText()));

    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultEvent(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultEvent(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultEvent(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, old) => this.onVaultEvent(file.path, old)));

    this.app.workspace.onLayoutReady(() => {
      void this.boot();
    });
    this.registerInterval(
      window.setInterval(() => {
        if (document.visibilityState === "visible" && this.settings.autoSync && !this.paused) void this.syncNow();
      }, DEFAULT_LIMITS.pollIntervalMs),
    );
  }

  override onunload(): void {
    window.clearTimeout(this.debounceTimer);
    window.clearInterval(this.pollTimer);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async signIn(): Promise<void> {
    if (this.settings.anonKey.includes("service_role")) {
      new Notice("Service-role keys are not allowed in the plugin.");
      return;
    }
    const auth = this.auth();
    await auth.signIn(this.settings.email, this.pendingPassword);
    this.pendingPassword = "";
    new Notice("Signed in to SupaSync");
    await this.boot();
  }

  async signOut(): Promise<void> {
    await this.auth().signOut();
    this.engine = undefined;
    this.lastStatus = "signed out";
    new Notice("SupaSync signed out. Local files were not deleted.");
  }

  async syncNow(): Promise<void> {
    if (!this.engine) await this.boot();
    if (!this.engine || this.paused) return;
    try {
      this.lastStatus = "syncing";
      this.lastReport = await this.engine.cycle();
      this.lastStatus = this.lastReport.errors.length ? "error" : "ok";
      if (this.lastReport.conflicts) new Notice(`SupaSync preserved ${this.lastReport.conflicts} conflict cop${this.lastReport.conflicts === 1 ? "y" : "ies"}`);
    } catch (error) {
      this.lastStatus = "error";
      this.lastReport.errors.push(error instanceof Error ? error.message : String(error));
      new Notice(`SupaSync: ${this.lastReport.errors.at(-1)}`);
    }
  }

  private async boot(): Promise<void> {
    if (!this.settings.supabaseUrl || !this.settings.anonKey || !this.settings.vaultId) {
      this.lastStatus = "needs setup";
      return;
    }
    const fetchImpl = createObsidianFetch();
    const auth = this.auth(fetchImpl);
    const token = await auth.getAccessToken();
    if (!token) {
      this.lastStatus = "needs sign-in";
      return;
    }
    const client = new SupaSyncClient({ url: this.settings.supabaseUrl, fetch: fetchImpl, session: auth });
    const store = new IndexedDbStore(`${PLUGIN_ID}:${this.app.vault.getName()}`);
    const meta = await store.getMeta();
    meta.label = this.settings.deviceLabel || "obsidian";
    meta.platform = "obsidian";
    meta.vaultId = this.settings.vaultId;
    await store.putMeta(meta);
    await client.registerClient({
      vaultId: this.settings.vaultId,
      clientId: meta.clientId,
      label: meta.label,
      platform: meta.platform,
    });
    this.engine = new SyncEngine({
      api: client,
      vault: new ObsidianVaultAdapter(this.app),
      store,
      vaultId: this.settings.vaultId,
    });
    await this.syncNow();
  }

  private auth(fetchImpl = createObsidianFetch()): PasswordAuth {
    return new PasswordAuth(this.settings.supabaseUrl, this.settings.anonKey, fetchImpl, {
      get: async (id) => this.app.secretStorage.getSecret(id),
      set: async (id, value) => {
        this.app.secretStorage.setSecret(id, value);
      },
    });
  }

  private onVaultEvent(path: string, _old?: string): void {
    if (!this.settings.autoSync || this.paused) return;
    if (this.engine?.matchesEcho(path, null, null)) return;
    window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.syncNow(), DEFAULT_LIMITS.debounceMs);
  }

  private async rebuild(): Promise<void> {
    const store = new IndexedDbStore(`${PLUGIN_ID}:${this.app.vault.getName()}`);
    const meta = await store.getMeta();
    meta.receivedCursor = "0";
    meta.appliedCursor = "0";
    await store.putMeta(meta);
    new Notice("Local index marked for rebuild. Syncing…");
    await this.syncNow();
  }

  private async exportDiagnostics(): Promise<void> {
    const body = JSON.stringify(
      {
        status: this.lastStatus,
        report: this.lastReport,
        vaultId: this.settings.vaultId ? "set" : "missing",
        urlHost: this.settings.supabaseUrl,
      },
      null,
      2,
    );
    const file = this.app.vault.getAbstractFileByPath("supasync-diagnostics.json");
    if (file instanceof TFile) await this.app.vault.modify(file, body);
    else await this.app.vault.create("supasync-diagnostics.json", body);
    new Notice("Wrote supasync-diagnostics.json");
  }

  private statusText(): string {
    return JSON.stringify({ status: this.lastStatus, paused: this.paused, report: this.lastReport }, null, 2);
  }

  private conflictText(): string {
    return this.lastReport.conflicts ? `${this.lastReport.conflicts} conflict copies were preserved.` : "";
  }

  private historyText(): string {
    const file = this.app.workspace.getActiveFile();
    return file ? `Active file: ${file.path}\nUse the CLI list-history API or conflict copies for restore.` : "";
  }
}
