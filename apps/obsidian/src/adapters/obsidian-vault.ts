import { normalizePath, type App, type TFile } from "obsidian";
import type { VaultAdapter, VaultStat } from "@supasync/sync-core";

export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly app: App) {}

  configDir(): string {
    return this.app.vault.configDir;
  }

  async list(): Promise<VaultStat[]> {
    const out: VaultStat[] = [];
    for (const file of this.app.vault.getAllLoadedFiles()) {
      const path = file.path;
      if ("extension" in file) {
        const tfile = file as TFile;
        out.push({ path, kind: "file", byteLength: tfile.stat.size });
      } else if (path) {
        out.push({ path, kind: "folder", byteLength: 0 });
      }
    }
    return out;
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) != null;
  }

  async readText(path: string): Promise<string> {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) throw new Error(`missing ${path}`);
    return this.app.vault.read(file);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) throw new Error(`missing ${path}`);
    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  async writeText(path: string, text: string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getFileByPath(normalized);
    if (file) {
      await this.app.vault.process(file, () => text);
      return;
    }
    await this.ensureFolder(normalized);
    await this.app.vault.create(normalized, text);
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getFileByPath(normalized);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const buffer = copy.buffer;
    if (file) {
      await this.app.vault.modifyBinary(file, buffer);
      return;
    }
    await this.ensureFolder(normalized);
    await this.app.vault.createBinary(normalized, buffer);
  }

  async remove(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file) await this.app.vault.delete(file);
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!this.app.vault.getAbstractFileByPath(normalized)) {
      await this.app.vault.createFolder(normalized);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(from));
    if (file) await this.app.vault.rename(file, normalizePath(to));
  }

  private async ensureFolder(path: string): Promise<void> {
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return;
    const folder = path.slice(0, idx);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
  }
}
