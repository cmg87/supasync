import { digestCanonical, type EncryptedValue } from "@supasync/protocol";
import {
  randomKey,
  recoveryKey,
  wrapRecovery,
  unwrapRecovery,
  encrypt,
  decrypt,
  encode,
  unencode,
} from "@supasync/crypto";
import type { SecretStore } from "./auth.ts";
type KeyRecord = { master: string; recovery?: string; verified: boolean };
/** Only use an OS/Obsidian secret store (or the explicitly reported user-only CLI fallback). */
export class VaultKeys {
  constructor(
    private secrets: SecretStore,
    private backend: string,
    private installation: string,
  ) {}
  private async id(vaultId: string) {
    return `supasync-key-${(await digestCanonical([this.backend, this.installation, vaultId])).slice(0, 51)}`;
  }
  private async record(vaultId: string): Promise<KeyRecord | null> {
    const raw = await this.secrets.get(await this.id(vaultId));
    if (!raw) return null;
    const r = JSON.parse(raw) as KeyRecord;
    if (unencode(r.master).length !== 32)
      throw new Error("Invalid cached vault key");
    return r;
  }
  async get(vaultId: string): Promise<Uint8Array | null> {
    const r = await this.record(vaultId);
    return r?.verified ? unencode(r.master) : null;
  }
  async pendingRecovery(vaultId: string): Promise<string | null> {
    const r = await this.record(vaultId);
    return r && !r.verified ? (r.recovery ?? null) : null;
  }
  async create<T>(
    label: string,
    commit: (plan: {
      vaultId: string;
      encryptedLabel: EncryptedValue;
      recoveryEnvelope: EncryptedValue;
    }) => Promise<T>,
  ): Promise<T> {
    const id = await this.id("pending-provision");
    const raw = await this.secrets.get(id);
    let pending = raw
      ? (JSON.parse(raw) as {
          label: string;
          plan: {
            vaultId: string;
            encryptedLabel: EncryptedValue;
            recoveryEnvelope: EncryptedValue;
          };
        })
      : null;
    if (pending && pending.label !== label)
      throw new Error(
        "A vault creation is pending. Retry with its original name before creating another vault.",
      );
    if (!pending) {
      pending = { label, plan: await this.prepare(crypto.randomUUID(), label) };
      await this.secrets.set(id, JSON.stringify(pending));
    }
    const result = await commit(pending.plan);
    await this.secrets.set(id, "");
    return result;
  }
  async prepare(vaultId: string, label: string) {
    const master = randomKey();
    const recovery = recoveryKey();
    const encryptedLabel = encrypt(master, new TextEncoder().encode(label), {
      vaultId,
      entryId: vaultId,
      objectId: "label",
      purpose: "name",
      keyVersion: 1,
    });
    const recoveryEnvelope = wrapRecovery(master, recovery, vaultId);
    await this.secrets.set(
      await this.id(vaultId),
      JSON.stringify({ master: encode(master), recovery, verified: false }),
    );
    master.fill(0);
    return { vaultId, encryptedLabel, recoveryEnvelope };
  }
  async recover(
    vaultId: string,
    envelope: EncryptedValue,
    recovery: string,
  ): Promise<void> {
    const master = unwrapRecovery(envelope, recovery, vaultId);
    await this.secrets.set(
      await this.id(vaultId),
      JSON.stringify({ master: encode(master), verified: true }),
    );
    master.fill(0);
  }
  async enroll(vaultId: string, master: Uint8Array): Promise<void> {
    if (master.length !== 32) throw new Error("Invalid vault key");
    await this.secrets.set(
      await this.id(vaultId),
      JSON.stringify({ master: encode(master), verified: true }),
    );
  }
  async label(
    vaultId: string,
    envelope: EncryptedValue,
  ): Promise<string | null> {
    const key = await this.get(vaultId);
    if (!key) return null;
    try {
      return new TextDecoder().decode(
        decrypt(key, envelope, {
          vaultId,
          entryId: vaultId,
          objectId: "label",
          purpose: "name",
          keyVersion: 1,
        }),
      );
    } finally {
      key.fill(0);
    }
  }
}
