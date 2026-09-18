import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SupaSyncPlugin from "../main.ts";

export class SupaSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SupaSyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "SupaSync" });
    new Setting(containerEl)
      .setName("Supabase URL")
      .setDesc("Project URL only. Never paste a service-role key.")
      .addText((text) =>
        text.setValue(this.plugin.settings.supabaseUrl).onChange(async (value) => {
          this.plugin.settings.supabaseUrl = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Publishable / anon key")
      .addText((text) =>
        text.setValue(this.plugin.settings.anonKey).onChange(async (value) => {
          if (value.includes("service_role")) {
            new Notice("Service-role keys are rejected.");
            return;
          }
          this.plugin.settings.anonKey = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Email")
      .addText((text) =>
        text.setValue(this.plugin.settings.email).onChange(async (value) => {
          this.plugin.settings.email = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Password")
      .setDesc("Used only to sign in. It is not stored in plugin settings.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.onChange((value) => {
          this.plugin.pendingPassword = value;
        });
      });
    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("Sign in").setCta().onClick(async () => {
        await this.plugin.signIn();
      }),
    );
    new Setting(containerEl)
      .setName("Remote vault id")
      .addText((text) =>
        text.setValue(this.plugin.settings.vaultId).onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Device label")
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceLabel).onChange(async (value) => {
          this.plugin.settings.deviceLabel = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Auto-sync")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
