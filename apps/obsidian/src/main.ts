import {
  deviceKeypair,
  wrapDevice,
  unwrapDevice,
  encode,
  unencode,
  type DeviceEnvelope,
} from "@supasync/crypto";
import { DaemonClient } from "@supasync/daemon-client";
import { Notice, Plugin, TFile } from "obsidian";
import {
  AuthError,
  PasswordAuth,
  VaultKeys,
  SupaSyncClient,
  assertPublicApiKey,
  decideVaultSelection,
  looksLikeSecretKey,
  type StoredSession,
  type VaultInfo,
} from "@supasync/client";
import {
  DEFAULT_LIMITS,
  PLUGIN_ID,
  parseConnectionProfile,
} from "@supasync/protocol";
import {
  EncryptedSyncApi,
  SyncEngine,
  type SyncReport,
} from "@supasync/sync-core";
import { createObsidianFetch } from "./adapters/obsidian-fetch.ts";
import { IndexedDbStore } from "./adapters/indexeddb-store.ts";
import { ObsidianVaultAdapter } from "./adapters/obsidian-vault.ts";
import { SupaSyncSettingTab } from "./settings/tab.ts";
import {
  installationSessionSecretId,
  newInstallationId,
  syncStoreId,
} from "./sync-state.ts";
import {
  CONFLICT_VIEW,
  ConflictView,
  HISTORY_VIEW,
  HistoryView,
  STATUS_VIEW,
  StatusView,
} from "./ui/views.ts";

export interface SupaSyncSettings {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  vaultId: string;
  deviceLabel: string;
  autoSync: boolean;
  installationId: string;
  daemonEnabled: boolean;
}

const DEFAULT_SETTINGS: SupaSyncSettings = {
  supabaseUrl: "",
  anonKey: "",
  email: "",
  vaultId: "",
  deviceLabel: "obsidian",
  autoSync: true,
  installationId: "",
  daemonEnabled: false,
};

export default class SupaSyncPlugin extends Plugin {
  override settings: SupaSyncSettings = DEFAULT_SETTINGS;
  pendingPassword = "";
  pendingRecovery = "";
  pendingConnection = "";
  pendingDaemonToken = "";
  pendingPairing = "";
  pairingToShow = "";
  devices: Array<{ clientId: string; revoked: boolean }> = [];
  recoveryToSave: string | null = null;
  encryptionStatus = "Locked";
  private vaultKey?: Uint8Array;
  pendingVaultName = "";
  busy = false;
  remoteVaults: VaultInfo[] = [];
  signedInEmail: string | null = null;
  private engine?: SyncEngine;
  private paused = false;
  private lastReport: SyncReport = {
    pulled: 0,
    pushed: 0,
    conflicts: 0,
    applied: 0,
    errors: [],
  };
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
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(),
    });
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
      callback: () =>
        void this.app.workspace
          .getRightLeaf(false)
          ?.setViewState({ type: STATUS_VIEW, active: true }),
    });
    this.addCommand({
      id: "show-conflicts",
      name: "Show conflicts",
      callback: () =>
        void this.app.workspace
          .getRightLeaf(false)
          ?.setViewState({ type: CONFLICT_VIEW, active: true }),
    });
    this.addCommand({
      id: "show-history",
      name: "Show history/restore",
      callback: () =>
        void this.app.workspace
          .getRightLeaf(false)
          ?.setViewState({ type: HISTORY_VIEW, active: true }),
    });
    this.addCommand({
      id: "rebuild-index",
      name: "Reconcile/rebuild local index",
      callback: () => void this.rebuild(),
    });
    this.addCommand({
      id: "export-diagnostics",
      name: "Export redacted diagnostics",
      callback: () => void this.exportDiagnostics(),
    });
    this.addCommand({
      id: "sign-out",
      name: "Sign out/disconnect",
      callback: () => void this.signOut(),
    });

    this.registerView(
      STATUS_VIEW,
      (leaf) => new StatusView(leaf, () => this.statusText()),
    );
    this.registerView(
      CONFLICT_VIEW,
      (leaf) => new ConflictView(leaf, () => this.conflictText()),
    );
    this.registerView(
      HISTORY_VIEW,
      (leaf) =>
        new HistoryView(
          leaf,
          () => this.readHistory(),
          (seq) => this.restoreHistory(seq),
        ),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => this.onVaultEvent(file.path)),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onVaultEvent(file.path)),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        void (async () => {
          await this.engine?.deleteLocal(file.path);
          this.onVaultEvent(file.path);
        })().catch((error) =>
          this.reportError(error, "Could not queue deletion"),
        );
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, old) =>
        this.onVaultEvent(file.path, old),
      ),
    );

    this.app.workspace.onLayoutReady(() => {
      void this.boot();
    });
    this.registerInterval(
      window.setInterval(() => {
        if (
          !this.busy &&
          document.visibilityState === "visible" &&
          this.settings.autoSync &&
          !this.paused
        )
          void this.syncNow();
      }, DEFAULT_LIMITS.pollIntervalMs),
    );
  }

  override onunload(): void {
    window.clearTimeout(this.debounceTimer);
    this.resetEngine();
    this.pendingPassword = "";
    this.vaultKey?.fill(0);
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
    const {
      supabaseUrl,
      anonKey,
      email,
      vaultId,
      deviceLabel,
      autoSync,
      installationId,
      daemonEnabled,
    } = this.settings;
    await this.saveData({
      supabaseUrl,
      anonKey,
      email,
      vaultId,
      deviceLabel,
      autoSync,
      installationId,
      daemonEnabled,
    });
  }

  async createAccount(): Promise<void> {
    if (!this.ensureConnection()) return;
    if (!this.settings.email || !this.pendingPassword) {
      new Notice("Enter an email and password.");
      return;
    }
    this.authMessage = "";
    try {
      const result = await (
        await this.getAuth()
      ).signUp(this.settings.email, this.pendingPassword);
      this.pendingPassword = "";
      if (result.status === "confirmation_required") {
        this.signedInEmail = null;
        this.lastStatus = "Confirm email";
        this.authMessage =
          "Check your email to confirm the account, then sign in here.";
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
      const session = await (
        await this.getAuth()
      ).signIn(this.settings.email, this.pendingPassword);
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
    this.vaultKey?.fill(0);
    this.vaultKey = undefined;
    this.encryptionStatus = "Locked";
    this.recoveryToSave = null;
    this.pendingRecovery = "";
    this.resetEngine();
    await this.cycleInFlight;
    try {
      await (await this.getAuth()).signOut();
      this.authMessage = "Signed out. Your local notes are still here.";
    } catch {
      this.authMessage =
        "Signed out locally. Server session revocation could not be confirmed.";
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
    for (const vault of vaults) {
      if (vault.protocolVersion !== 2)
        throw new Error("PROTOCOL_UPGRADE_REQUIRED");
      if (vault.encryptedLabel)
        vault.name =
          (await this.getVaultKeys().label(vault.id, vault.encryptedLabel)) ??
          "Encrypted vault";
    }
    this.remoteVaults = vaults;
    if (
      this.settings.vaultId &&
      !vaults.some((vault) => vault.id === this.settings.vaultId)
    ) {
      this.settings.vaultId = "";
      await this.saveSettings();
    }
    return vaults;
  }

  async createRemoteVault(name?: string): Promise<void> {
    const client = this.getClient();
    const vaultName =
      (name ?? this.pendingVaultName).trim() || this.app.vault.getName();
    const { vault } = await this.createEncryptedVault(vaultName);
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
    if (this.settings.daemonEnabled) {
      this.resetEngine();
      try {
        const token = this.app.secretStorage.getSecret("supasync-daemon-token");
        if (!token)
          throw new Error("Enter the local daemon token to delegate sync");
        const daemon = new DaemonClient(
          "http://127.0.0.1:49582",
          token,
          createObsidianFetch(),
        );
        await daemon.sync(this.settings.vaultId);
        this.lastStatus = "Daemon sync requested";
      } catch (error) {
        this.fail(error, "Daemon unavailable");
      }
      return;
    }
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
    const vault = this.remoteVaults.find(
      (item) => item.id === this.settings.vaultId,
    );
    const parts = [
      this.signedInEmail
        ? `Signed in as ${this.signedInEmail}`
        : "Not signed in",
      vault
        ? `Vault: ${vault.name}`
        : this.settings.vaultId
          ? "Vault selected"
          : "No vault selected",
      this.paused ? "Paused" : "",
    ];
    return parts.filter(Boolean).join(" · ");
  }

  private async boot(forceSync = false): Promise<void> {
    if (this.settings.daemonEnabled) {
      this.lastStatus = "Daemon owns sync";
      return;
    }
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
    if (!this.engine) return;
    if (forceSync || this.settings.autoSync) await this.runSyncCycle();
    else this.lastStatus = "Ready";
  }

  private async ensureVaultSelection(): Promise<void> {
    const vaults = await this.refreshVaults();
    const decision = decideVaultSelection(
      vaults,
      this.settings.vaultId,
      this.app.vault.getName(),
    );
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
      const { vault } = await this.createEncryptedVault(decision.name);
      this.settings.vaultId = vault.id;
      await this.saveSettings();
      await this.refreshVaults();
      return;
    }
    this.settings.vaultId = decision.vault.id;
    await this.saveSettings();
  }

  private async initializeSyncEngine(): Promise<void> {
    if (this.settings.daemonEnabled || !this.settings.vaultId) return;
    this.vaultKey =
      (await this.getVaultKeys().get(this.settings.vaultId)) ?? undefined;
    this.recoveryToSave = await this.getVaultKeys().pendingRecovery(
      this.settings.vaultId,
    );
    if (!this.vaultKey) {
      this.encryptionStatus = this.recoveryToSave
        ? "Save and verify recovery key"
        : "Locked";
      this.lastStatus = this.encryptionStatus;
      return;
    }
    this.encryptionStatus = "Unlocked";
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
      api: new EncryptedSyncApi(
        client,
        store,
        this.settings.vaultId,
        this.vaultKey!,
        createObsidianFetch(),
        this.settings.supabaseUrl,
      ),
      fetch: createObsidianFetch(),
      vault: new ObsidianVaultAdapter(this.app),
      store,
      vaultId: this.settings.vaultId,
    });
    this.boundStoreId = storeId;
  }

  private async runSyncCycle(): Promise<void> {
    if (!this.cycleInFlight) {
      this.cycleInFlight = this.performSyncCycle().finally(() => {
        this.cycleInFlight = undefined;
      });
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
        new Notice(
          `SupaSync preserved ${this.lastReport.conflicts} conflict cop${this.lastReport.conflicts === 1 ? "y" : "ies"}`,
        );
      }
    } catch (error) {
      this.fail(error, "Sync failed");
    }
  }

  private ensureConnection(notice = true): boolean {
    if (!this.settings.supabaseUrl || !this.settings.anonKey) {
      this.lastStatus = "Needs setup";
      if (notice)
        new Notice("Enter the Supabase URL and publishable key first.");
      return false;
    }
    if (looksLikeSecretKey(this.settings.anonKey)) {
      this.lastStatus = "Needs setup";
      if (notice) new Notice("Service-role and secret keys are not allowed.");
      return false;
    }
    try {
      const url = new URL(this.settings.supabaseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new AuthError("Enter a valid Supabase project URL.");
      }
      assertPublicApiKey(this.settings.anonKey);
    } catch (error) {
      this.lastStatus = "Needs setup";
      if (notice)
        new Notice(error instanceof Error ? error.message : "Invalid API key");
      return false;
    }
    return true;
  }

  async importConnection(): Promise<void> {
    const profile = parseConnectionProfile(JSON.parse(this.pendingConnection));
    assertPublicApiKey(profile.publicKey);
    this.resetEngine();
    this.vaultKey?.fill(0);
    this.vaultKey = undefined;
    this.settings.supabaseUrl = profile.serverUrl;
    this.settings.anonKey = profile.publicKey;
    this.settings.vaultId = profile.vaultId ?? "";
    this.signedInEmail = null;
    this.remoteVaults = [];
    this.pendingConnection = "";
    await this.saveSettings();
    this.lastStatus = "Sign in to connect";
  }
  async configureDaemon(enabled: boolean): Promise<void> {
    this.resetEngine();
    await this.cycleInFlight;
    if (this.pendingDaemonToken)
      this.app.secretStorage.setSecret(
        "supasync-daemon-token",
        this.pendingDaemonToken.trim(),
      );
    if (!enabled && this.settings.daemonEnabled) {
      const token = this.app.secretStorage.getSecret("supasync-daemon-token");
      if (!token)
        throw new Error(
          "Enter the daemon token so ownership can be released safely",
        );
      await new DaemonClient(
        "http://127.0.0.1:49582",
        token,
        createObsidianFetch(),
      ).release(this.settings.vaultId);
    }
    this.pendingDaemonToken = "";
    this.settings.daemonEnabled = enabled;
    await this.saveSettings();
    if (!enabled) await this.boot();
  }

  private async deviceContext() {
    const store = new IndexedDbStore(
      syncStoreId({
        installationId: this.settings.installationId,
        backendUrl: this.settings.supabaseUrl,
        vaultId: this.settings.vaultId,
      }),
    );
    const meta = await store.getMeta();
    await store.putMeta(meta);
    await this.getClient().registerClient({
      vaultId: this.settings.vaultId,
      clientId: meta.clientId,
      label: this.settings.deviceLabel,
      platform: "obsidian",
    });
    return { vaultId: this.settings.vaultId, clientId: meta.clientId };
  }
  async refreshDevices() {
    const payload = await this.deviceContext();
    this.devices = (
      await this.getClient().rpc<{
        devices: Array<{ clientId: string; revoked: boolean }>;
      }>("list_devices", payload)
    ).devices;
  }
  async revokeDevice(targetClientId: string) {
    await this.getClient().rpc("revoke_device", {
      ...(await this.deviceContext()),
      targetClientId,
    });
    await this.refreshDevices();
  }
  async beginPairing() {
    const payload = await this.deviceContext();
    const pair = deviceKeypair();
    const pairingId = crypto.randomUUID();
    this.app.secretStorage.setSecret(
      `supasync-pair-${pairingId}`,
      encode(pair.privateKey),
    );
    pair.privateKey.fill(0);
    await this.getClient().rpc("pair_begin", {
      ...payload,
      pairingId,
      publicKey: pair.publicKey,
    });
    this.pairingToShow = JSON.stringify({
      vaultId: payload.vaultId,
      pairingId,
      publicKey: pair.publicKey,
    });
    this.pendingPairing = this.pairingToShow;
  }
  async completePairing(approve: boolean) {
    const request = JSON.parse(this.pendingPairing) as {
      vaultId: string;
      pairingId: string;
      publicKey: string;
    };
    if (
      request.vaultId !== this.settings.vaultId ||
      !request.pairingId ||
      !request.publicKey
    )
      throw new Error("Pairing request does not match this vault");
    const payload = {
      ...(await this.deviceContext()),
      pairingId: request.pairingId,
    };
    const pairing = await this.getClient().rpc<{
      clientId: string;
      publicKey: string;
      envelope: DeviceEnvelope;
    }>("pair_get", payload);
    if (pairing.publicKey !== request.publicKey)
      throw new Error("Pairing key differs from the new device display");
    const context = {
      vaultId: request.vaultId,
      entryId: pairing.clientId,
      objectId: request.pairingId,
      purpose: "device" as const,
      keyVersion: 1,
    };
    if (approve) {
      const master = await this.getVaultKeys().get(request.vaultId);
      if (!master) throw new Error("Unlock this device first");
      try {
        await this.getClient().rpc("pair_approve", {
          ...payload,
          envelope: wrapDevice(master, pairing.publicKey, context),
        });
      } finally {
        master.fill(0);
      }
    } else {
      const raw = this.app.secretStorage.getSecret(
        `supasync-pair-${request.pairingId}`,
      );
      if (!raw || !pairing.envelope)
        throw new Error("Pairing has not been approved");
      const privateKey = unencode(raw);
      const master = unwrapDevice(pairing.envelope, privateKey, context);
      privateKey.fill(0);
      try {
        await this.getVaultKeys().enroll(request.vaultId, master);
      } finally {
        master.fill(0);
      }
      await this.getClient().rpc("pair_consume", payload);
      this.app.secretStorage.setSecret(
        `supasync-pair-${request.pairingId}`,
        "",
      );
      this.pendingPairing = "";
      this.pairingToShow = "";
      await this.afterAuthentication();
    }
  }

  private getVaultKeys(): VaultKeys {
    if (!this.app.secretStorage)
      throw new Error("Obsidian SecretStorage is required");
    return new VaultKeys(
      {
        get: async (id) => this.app.secretStorage.getSecret(id),
        set: async (id, value) => {
          this.app.secretStorage.setSecret(id, value);
        },
      },
      this.settings.supabaseUrl,
      this.settings.installationId,
    );
  }
  private async createEncryptedVault(
    name: string,
  ): Promise<{ vault: VaultInfo }> {
    return this.getVaultKeys().create(name, (plan) =>
      this.getClient().rpc("create_vault", plan),
    );
  }
  async unlockEncryption(): Promise<void> {
    const vault = this.remoteVaults.find((v) => v.id === this.settings.vaultId);
    if (!vault?.recoveryEnvelope)
      throw new Error("Select an encrypted vault first");
    try {
      await this.getVaultKeys().recover(
        vault.id,
        vault.recoveryEnvelope,
        this.pendingRecovery.trim(),
      );
      this.recoveryToSave = null;
      await this.afterAuthentication();
    } finally {
      this.pendingRecovery = "";
    }
  }

  private getAuth(): Promise<PasswordAuth> {
    if (!this.app.secretStorage)
      throw new AuthError(
        "SupaSync requires Obsidian 1.11.4 or newer for secure session storage.",
      );
    const { supabaseUrl, anonKey, installationId } = this.settings;
    const connection = JSON.stringify([supabaseUrl, anonKey, installationId]);
    if (this.auth && this.authConnection === connection) return this.auth;
    this.auth = installationSessionSecretId(supabaseUrl, installationId).then(
      (secretId) =>
        new PasswordAuth(
          supabaseUrl,
          anonKey,
          createObsidianFetch(),
          {
            get: async (id) => this.app.secretStorage.getSecret(id),
            set: async (id, value) => {
              this.app.secretStorage.setSecret(id, value);
            },
            delete: async (id) => {
              this.app.secretStorage.setSecret(id, "");
            },
          },
          secretId,
        ),
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
    const message =
      error instanceof AuthError || error instanceof Error
        ? error.message
        : fallback;
    this.lastStatus = "Error";
    this.authMessage = message;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "AUTH_REQUIRED"
    ) {
      this.signedInEmail = null;
      this.resetEngine();
      this.lastStatus = "Needs sign-in";
    }
    this.lastReport.errors.push(message);
    new Notice(`SupaSync: ${message}`);
  }

  private onVaultEvent(path: string, old?: string): void {
    if (old && this.engine) {
      void this.engine
        .renameLocal(old, path)
        .then(() => this.onVaultEvent(path));
      return;
    }
    if (!this.settings.autoSync || this.paused) return;
    if (this.engine?.matchesEcho(path, null, null)) return;
    window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(
      () => void this.syncNow(),
      DEFAULT_LIMITS.debounceMs,
    );
  }

  private async rebuild(): Promise<void> {
    if (!this.settings.vaultId) {
      new Notice("Select a remote vault first.");
      return;
    }
    const store = new IndexedDbStore(
      syncStoreId({
        installationId: this.settings.installationId,
        backendUrl: this.settings.supabaseUrl,
        vaultId: this.settings.vaultId,
      }),
    );
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
    const file = this.app.vault.getAbstractFileByPath(
      "supasync-diagnostics.json",
    );
    if (file instanceof TFile) await this.app.vault.modify(file, body);
    else await this.app.vault.create("supasync-diagnostics.json", body);
    new Notice("Wrote supasync-diagnostics.json");
  }

  private statusText(): string {
    return JSON.stringify(
      {
        status: this.lastStatus,
        paused: this.paused,
        report: this.lastReport,
        account: this.signedInEmail,
      },
      null,
      2,
    );
  }

  private conflictText(): string {
    return this.lastReport.conflicts
      ? `${this.lastReport.conflicts} conflict copies were preserved.`
      : "";
  }

  private async historyContext() {
    const file = this.app.workspace.getActiveFile();
    if (!file) throw new Error("Select a synced file first");
    const key = await this.getVaultKeys().get(this.settings.vaultId);
    if (!key) throw new Error("Unlock this vault first");
    const store = new IndexedDbStore(
      syncStoreId({
        installationId: this.settings.installationId,
        backendUrl: this.settings.supabaseUrl,
        vaultId: this.settings.vaultId,
      }),
    );
    const row = [...(await store.getManifest()).values()].find(
      (r) => r.path === file.path && !r.deleted,
    );
    if (!row) {
      key.fill(0);
      throw new Error("This file has not synced yet");
    }
    const api = new EncryptedSyncApi(
      this.getClient(),
      store,
      this.settings.vaultId,
      key,
      createObsidianFetch(),
      this.settings.supabaseUrl,
    );
    try {
      await api.capabilities(this.settings.vaultId);
    } catch (error) {
      key.fill(0);
      throw error;
    }
    return { file, row, api, key };
  }
  private async readHistory() {
    const context = await this.historyContext();
    try {
      return await context.api.history(context.row.entryId);
    } finally {
      context.key.fill(0);
    }
  }
  private async restoreHistory(seq: string) {
    if (this.settings.daemonEnabled)
      throw new Error(
        "Release daemon ownership before restoring in the plugin",
      );
    const c = await this.historyContext();
    try {
      const bytes = await c.api.revisionBytes(c.row.entryId, seq);
      const adapter = new ObsidianVaultAdapter(this.app);
      // Keep the current local bytes independently before applying an explicit restore.
      const dot = c.file.path.lastIndexOf(".");
      const stem = dot < 0 ? c.file.path : c.file.path.slice(0, dot);
      const ext = dot < 0 ? "" : c.file.path.slice(dot);
      await adapter.writeBytes(
        `${stem} (before restore ${crypto.randomUUID().slice(0, 8)})${ext}`,
        await adapter.readBytes(c.file.path),
      );
      await adapter.writeBytes(c.file.path, bytes);
      await this.syncNow();
    } finally {
      c.key.fill(0);
    }
  }
}
