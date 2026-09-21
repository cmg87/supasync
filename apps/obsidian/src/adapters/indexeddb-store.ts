import { seqZero } from "@supasync/protocol";
import type {
  ApplyIntent,
  LocalStore,
  ManifestRow,
  MetaState,
  OutboxRow,
} from "@supasync/sync-core";

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of ["meta", "manifest", "outbox", "intents", "cache"]) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbStore implements LocalStore {
  async getCache<T>(key: string): Promise<T | null> {
    const db = await this.db();
    return (
      (await req<T | undefined>(
        db.transaction("cache").objectStore("cache").get(key),
      )) ?? null
    );
  }
  async putCache(key: string, value: unknown): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("cache", "readwrite");
    tx.objectStore("cache").put(value, key);
    await complete(tx);
  }
  constructor(private readonly name: string) {}

  private dbPromise?: Promise<IDBDatabase>;
  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb(this.name);
    return this.dbPromise;
  }

  async getMeta(): Promise<MetaState> {
    const db = await this.db();
    const value = await req<MetaState | undefined>(
      db.transaction("meta").objectStore("meta").get("current"),
    );
    return (
      value ?? {
        installationId: crypto.randomUUID(),
        clientId: crypto.randomUUID(),
        vaultId: null,
        serverEpoch: null,
        receivedCursor: seqZero(),
        appliedCursor: seqZero(),
        label: "obsidian",
        platform: "obsidian",
      }
    );
  }

  async putMeta(meta: MetaState): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(meta, "current");
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getManifest(): Promise<Map<string, ManifestRow>> {
    const db = await this.db();
    const rows = await req<ManifestRow[]>(
      db.transaction("manifest").objectStore("manifest").getAll(),
    );
    return new Map((rows ?? []).map((row) => [row.entryId, row]));
  }

  async putManifest(row: ManifestRow): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("manifest", "readwrite");
    tx.objectStore("manifest").put(row, row.entryId);
    await complete(tx);
  }

  async deleteManifest(entryId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("manifest", "readwrite");
    tx.objectStore("manifest").delete(entryId);
    await complete(tx);
  }

  async listOutbox(): Promise<OutboxRow[]> {
    const db = await this.db();
    return (
      (await req<OutboxRow[]>(
        db.transaction("outbox").objectStore("outbox").getAll(),
      )) ?? []
    );
  }

  async putOutbox(row: OutboxRow): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").put(row, row.operationId);
    await complete(tx);
  }

  async deleteOutbox(operationId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").delete(operationId);
    await complete(tx);
  }

  async putIntent(intent: ApplyIntent): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("intents", "readwrite");
    tx.objectStore("intents").put(intent, intent.path);
    await complete(tx);
  }

  async getIntent(path: string): Promise<ApplyIntent | null> {
    const db = await this.db();
    return (
      (await req<ApplyIntent | undefined>(
        db.transaction("intents").objectStore("intents").get(path),
      )) ?? null
    );
  }

  async deleteIntent(path: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("intents", "readwrite");
    tx.objectStore("intents").delete(path);
    await complete(tx);
  }

  async listIntents(): Promise<ApplyIntent[]> {
    const db = await this.db();
    return (
      (await req<ApplyIntent[]>(
        db.transaction("intents").objectStore("intents").getAll(),
      )) ?? []
    );
  }
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
