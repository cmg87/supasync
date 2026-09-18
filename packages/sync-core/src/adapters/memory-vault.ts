import { parentDisplayPath } from "@supasync/protocol";
import type { VaultAdapter, VaultStat } from "../types.ts";

export class MemoryVault implements VaultAdapter {
  private files = new Map<string, Uint8Array>();
  private folders = new Set<string>();

  constructor(private readonly config = ".obsidian") {}

  configDir(): string {
    return this.config;
  }

  async list(): Promise<VaultStat[]> {
    const out: VaultStat[] = [];
    for (const folder of this.folders) {
      out.push({ path: folder, kind: "folder", byteLength: 0 });
    }
    for (const [path, bytes] of this.files) {
      out.push({ path, kind: "file", byteLength: bytes.byteLength });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`missing ${path}`);
    return bytes;
  }

  async writeText(path: string, text: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(text));
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await this.ensureParents(path);
    this.files.set(path, bytes);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.folders.delete(path);
    for (const child of [...this.files.keys()]) {
      if (child.startsWith(`${path}/`)) this.files.delete(child);
    }
    for (const child of [...this.folders]) {
      if (child.startsWith(`${path}/`)) this.folders.delete(child);
    }
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
    let parent = parentDisplayPath(path);
    while (parent) {
      this.folders.add(parent);
      parent = parentDisplayPath(parent);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.files.has(from)) {
      const bytes = this.files.get(from)!;
      this.files.delete(from);
      await this.writeBytes(to, bytes);
    }
    if (this.folders.has(from)) {
      this.folders.delete(from);
      await this.mkdir(to);
      for (const [path, bytes] of [...this.files]) {
        if (path.startsWith(`${from}/`)) {
          this.files.delete(path);
          this.files.set(to + path.slice(from.length), bytes);
        }
      }
    }
  }

  private async ensureParents(path: string): Promise<void> {
    let parent = parentDisplayPath(path);
    while (parent) {
      this.folders.add(parent);
      parent = parentDisplayPath(parent);
    }
  }
}
