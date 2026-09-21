import { Notice, Plugin, TFile } from "obsidian";
import {
  PasswordAuth,
  SupaSyncClient,
  decideVaultSelection,
  type VaultInfo,
} from "@supasync/client";
import {
  PlaintextSyncApi,
  SyncEngine,
  type SyncReport,
} from "@supasync/sync-core";
import { createEnvelope, type RevisionRecord } from "@supasync/protocol";
import { IndexedDbStore } from "./adapters/indexeddb-store.ts";
import { ObsidianVaultAdapter } from "./adapters/obsidian-vault.ts";
import { createObsidianFetch } from "./adapters/obsidian-fetch.ts";
import { installationSessionSecretId, syncStoreId } from "./sync-state.ts";
import { SupaSyncSettingTab } from "./settings/tab.ts";
import { HISTORY_VIEW, HistoryView } from "./ui/views.ts";

export interface SupaSyncSettings {
  supabaseUrl: string;
  anonKey: string;
  vaultId: string;
  email: string;
  installationId: string;
  autoSync: boolean;
  deviceLabel: string;
  pendingVaultId: string;
}
const defaults: SupaSyncSettings = {
  supabaseUrl: "",
  anonKey: "",
  vaultId: "",
  email: "",
  installationId: "",
  autoSync: true,
  deviceLabel: "Obsidian",
  pendingVaultId: "",
};
export default class SupaSyncPlugin extends Plugin {
  override settings = { ...defaults };
  pendingPassword = "";
  signedInEmail: string | null = null;
  remoteVaults: VaultInfo[] = [];
  status = "Not connected";
  lastSync: string | null = null;
  private auth?: PasswordAuth;
  private client?: SupaSyncClient;
  private api?: PlaintextSyncApi;
  private engine?: SyncEngine;
  private store?: IndexedDbStore;
  private timer?: number;
  private running?: Promise<void>;
  private applying = false;
  private eventQueue = Promise.resolve();
  private tab?: SupaSyncSettingTab;
  private statusBar?: HTMLElement;
  private lastReport?: SyncReport;
  override async onload() {
    await this.loadSettings();
    this.tab = new SupaSyncSettingTab(this.app, this);
    this.addSettingTab(this.tab);
    this.statusBar = this.addStatusBarItem();
    this.renderStatus();
    this.addRibbonIcon(
      "refresh-cw",
      "SupaSync: sync now",
      () => void this.syncNow(),
    );
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: "history",
      name: "Show file history",
      callback: () => void this.showHistory(),
    });
    this.registerView(
      HISTORY_VIEW,
      (leaf) =>
        new HistoryView(
          leaf,
          () => this.readHistory(),
          (seq) => this.restoreHistory(seq),
        ),
    );
    this.registerEvent(this.app.vault.on("create", () => this.schedule()));
    this.registerEvent(this.app.vault.on("modify", () => this.schedule()));
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (
          !this.store ||
          this.engine?.matchesStructuralEcho("delete", file.path)
        )
          return;
        this.queueEvent({
          id: crypto.randomUUID(),
          type: "delete",
          path: file.path,
        });
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, old) => {
        if (
          !this.store ||
          this.engine?.matchesStructuralEcho("rename", old, file.path)
        )
          return;
        this.queueEvent({
          id: crypto.randomUUID(),
          type: "rename",
          path: old,
          to: file.path,
        });
      }),
    );
    this.registerInterval(window.setInterval(() => this.schedule(), 60_000));
    this.app.workspace.onLayoutReady(
      () =>
        void this.connect()
          .then(() => this.schedule())
          .catch((e) => this.fail(e)),
    );
  }
  override onunload() {
    if (this.timer) window.clearTimeout(this.timer);
    this.engine?.pause();
  }
  async loadSettings() {
    const saved = await this.loadData();
    // Whitelist non-secret v3 settings; old recovery/delegation fields are not carried forward.
    for (const key of Object.keys(defaults) as Array<keyof SupaSyncSettings>)
      if (saved?.[key] !== undefined)
        (this.settings as unknown as Record<string, unknown>)[key] = saved[key];
    this.settings.installationId ||= crypto.randomUUID();
    await this.saveSettings();
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  private async getAuth() {
    if (!this.auth) {
      if (!this.settings.supabaseUrl || !this.settings.anonKey)
        throw new Error("Run supasync setup or import a connection profile.");
      const id = await installationSessionSecretId(
        this.settings.supabaseUrl,
        this.settings.installationId,
      );
      this.auth = new PasswordAuth(
        this.settings.supabaseUrl,
        this.settings.anonKey,
        createObsidianFetch(),
        {
          get: async (key) => this.app.secretStorage.getSecret(key),
          set: async (key, value) => {
            this.app.secretStorage.setSecret(key, value);
          },
        },
        id,
      );
      this.client = new SupaSyncClient({
        url: this.settings.supabaseUrl,
        anonKey: this.settings.anonKey,
        fetch: createObsidianFetch(),
        session: this.auth,
      });
    }
    return this.auth;
  }
  async signIn() {
    try {
      const auth = await this.getAuth();
      await auth.signIn(this.settings.email, this.pendingPassword);
      await this.connect();
      if (this.settings.autoSync) await this.syncNow();
    } catch (e) {
      this.fail(e);
    } finally {
      this.pendingPassword = "";
      this.tab?.display();
    }
  }
  async signOut() {
    this.engine?.pause();
    await this.running;
    await (await this.getAuth()).signOut();
    this.engine = undefined;
    this.api = undefined;
    this.store = undefined;
    this.signedInEmail = null;
    this.status = "Signed out";
    this.renderStatus();
  }
  async connect() {
    const auth = await this.getAuth();
    if (!(await auth.getAccessToken())) {
      this.status = "Sign in";
      this.renderStatus();
      return;
    }
    this.signedInEmail = (await auth.getSession())?.email ?? null;
    this.remoteVaults = (await this.client!.listVaults()).vaults;
    const decision = decideVaultSelection(
      this.remoteVaults,
      this.settings.vaultId,
      this.app.vault.getName(),
    );
    if (decision.type === "prompt") {
      this.status = "Select a vault in Advanced";
      this.renderStatus();
      return;
    }
    if (decision.type === "create") {
      const id = this.settings.pendingVaultId || crypto.randomUUID();
      this.settings.pendingVaultId = id;
      await this.saveSettings();
      this.settings.vaultId = (
        await this.client!.createVault(id, decision.name)
      ).vault.id;
      this.settings.pendingVaultId = "";
      this.remoteVaults = (await this.client!.listVaults()).vaults;
    } else this.settings.vaultId = decision.vault.id;
    await this.saveSettings();
    if (this.engine) return;
    this.store = new IndexedDbStore(
      syncStoreId({
        installationId: this.settings.installationId,
        backendUrl: this.settings.supabaseUrl,
        vaultId: this.settings.vaultId,
      }),
    );
    const meta = await this.store.getMeta();
    meta.vaultId = this.settings.vaultId;
    meta.label = this.settings.deviceLabel;
    await this.store.putMeta(meta);
    this.api = new PlaintextSyncApi(
      this.client!,
      this.store,
      this.settings.vaultId,
    );
    this.engine = new SyncEngine({
      api: this.api,
      store: this.store,
      vault: new ObsidianVaultAdapter(this.app),
      vaultId: this.settings.vaultId,
    });
    this.status = "Connected";
    this.renderStatus();
  }
  async selectVault(id: string) {
    await this.running;
    this.engine?.pause();
    this.engine = undefined;
    this.store = undefined;
    this.settings.vaultId = id;
    await this.saveSettings();
    await this.connect();
  }
  async setConnection(url: string, key: string) {
    if (this.signedInEmail)
      throw new Error("Sign out before changing connections");
    new SupaSyncClient({
      url,
      anonKey: key,
      fetch: createObsidianFetch(),
      session: { getAccessToken: async () => null },
    });
    this.auth = undefined;
    this.client = undefined;
    this.settings.supabaseUrl = url;
    this.settings.anonKey = key;
    await this.saveSettings();
  }
  async syncNow() {
    if (this.running) return this.running;
    this.running = this.cycle()
      .catch((e) => this.fail(e))
      .finally(() => {
        this.running = undefined;
        this.applying = false;
        this.renderStatus();
      });
    return this.running;
  }
  private async cycle() {
    if (!this.engine) await this.connect();
    if (!this.engine || !this.store) return;
    this.status = "Syncing";
    this.renderStatus();
    await this.eventQueue;
    const events =
      (await this.store.getCache<
        Array<{ id: string; type: string; path: string; to?: string }>
      >("filesystem-events")) ?? [];
    for (const event of events) {
      const consumed =
        event.type === "delete"
          ? await this.engine.deleteLocal(event.path)
          : await this.engine.renameLocal(event.path, event.to!);
      if (!consumed) continue;
      const store = this.store;
      this.eventQueue = this.eventQueue.then(async () => {
        const latest =
          (await store.getCache<typeof events>("filesystem-events")) ?? [];
        await store.putCache(
          "filesystem-events",
          latest.filter((x) => x.id !== event.id),
        );
      });
      await this.eventQueue;
    }
    this.applying = true;
    try {
      this.lastReport = await this.engine.cycle();
    } finally {
      this.applying = false;
    }
    this.status = this.lastReport.errors.length
      ? this.lastReport.errors.join("; ")
      : this.lastReport.conflicts
        ? "Conflicts preserved"
        : "Up to date";
    this.lastSync = new Date().toISOString();
  }
  private queueEvent(event: {
    id: string;
    type: string;
    path: string;
    to?: string;
  }) {
    const store = this.store!;
    this.eventQueue = this.eventQueue
      .then(async () => {
        const events =
          (await store.getCache<unknown[]>("filesystem-events")) ?? [];
        await store.putCache("filesystem-events", [...events, event]);
      })
      .catch((e) => this.fail(e));
    this.schedule();
  }
  schedule() {
    if (!this.settings.autoSync || this.applying) return;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.syncNow(), 750);
  }
  private renderStatus() {
    this.statusBar?.setText(`SupaSync: ${this.status}`);
    this.tab?.display();
  }
  fail(error: unknown) {
    this.status = error instanceof Error ? error.message : "Sync failed";
    new Notice(`SupaSync: ${this.status}`);
    this.renderStatus();
  }
  diagnostics() {
    return JSON.stringify(
      {
        protocolVersion: 3,
        status: this.status,
        lastSync: this.lastSync,
        vaultId: this.settings.vaultId,
        report: this.lastReport,
      },
      null,
      2,
    );
  }
  private async activeHistory(): Promise<{
    row: { entryId: string; remoteSeq: string; baseSeq: string; path: string };
    items: RevisionRecord[];
  }> {
    if (!this.engine) await this.connect();
    const active = this.app.workspace.getActiveFile();
    if (!active || !this.store || !this.api)
      throw new Error("Select a synced file");
    const row = [...(await this.store.getManifest()).values()].find(
      (r) => r.path === active.path,
    );
    if (!row) throw new Error("File has not synced");
    return { row, items: await this.api.history(row.entryId) };
  }
  private async readHistory() {
    const { items } = await this.activeHistory();
    return items.map((r) => ({
      seq: r.seq,
      path: r.path,
      serverTime: r.serverTime,
      version: r.version,
      tombstone: r.tombstone,
    }));
  }
  private async restoreHistory(seq: string) {
    await this.running;
    const { row, items } = await this.activeHistory();
    const revision = items.find((r) => r.seq === seq);
    if (!revision || revision.tombstone)
      throw new Error("Select a live revision");
    const meta = await this.store!.getMeta();
    const op = crypto.randomUUID();
    const envelope = createEnvelope({
      operationId: op,
      serverEpoch: meta.serverEpoch!,
      vaultId: this.settings.vaultId,
      clientId: meta.clientId,
      type: "restore_revision",
      entryId: row.entryId,
      baseRevisionId: row.baseSeq,
      payload: {
        path: row.path,
        ...(revision.kind === "markdown"
          ? { text: revision.content }
          : { blob_id: revision.blobId }),
      },
    });
    await this.store!.putOutbox({
      operationId: op,
      envelope,
      extras: {},
      status: "queued",
      sentHash: revision.textSha256,
    });
    await this.syncNow();
  }
  private async showHistory() {
    try {
      const leaf = this.app.workspace.getLeaf("split");
      await leaf.setViewState({ type: HISTORY_VIEW, active: true });
      await this.app.workspace.revealLeaf(leaf);
    } catch (e) {
      this.fail(e);
    }
  }
}
