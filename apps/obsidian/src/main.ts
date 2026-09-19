import { Notice, Plugin, TFile } from "obsidian";
import {
  AuthError,
  PasswordAuth,
  SupaSyncClient,
  assertPublicApiKey,
  decideVaultSelection,
  looksLikeSecretKey,
  type StoredSession,
  type VaultInfo,
} from "@supasync/client";
import { DEFAULT_LIMITS, PLUGIN_ID } from "@supasync/protocol";
import { SyncEngine, type SyncReport } from "@supasync/sync-core";
import { createObsidianFetch } from "./adapters/obsidian-fetch.ts";
import { IndexedDbStore } from "./adapters/indexeddb-store.ts";
import { ObsidianVaultAdapter } from "./adapters/obsidian-vault.ts";
import { SupaSyncSettingTab } from "./settings/tab.ts";
import { installationSessionSecretId, newInstallationId, syncStoreId } from "./sync-state.ts";
import { CONFLICT_VIEW, ConflictView, HISTORY_VIEW, HistoryView, STATUS_VIEW, StatusView } from "./ui/views.ts";

export interface SupaSyncSettings {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  vaultId: string;
  deviceLabel: string;
  autoSync: boolean;
  installationId: string;
}

const DEFAULT_SETTINGS: SupaSyncSettings = {
  supabaseUrl: "",
  anonKey: "",
  email: "",
  vaultId: "",
  deviceLabel: "obsidian",
  autoSync: true,
  installationId: "",
};

export default class SupaSyncPlugin extends Plugin {
  override settings: SupaSyncSettings = DEFAULT_SETTINGS;
  pendingPassword = "";
  pendingVaultName = "";
  busy = false;
  remoteVaults: VaultInfo[] = [];
  signedInEmail: string | null = null;
  private engine?: SyncEngine;
  private paused = false;
  private lastReport: SyncReport = { pulled: 0, pushed: 0, conflicts: 0, applied: 0, errors: [] };
  private lastStatus = "Needs setup";
  private debounceTimer?: number;
  private boundStoreId: string | null = null;
  private booting = false;
  private auth?: Promise<PasswordAuth>;
  private authConnection = "";
  private settingTab?: SupaSyncSettingTab;
  private cycleInFlight?: Promise<void>;
  private disconnecting = false;
  authMessage = "";

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.settingTab = new SupaSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
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
        if (!this.busy && document.visibilityState === "visible" && this.settings.autoSync && !this.paused) void this.syncNow();
      }, DEFAULT_LIMITS.pollIntervalMs),
    );
  }

  override onunload(): void {
    window.clearTimeout(this.debounceTimer);
    this.resetEngine();
    this.pendingPassword = "";
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    delete (this.settings as { password?: string }).password;
    this.pendingPassword = "";
    if (!this.settings.installationId) {
      this.settings.installationId = newInstallationId();
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    const { supabaseUrl, anonKey, email, vaultId, deviceLabel, autoSync, installationId } = this.settings;
    await this.saveData({ supabaseUrl, anonKey, email, vaultId, deviceLabel, autoSync, installationId });
  }

  async createAccount(): Promise<void> {
    if (!this.ensureConnection()) return;
    if (!this.settings.email || !this.pendingPassword) {
      new Notice("Enter an email and password.");
      return;
    }
    this.authMessage = "";
    try {
      const result = await (await this.getAuth()).signUp(this.settings.email, this.pendingPassword);
      this.pendingPassword = "";
      if (result.status === "confirmation_required") {
        this.signedInEmail = null;
        this.lastStatus = "Confirm email";
        this.authMessage = "Check your email to confirm the account, then sign in here.";
        new Notice(this.authMessage);
        return;
      }
      this.signedInEmail = result.session.email;
      new Notice("Account created");
      await this.afterAuthentication();
    } catch (error) {
      this.fail(error, "Could not create the account");
    } finally {
      this.pendingPassword = "";
    }
  }

  async signIn(): Promise<void> {
    if (!this.ensureConnection()) return;
    if (!this.settings.email || !this.pendingPassword) {
      new Notice("Enter an email and password.");
      return;
    }
    this.authMessage = "";
    try {
      const session = await (await this.getAuth()).signIn(this.settings.email, this.pendingPassword);
      this.pendingPassword = "";
      this.signedInEmail = session.email;
      new Notice("Signed in to SupaSync");
      await this.afterAuthentication();
    } catch (error) {
      this.fail(error, "Could not sign in");
    } finally {
      this.pendingPassword = "";
    }
  }

  async signOut(): Promise<void> {
    this.disconnecting = true;
    this.resetEngine();
    await this.cycleInFlight;
    try {
      await (await this.getAuth()).signOut();
      this.authMessage = "Signed out. Your local notes are still here.";
    } catch {
      this.authMessage = "Signed out locally. Server session revocation could not be confirmed.";
    } finally {
      this.signedInEmail = null;
      this.remoteVaults = [];
      this.pendingPassword = "";
      this.disconnecting = false;
      this.lastStatus = "Signed out";
      new Notice(this.authMessage);
      this.settingTab?.display();
    }
  }

  async refreshVaults(): Promise<VaultInfo[]> {
    const client = this.getClient();
    const { vaults } = await client.listVaults();
    this.remoteVaults = vaults;
    if (this.settings.vaultId && !vaults.some((vault) => vault.id === this.settings.vaultId)) {
      this.settings.vaultId = "";
      await this.saveSettings();
    }
    return vaults;
  }

  async createRemoteVault(name?: string): Promise<void> {
    const client = this.getClient();
    const vaultName = (name ?? this.pendingVaultName).trim() || this.app.vault.getName();
    const { vault } = await client.createVault(vaultName);
    this.pendingVaultName = "";
    await this.selectRemoteVault(vault.id);
    new Notice(`Created remote vault “${vault.name}”`);
  }

  async selectRemoteVault(vaultId: string): Promise<void> {
    this.settings.vaultId = vaultId;
    await this.saveSettings();
    await this.refreshVaults();
    await this.initializeSyncEngine();
    await this.runSyncCycle();
  }

  async syncNow(): Promise<void> {
    if (this.booting || this.disconnecting) return;
    if (!this.engine) {
      await this.boot(true);
      return;
    }
    if (this.paused) return;
    await this.runSyncCycle();
  }

  statusLabel(): string {
    return this.lastStatus;
  }

  statusSummary(): string {
    const vault = this.remoteVaults.find((item) => item.id === this.settings.vaultId);
    const parts = [
      this.signedInEmail ? `Signed in as ${this.signedInEmail}` : "Not signed in",
      vault ? `Vault: ${vault.name}` : this.settings.vaultId ? "Vault selected" : "No vault selected",
      this.paused ? "Paused" : "",
    ];
    return parts.filter(Boolean).join(" · ");
  }

  private async boot(forceSync = false): Promise<void> {
    if (this.booting || this.disconnecting) return;
    this.booting = true;
    try {
      if (!this.ensureConnection(false)) return;
      const session = await this.readSession();
      if (!session) {
        this.signedInEmail = null;
        this.lastStatus = "Needs sign-in";
        return;
      }
      this.signedInEmail = session.email;
      await this.afterAuthentication(forceSync);
    } catch (error) {
      this.fail(error, "Could not start SupaSync");
    } finally {
      this.booting = false;
      this.settingTab?.display();
    }
  }

  private async afterAuthentication(forceSync = false): Promise<void> {
    this.resetEngine();
    await this.ensureVaultSelection();
    if (!this.settings.vaultId) {
      this.lastStatus = "Select vault";
      return;
    }
    await this.initializeSyncEngine();
    if (forceSync || this.settings.autoSync) await this.runSyncCycle();
    else this.lastStatus = "Ready";
  }

  private async ensureVaultSelection(): Promise<void> {
    const vaults = await this.refreshVaults();
    const decision = decideVaultSelection(vaults, this.settings.vaultId, this.app.vault.getName());
    if (decision.type === "prompt") {
      if (this.settings.vaultId) {
        this.settings.vaultId = "";
        await this.saveSettings();
      }
      this.resetEngine();
      this.lastStatus = "Select vault";
      return;
    }
    if (decision.type === "create") {
      const { vault } = await this.getClient().createVault(decision.name);
      this.settings.vaultId = vault.id;
      await this.saveSettings();
      await this.refreshVaults();
      return;
    }
    this.settings.vaultId = decision.vault.id;
    await this.saveSettings();
  }

  private async initializeSyncEngine(): Promise<void> {
    if (!this.settings.vaultId) return;
    const storeId = syncStoreId({
      installationId: this.settings.installationId,
      backendUrl: this.settings.supabaseUrl,
      vaultId: this.settings.vaultId,
    });
    if (this.engine && this.boundStoreId === storeId) return;
    this.resetEngine();
    const client = this.getClient();
    const store = new IndexedDbStore(storeId);
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
      fetch: createObsidianFetch(),
      vault: new ObsidianVaultAdapter(this.app),
      store,
      vaultId: this.settings.vaultId,
    });
    this.boundStoreId = storeId;
  }

  private async runSyncCycle(): Promise<void> {
    if (!this.cycleInFlight) {
      this.cycleInFlight = this.performSyncCycle().finally(() => { this.cycleInFlight = undefined; });
    }
    return this.cycleInFlight;
  }

  private async performSyncCycle(): Promise<void> {
    if (!this.engine || this.paused) return;
    try {
      this.lastStatus = "Syncing";
      this.lastReport = await this.engine.cycle();
      this.lastStatus = this.lastReport.errors.length ? "Error" : "Up to date";
      this.authMessage = this.lastReport.errors.join(" · ");
      if (this.lastReport.conflicts) {
        new Notice(`SupaSync preserved ${this.lastReport.conflicts} conflict cop${this.lastReport.conflicts === 1 ? "y" : "ies"}`);
      }
    } catch (error) {
      this.fail(error, "Sync failed");
    }
  }

  private ensureConnection(notice = true): boolean {
    if (!this.settings.supabaseUrl || !this.settings.anonKey) {
      this.lastStatus = "Needs setup";
      if (notice) new Notice("Enter the Supabase URL and publishable key first.");
      return false;
    }
    if (looksLikeSecretKey(this.settings.anonKey)) {
      this.lastStatus = "Needs setup";
      if (notice) new Notice("Service-role and secret keys are not allowed.");
      return false;
    }
    try {
      const url = new URL(this.settings.supabaseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new AuthError("Enter a valid Supabase project URL.");
      }
      assertPublicApiKey(this.settings.anonKey);
    } catch (error) {
      this.lastStatus = "Needs setup";
      if (notice) new Notice(error instanceof Error ? error.message : "Invalid API key");
      return false;
    }
    return true;
  }

  private getAuth(): Promise<PasswordAuth> {
    if (!this.app.secretStorage) throw new AuthError("SupaSync requires Obsidian 1.11.4 or newer for secure session storage.");
    const { supabaseUrl, anonKey, installationId } = this.settings;
    const connection = JSON.stringify([supabaseUrl, anonKey, installationId]);
    if (this.auth && this.authConnection === connection) return this.auth;
    this.auth = installationSessionSecretId(supabaseUrl, installationId).then((secretId) =>
      new PasswordAuth(supabaseUrl, anonKey, createObsidianFetch(), {
        get: async (id) => this.app.secretStorage.getSecret(id),
        set: async (id, value) => {
          this.app.secretStorage.setSecret(id, value);
        },
        delete: async (id) => {
          this.app.secretStorage.setSecret(id, "");
        },
      }, secretId),
    );
    this.authConnection = connection;
    return this.auth;
  }

  private getClient(): SupaSyncClient {
    const auth = this.getAuth();
    return new SupaSyncClient({
      url: this.settings.supabaseUrl,
      anonKey: this.settings.anonKey,
      fetch: createObsidianFetch(),
      session: { getAccessToken: async () => (await auth).getAccessToken() },
    });
  }

  private async readSession(): Promise<StoredSession | null> {
    const auth = await this.getAuth();
    const token = await auth.getAccessToken();
    if (!token) return null;
    return auth.getSession();
  }

  private resetEngine(): void {
    this.engine?.pause();
    this.engine = undefined;
    this.boundStoreId = null;
  }

  reportError(error: unknown, fallback: string): void {
    this.fail(error, fallback);
  }

  private fail(error: unknown, fallback: string): void {
    const message = error instanceof AuthError || error instanceof Error ? error.message : fallback;
    this.lastStatus = "Error";
    this.authMessage = message;
    if (error && typeof error === "object" && "code" in error && error.code === "AUTH_REQUIRED") {
      this.signedInEmail = null;
      this.resetEngine();
      this.lastStatus = "Needs sign-in";
    }
    this.lastReport.errors.push(message);
    new Notice(`SupaSync: ${message}`);
  }

  private onVaultEvent(path: string, _old?: string): void {
    if (!this.settings.autoSync || this.paused) return;
    if (this.engine?.matchesEcho(path, null, null)) return;
    window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.syncNow(), DEFAULT_LIMITS.debounceMs);
  }

  private async rebuild(): Promise<void> {
    if (!this.settings.vaultId) {
      new Notice("Select a remote vault first.");
      return;
    }
    const store = new IndexedDbStore(syncStoreId({
      installationId: this.settings.installationId,
      backendUrl: this.settings.supabaseUrl,
      vaultId: this.settings.vaultId,
    }));
    const meta = await store.getMeta();
    meta.receivedCursor = "0";
    meta.appliedCursor = "0";
    await store.putMeta(meta);
    this.resetEngine();
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
        plugin: PLUGIN_ID,
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
    return JSON.stringify({ status: this.lastStatus, paused: this.paused, report: this.lastReport, account: this.signedInEmail }, null, 2);
  }

  private conflictText(): string {
    return this.lastReport.conflicts ? `${this.lastReport.conflicts} conflict copies were preserved.` : "";
  }

  private historyText(): string {
    const file = this.app.workspace.getActiveFile();
    return file ? `Active file: ${file.path}\nUse the CLI list-history API or conflict copies for restore.` : "";
  }
}
