import { App, PluginSettingTab, Setting } from "obsidian";
import type SupaSyncPlugin from "../main.ts";
export class SupaSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: SupaSyncPlugin,
  ) {
    super(app, plugin);
  }
  override display() {
    const el = this.containerEl;
    el.empty();
    el.createEl("h2", { text: "SupaSync" });
    el.createEl("p", { text: this.plugin.status, attr: { role: "status" } });
    const vault = this.plugin.remoteVaults.find(
      (v) => v.id === this.plugin.settings.vaultId,
    );
    el.createEl("p", { text: `Vault: ${vault?.name ?? "Not selected"}` });
    if (this.plugin.signedInEmail) {
      el.createEl("p", { text: `Account: ${this.plugin.signedInEmail}` });
      el.createEl("p", {
        text: `Last sync: ${this.plugin.lastSync ? new Date(this.plugin.lastSync).toLocaleString() : "Never"}`,
      });
      new Setting(el).addButton((b) =>
        b
          .setButtonText("Sync now")
          .onClick(() => this.run(() => this.plugin.syncNow())),
      );
    } else {
      new Setting(el).setName("Admin email").addText((t) =>
        t.setValue(this.plugin.settings.email).onChange(async (v) => {
          this.plugin.settings.email = v;
          await this.plugin.saveSettings();
        }),
      );
      new Setting(el).setName("Password").addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.pendingPassword).onChange(
          (v) => (this.plugin.pendingPassword = v),
        );
      });
      new Setting(el).addButton((b) =>
        b
          .setButtonText("Sign in")
          .onClick(() => this.run(() => this.plugin.signIn())),
      );
    }
    new Setting(el).setName("Auto Sync").addToggle((t) =>
      t.setValue(this.plugin.settings.autoSync).onChange(async (v) => {
        this.plugin.settings.autoSync = v;
        await this.plugin.saveSettings();
        this.plugin.schedule();
      }),
    );
    const advanced = el.createEl("details");
    advanced.createEl("summary", { text: "Advanced" });
    if (this.plugin.remoteVaults.length > 1)
      new Setting(advanced).setName("Remote vault").addDropdown((d) => {
        for (const v of this.plugin.remoteVaults) d.addOption(v.id, v.name);
        d.setValue(this.plugin.settings.vaultId).onChange((v) =>
          this.run(() => this.plugin.selectVault(v)),
        );
      });
    let url = this.plugin.settings.supabaseUrl,
      key = this.plugin.settings.anonKey;
    new Setting(advanced).setName("Supabase URL").addText((t) =>
      t
        .setValue(url)
        .setDisabled(!!this.plugin.signedInEmail)
        .onChange((v) => (url = v.trim())),
    );
    new Setting(advanced).setName("Public key").addText((t) =>
      t
        .setValue(key)
        .setDisabled(!!this.plugin.signedInEmail)
        .onChange((v) => (key = v.trim())),
    );
    if (!this.plugin.signedInEmail) {
      new Setting(advanced).addButton((b) =>
        b
          .setButtonText("Save connection")
          .onClick(() => this.run(() => this.plugin.setConnection(url, key))),
      );
      let profile = "";
      new Setting(advanced)
        .setName("Import connection profile")
        .addTextArea((t) => t.onChange((v) => (profile = v)))
        .addButton((b) =>
          b.setButtonText("Import").onClick(() =>
            this.run(async () => {
              const p = JSON.parse(profile);
              await this.plugin.setConnection(p.serverUrl, p.publicKey);
              if (p.vaultId) {
                this.plugin.settings.vaultId = p.vaultId;
                await this.plugin.saveSettings();
              }
            }),
          ),
        );
    }
    advanced.createEl("p", {
      text: `Vault ID: ${this.plugin.settings.vaultId || "Not selected"}`,
    });
    new Setting(advanced).setName("Diagnostics").addButton((b) =>
      b.setButtonText("Show").onClick(() => {
        advanced.createEl("pre", { text: this.plugin.diagnostics() });
      }),
    );
    if (this.plugin.signedInEmail)
      new Setting(advanced).addButton((b) =>
        b
          .setButtonText("Sign out")
          .onClick(() => this.run(() => this.plugin.signOut())),
      );
  }
  private async run(work: () => Promise<unknown>) {
    try {
      await work();
    } catch (e) {
      this.plugin.fail(e);
    }
    this.display();
  }
}
