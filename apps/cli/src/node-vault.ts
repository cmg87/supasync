import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import type { VaultAdapter, VaultStat } from "@supasync/sync-core";

export class NodeVault implements VaultAdapter {
  constructor(
    private readonly root: string,
    private readonly config = ".obsidian",
  ) {}

  configDir(): string {
    return this.config;
  }

  async list(): Promise<VaultStat[]> {
    const out: VaultStat[] = [];
    await this.walk(this.root, out);
    return out;
  }

  private async walk(dir: string, out: VaultStat[]): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = toPosix(relative(this.root, full));
      const info = await stat(full);
      if (info.isDirectory()) {
        out.push({ path: rel, kind: "folder", byteLength: 0 });
        await this.walk(full, out);
      } else if (info.isFile()) {
        out.push({ path: rel, kind: "file", byteLength: info.size });
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }

  async readText(path: string): Promise<string> {
    return readFile(this.abs(path), "utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const buf = await readFile(this.abs(path));
    return new Uint8Array(buf);
  }

  async writeText(path: string, text: string): Promise<void> {
    await mkdir(dirname(this.abs(path)), { recursive: true });
    await writeFile(this.abs(path), text, "utf8");
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(this.abs(path)), { recursive: true });
    await writeFile(this.abs(path), bytes);
  }

  async remove(path: string): Promise<void> {
    await rm(this.abs(path), { recursive: true, force: true });
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.abs(path), { recursive: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await mkdir(dirname(this.abs(to)), { recursive: true });
    await rename(this.abs(from), this.abs(to));
  }

  private abs(path: string): string {
    return join(this.root, path.split("/").join(sep));
  }
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}
