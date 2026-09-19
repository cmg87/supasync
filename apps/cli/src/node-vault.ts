import { mkdir, readFile, readdir, rename, rm, stat, lstat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep, resolve } from "node:path";
import { canonicalizePath } from "@supasync/protocol";
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
      throw new Error("Unable to scan vault directory");
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = toPosix(relative(this.root, full));
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
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
      await stat(await this.abs(path));
      return true;
    } catch {
      return false;
    }
  }

  async readText(path: string): Promise<string> {
    return readFile(await this.abs(path), "utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const buf = await readFile(await this.abs(path));
    return new Uint8Array(buf);
  }

  async writeText(path: string, text: string): Promise<void> {
    await mkdir(dirname(await this.abs(path)), { recursive: true });
    await writeFile(await this.abs(path), text, "utf8");
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(await this.abs(path)), { recursive: true });
    await writeFile(await this.abs(path), bytes);
  }

  async remove(path: string): Promise<void> {
    await rm(await this.abs(path), { recursive: true, force: true });
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(await this.abs(path), { recursive: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await mkdir(dirname(await this.abs(to)), { recursive: true });
    await rename(await this.abs(from), await this.abs(to));
  }

  private async abs(path: string): Promise<string> {
    const clean = canonicalizePath(path).display;
    let current = resolve(this.root);
    for (const part of clean.split("/")) {
      current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Symlinks are not supported inside a synced vault"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return current;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}
