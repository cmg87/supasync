import QRCode from "qrcode";
import jsQR from "jsqr";
import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
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

    containerEl.createEl("p", {
      text: this.plugin.signedInEmail
        ? "Your account is connected. SupaSync keeps this vault in sync across your devices."
        : "Sign in or create an account to connect this vault. SupaSync will set up your remote vault automatically.",
    });
    if (this.plugin.authMessage) {
      const message = containerEl.createEl("p", {
        text: this.plugin.authMessage,
        cls: "supasync-message",
      });
      message.setAttribute("role", "status");
    }
    if (!this.plugin.signedInEmail) {
      new Setting(containerEl)
        .setName("Import connection profile")
        .addTextArea((text) =>
          text.setValue(this.plugin.pendingConnection).onChange((value) => {
            this.plugin.pendingConnection = value;
          }),
        )
        .addButton((button) =>
          button
            .setButtonText("Connect")
            .onClick(() => this.run(() => this.plugin.importConnection())),
        );
    }
    {
      const scan = containerEl.createEl("input", { type: "file" });
      scan.accept = "image/*";
      scan.setAttribute("capture", "environment");
      scan.setAttribute("aria-label", "Scan setup or recovery QR image");
      scan.onchange = async () => {
        try {
          const file = scan.files?.[0];
          if (!file) return;
          const bitmap = await createImageBitmap(file);
          const canvas = document.createElement("canvas");
          const scale = Math.min(
            1,
            1600 / Math.max(bitmap.width, bitmap.height),
          );
          canvas.width = Math.round(bitmap.width * scale);
          canvas.height = Math.round(bitmap.height * scale);
          const context = canvas.getContext("2d")!;
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          );
          const result = jsQR(pixels.data, pixels.width, pixels.height);
          if (!result) throw new Error("No QR code found");
          if (result.data.startsWith("ssr1-"))
            this.plugin.pendingRecovery = result.data;
          else {
            const data = JSON.parse(result.data);
            if (data.pairingId) this.plugin.pendingPairing = result.data;
            else this.plugin.pendingConnection = result.data;
          }
          this.display();
        } catch (error) {
          this.plugin.reportError(error, "Could not read QR");
        }
      };
    }
    const connection = containerEl.createEl("details");
    connection.open =
      !this.plugin.settings.supabaseUrl || !this.plugin.settings.anonKey;
    connection.createEl("summary", { text: "Supabase connection" });
    new Setting(connection)
      .setName("Supabase URL")
      .setDesc("Your project URL. Example: https://abcd.supabase.co")
      .addText((text) =>
        text
          .setDisabled(this.plugin.busy || Boolean(this.plugin.signedInEmail))
          .setValue(this.plugin.settings.supabaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.supabaseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(connection)
      .setName("Publishable / anon key")
      .setDesc(
        "The public client key only. Never paste a secret or service-role key.",
      )
      .addText((text) =>
        text
          .setDisabled(this.plugin.busy || Boolean(this.plugin.signedInEmail))
          .setValue(this.plugin.settings.anonKey)
          .onChange(async (value) => {
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
    if (!this.plugin.signedInEmail) {
      new Setting(containerEl).setName("Email").addText((text) =>
        text
          .setDisabled(this.plugin.busy)
          .setValue(this.plugin.settings.email)
          .onChange(async (value) => {
            this.plugin.settings.email = value.trim();
            await this.plugin.saveSettings();
          }),
      );
      new Setting(containerEl)
        .setName("Password")
        .setDesc(
          "Used only to create an account or sign in. It is never saved in plugin settings.",
        )
        .addText((text) => {
          text.setDisabled(this.plugin.busy);
          text.inputEl.type = "password";
          text.inputEl.autocomplete = "current-password";
          text.setValue(this.plugin.pendingPassword);
          text.onChange((value) => {
            this.plugin.pendingPassword = value;
          });
        });
    }

    const sessionEmail = this.plugin.signedInEmail;
    if (sessionEmail) {
      new Setting(containerEl)
        .setName("Signed in")
        .setDesc(sessionEmail)
        .addButton((btn) =>
          btn
            .setButtonText("Sign out")
            .setDisabled(this.plugin.busy)
            .onClick(() => this.run(() => this.plugin.signOut())),
        );
    } else {
      new Setting(containerEl)
        .setName("Sign in or create an account")
        .setDesc("Use the same email on every device that should share notes.")
        .addButton((btn) =>
          btn
            .setButtonText(this.plugin.busy ? "Please wait…" : "Create account")
            .setDisabled(this.plugin.busy)
            .onClick(() => this.run(() => this.plugin.createAccount())),
        )
        .addButton((btn) =>
          btn
            .setButtonText(this.plugin.busy ? "Please wait…" : "Sign in")
            .setCta()
            .setDisabled(this.plugin.busy)
            .onClick(() => this.run(() => this.plugin.signIn())),
        );
    }

    if (!sessionEmail) return;

    containerEl.createEl("h3", { text: "Encryption" });
    new Setting(containerEl)
      .setName(this.plugin.encryptionStatus)
      .setDesc(
        "Your notes and filenames are encrypted on this device before upload.",
      );
    if (this.plugin.recoveryToSave) {
      containerEl.createEl("p", {
        text: "Save this recovery key outside your vault. Losing all enrolled devices and this key means your encrypted notes cannot be recovered.",
      });
      containerEl.createEl("code", { text: this.plugin.recoveryToSave });
      const qr = containerEl.createEl("img", {
        attr: { alt: "Recovery key QR code" },
      });
      void QRCode.toDataURL(this.plugin.recoveryToSave, { width: 240 }).then(
        (url) => {
          qr.src = url;
        },
      );
    }
    if (this.plugin.encryptionStatus !== "Unlocked") {
      new Setting(containerEl)
        .setName(
          this.plugin.recoveryToSave
            ? "Verify your saved recovery key"
            : "Enter recovery key",
        )
        .addText((text) => {
          text.inputEl.type = "password";
          text.setValue(this.plugin.pendingRecovery).onChange((value) => {
            this.plugin.pendingRecovery = value;
          });
        })
        .addButton((button) =>
          button
            .setButtonText("Unlock")
            .setDisabled(this.plugin.busy)
            .onClick(() => this.run(() => this.plugin.unlockEncryption())),
        );
    }

    containerEl.createEl("h3", { text: "Remote vault" });
    const vaults = this.plugin.remoteVaults;
    if (vaults.length <= 1) {
      const name = vaults[0]?.name ?? this.plugin.app.vault.getName();
      new Setting(containerEl)
        .setName("Remote vault")
        .setDesc(
          vaults.length === 1
            ? `Using “${name}”.`
            : "A remote vault will be created automatically if you do not already have one.",
        );
    } else {
      new Setting(containerEl)
        .setName("Remote vault")
        .setDesc(
          "Choose which remote vault this Obsidian folder should sync with.",
        )
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
      .setDesc(
        "Give it a name people can recognize. You do not need a technical ID.",
      )
      .addText((text) => {
        text.setPlaceholder(this.plugin.app.vault.getName());
        text.setValue(this.plugin.pendingVaultName);
        text.onChange((value) => {
          this.plugin.pendingVaultName = value;
        });
      })
      .addButton((btn) =>
        btn
          .setButtonText("Create")
          .setDisabled(this.plugin.busy || !sessionEmail)
          .onClick(() => this.run(() => this.plugin.createRemoteVault())),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Refresh vaults")
          .setDisabled(this.plugin.busy || !sessionEmail)
          .onClick(() => this.run(() => this.plugin.refreshVaults())),
      );

    if (sessionEmail && this.plugin.settings.vaultId) {
      const devices = containerEl.createEl("details");
      devices.createEl("summary", { text: "Recovery and devices" });
      new Setting(devices)
        .setName("Enroll using another device")
        .setDesc(
          "Generate a request here, approve it on an unlocked device, then finish here. Requests expire after 10 minutes.",
        )
        .addButton((b) =>
          b
            .setButtonText("New pairing request")
            .onClick(() => this.run(() => this.plugin.beginPairing())),
        );
      if (this.plugin.pairingToShow) {
        devices.createEl("code", { text: this.plugin.pairingToShow });
        const qr = devices.createEl("canvas");
        void QRCode.toCanvas(qr, this.plugin.pairingToShow, { width: 280 });
      }
      new Setting(devices)
        .setName("Pairing request")
        .setDesc(
          "Paste or scan the request directly from the new device. Compare its public key before approval.",
        )
        .addTextArea((t) =>
          t.setValue(this.plugin.pendingPairing).onChange((v) => {
            this.plugin.pendingPairing = v;
          }),
        )
        .addButton((b) =>
          b
            .setButtonText("Approve on this device")
            .onClick(() => this.run(() => this.plugin.completePairing(true))),
        )
        .addButton((b) =>
          b
            .setButtonText("Finish enrollment")
            .onClick(() => this.run(() => this.plugin.completePairing(false))),
        );
      new Setting(devices)
        .setName("Registered devices")
        .addButton((b) =>
          b
            .setButtonText("Refresh")
            .onClick(() => this.run(() => this.plugin.refreshDevices())),
        );
      for (const device of this.plugin.devices)
        new Setting(devices)
          .setName(device.clientId)
          .setDesc(device.revoked ? "Revoked" : "Access enabled")
          .addButton((b) =>
            b
              .setButtonText("Revoke")
              .setDisabled(device.revoked)
              .onClick(() =>
                this.run(() => this.plugin.revokeDevice(device.clientId)),
              ),
          );
    }
    if (Platform.isDesktopApp) {
      containerEl.createEl("h3", { text: "Optional desktop daemon" });
      new Setting(containerEl)
        .setName("Local daemon token")
        .setDesc(
          "Run supasync daemon token on this computer. Stored only in SecretStorage.",
        )
        .addText((text) => {
          text.inputEl.type = "password";
          text.onChange((value) => {
            this.plugin.pendingDaemonToken = value;
          });
        });
      new Setting(containerEl)
        .setName("Delegate sync to daemon")
        .setDesc(
          "Attach and unlock this local vault in supasyncd first. Sync stays paused if the daemon is unavailable.",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.daemonEnabled)
            .onChange((value) =>
              this.run(() => this.plugin.configureDaemon(value)),
            ),
        );
    }
    containerEl.createEl("h3", { text: "Device" });
    new Setting(containerEl).setName("Device label").addText((text) =>
      text
        .setValue(this.plugin.settings.deviceLabel)
        .onChange(async (value) => {
          this.plugin.settings.deviceLabel = value.trim();
          await this.plugin.saveSettings();
        }),
    );
    new Setting(containerEl).setName("Auto-sync").addToggle((toggle) =>
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
        btn
          .setButtonText("Sync now")
          .setCta()
          .setDisabled(this.plugin.busy)
          .onClick(() => this.run(() => this.plugin.syncNow())),
      );

    if (this.plugin.settings.vaultId) {
      containerEl.createEl("h3", { text: "Advanced" });
      new Setting(containerEl)
        .setName("Remote vault ID")
        .setDesc("Diagnostic only. Normal setup never requires typing this.")
        .addText((text) =>
          text.setValue(this.plugin.settings.vaultId).setDisabled(true),
        );
    }
  }

  private async run(work: () => Promise<unknown>): Promise<void> {
    if (this.plugin.busy) return;
    this.plugin.busy = true;
    this.plugin.authMessage = "";
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
