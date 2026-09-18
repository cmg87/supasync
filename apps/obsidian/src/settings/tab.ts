import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { looksLikeSecretKey } from "@supasync/client";
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

    containerEl.createEl("h3", { text: "Connection" });
    new Setting(containerEl)
      .setName("Supabase URL")
      .setDesc("Your project URL. Example: https://abcd.supabase.co")
      .addText((text) =>
        text.setValue(this.plugin.settings.supabaseUrl).onChange(async (value) => {
          this.plugin.settings.supabaseUrl = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Publishable / anon key")
      .setDesc("The public client key only. Never paste a secret or service-role key.")
      .addText((text) =>
        text.setValue(this.plugin.settings.anonKey).onChange(async (value) => {
          const trimmed = value.trim();
          if (looksLikeSecretKey(trimmed)) {
            new Notice("Service-role and secret keys are rejected.");
            text.setValue(this.plugin.settings.anonKey);
            return;
          }
          this.plugin.settings.anonKey = trimmed;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: "Account" });
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
      .setDesc("Used only to create an account or sign in. It is never saved in plugin settings.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.pendingPassword);
        text.onChange((value) => {
          this.plugin.pendingPassword = value;
        });
      });

    const sessionEmail = this.plugin.signedInEmail;
    if (sessionEmail) {
      new Setting(containerEl)
        .setName("Signed in")
        .setDesc(sessionEmail)
        .addButton((btn) =>
          btn.setButtonText("Sign out").onClick(() => this.run(() => this.plugin.signOut())),
        );
    } else {
      new Setting(containerEl)
        .setName("Sign in or create an account")
        .setDesc("Use the same email on every device that should share notes.")
        .addButton((btn) =>
          btn.setButtonText("Create account").setDisabled(this.plugin.busy).onClick(() => this.run(() => this.plugin.createAccount())),
        )
        .addButton((btn) =>
          btn.setButtonText("Sign in").setCta().setDisabled(this.plugin.busy).onClick(() => this.run(() => this.plugin.signIn())),
        );
    }

    containerEl.createEl("h3", { text: "Remote vault" });
    const vaults = this.plugin.remoteVaults;
    if (!sessionEmail) {
      new Setting(containerEl).setName("Remote vault").setDesc("Sign in to see or create your synced vault.");
    } else if (vaults.length <= 1) {
      const name = vaults[0]?.name ?? this.plugin.app.vault.getName();
      new Setting(containerEl)
        .setName("Remote vault")
        .setDesc(vaults.length === 1 ? `Using “${name}”.` : "A remote vault will be created automatically if you do not already have one.");
    } else {
      new Setting(containerEl)
        .setName("Remote vault")
        .setDesc("Choose which remote vault this Obsidian folder should sync with.")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Select a vault…");
          for (const vault of vaults) {
            dropdown.addOption(vault.id, vault.name);
          }
          dropdown.setValue(this.plugin.settings.vaultId);
          dropdown.onChange(async (value) => {
            if (!value) return;
            await this.run(() => this.plugin.selectRemoteVault(value));
          });
        });
    }
    new Setting(containerEl)
      .setName("Create new remote vault")
      .setDesc("Give it a name people can recognize. You do not need a technical ID.")
      .addText((text) => {
        text.setPlaceholder(this.plugin.app.vault.getName());
        text.setValue(this.plugin.pendingVaultName);
        text.onChange((value) => {
          this.plugin.pendingVaultName = value;
        });
      })
      .addButton((btn) =>
        btn.setButtonText("Create").setDisabled(this.plugin.busy || !sessionEmail).onClick(() =>
          this.run(() => this.plugin.createRemoteVault()),
        ),
      )
      .addButton((btn) =>
        btn.setButtonText("Refresh vaults").setDisabled(this.plugin.busy || !sessionEmail).onClick(() =>
          this.run(() => this.plugin.refreshVaults()),
        ),
      );

    containerEl.createEl("h3", { text: "Device" });
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

    containerEl.createEl("h3", { text: "Status" });
    new Setting(containerEl)
      .setName(this.plugin.statusLabel())
      .setDesc(this.plugin.statusSummary())
      .addButton((btn) =>
        btn.setButtonText("Sync now").setCta().setDisabled(this.plugin.busy).onClick(() => this.run(() => this.plugin.syncNow())),
      );

    if (this.plugin.settings.vaultId) {
      containerEl.createEl("h3", { text: "Advanced" });
      new Setting(containerEl)
        .setName("Remote vault ID")
        .setDesc("Diagnostic only. Normal setup never requires typing this.")
        .addText((text) => text.setValue(this.plugin.settings.vaultId).setDisabled(true));
    }
  }

  private async run(work: () => Promise<unknown>): Promise<void> {
    if (this.plugin.busy) return;
    this.plugin.busy = true;
    this.display();
    try {
      await work();
    } catch (error) {
      this.plugin.reportError(error, "Request failed");
    } finally {
      this.plugin.busy = false;
      this.display();
    }
  }
}
