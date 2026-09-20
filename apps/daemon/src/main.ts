import { createServer } from "node:http";
import { watch } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { atomicJson, readJson, dataHome } from "@supasync/installer";
import { openVault } from "../../cli/src/runtime.ts";
export type AttachedVault = { path: string; vaultId: string };
export async function runDaemon(port = 49582) {
  const attached =
    (await readJson<AttachedVault[]>(join(dataHome(), "attached.json"))) ?? [];
  let credential = await readJson<{ token: string }>(
    join(dataHome(), "daemon-token.json"),
  );
  if (!credential) {
    credential = { token: crypto.randomUUID() + crypto.randomUUID() };
    await atomicJson(join(dataHome(), "daemon-token.json"), credential);
  }
  const workers: Array<{
    item: AttachedVault;
    runtime: Awaited<ReturnType<typeof openVault>>;
    busy: boolean;
    again: boolean;
    deletions: Set<string>;
    lastSync: string | null;
    error: string | null;
    pending: Promise<void> | undefined;
  }> = [];
  try {
    for (const item of attached)
      workers.push({
        item,
        runtime: await openVault(item.path, item.vaultId),
        busy: false,
        again: false,
        deletions: new Set(),
        lastSync: null,
        error: null,
        pending: undefined,
      });
  } catch (error) {
    await Promise.all(workers.map((w) => w.runtime.close()));
    throw error;
  }
  const sync = (worker: (typeof workers)[number]) => {
    if (worker.pending) {
      worker.again = true;
      return worker.pending;
    }
    worker.pending = (async () => {
      worker.busy = true;
      try {
        do {
          worker.again = false;
          for (const path of worker.deletions) {
            if (!(await worker.runtime.vault.exists(path)))
              await worker.runtime.engine.deleteLocal(path);
          }
          worker.deletions.clear();
          const report = await worker.runtime.engine.cycle();
          worker.error = report.errors.length ? "SYNC_ERROR" : null;
          worker.lastSync = new Date().toISOString();
        } while (worker.again);
      } catch {
        worker.error = "SYNC_ERROR";
      } finally {
        worker.busy = false;
        worker.pending = undefined;
      }
    })();
    return worker.pending;
  };
  const watchers = workers.map((worker) => {
    try {
      return watch(
        worker.item.path,
        { recursive: process.platform !== "linux" },
        (event, name) => {
          if (event === "rename" && name) worker.deletions.add(String(name));
          void sync(worker);
        },
      );
    } catch {
      return null;
    }
  });
  const timer = setInterval(() => {
    for (const worker of workers) void sync(worker);
  }, 60000);
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const incoming = Buffer.from(
      (req.headers.authorization ?? "").replace(/^Bearer /, ""),
    );
    const expected = Buffer.from(credential!.token);
    if (
      incoming.length !== expected.length ||
      !timingSafeEqual(incoming, expected)
    ) {
      res.writeHead(401);
      res.end('{"error":"UNAUTHORIZED"}');
      return;
    }
    if (req.headers.origin && req.headers.origin !== "app://obsidian.md") {
      res.writeHead(403);
      res.end("{}");
      return;
    }
    try {
      if (req.method === "GET" && req.url === "/status") {
        res.end(
          JSON.stringify({
            version: "0.2.0",
            vaults: workers.map((w) => ({
              vaultId: w.item.vaultId,
              busy: w.busy,
              lastSync: w.lastSync,
              error: w.error,
            })),
          }),
        );
        return;
      }
      let raw = "";
      for await (const chunk of req) {
        raw += String(chunk);
        if (raw.length > 4096) {
          res.writeHead(413);
          res.end("{}");
          return;
        }
      }
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "POST" && req.url === "/release") {
        const index = workers.findIndex((w) => w.item.vaultId === body.vaultId);
        if (index >= 0) {
          const [w] = workers.splice(index, 1);
          watchers.splice(index, 1)[0]?.close();
          await w!.pending;
          await w!.runtime.close();
          await atomicJson(
            join(dataHome(), "attached.json"),
            workers.map((w) => w.item),
          );
        }
        res.end('{"released":true}');
        return;
      }
      if (req.method === "POST" && req.url === "/sync") {
        const w = workers.find((w) => w.item.vaultId === body.vaultId);
        if (!w) throw new Error("NOT_FOUND");
        await sync(w);
        res.end(JSON.stringify({ ok: !w.error }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    } catch {
      res.writeHead(400);
      res.end('{"error":"INVALID_REQUEST"}');
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    clearInterval(timer);
    for (const watcher of watchers) watcher?.close();
    await Promise.all(workers.map((w) => w.runtime.close()));
    throw error;
  }
  for (const worker of workers) void sync(worker);
  const close = async () => {
    clearInterval(timer);
    for (const watcher of watchers) watcher?.close();
    server.close();
    await Promise.all(
      workers.map(async (w) => {
        await w.pending;
        await w.runtime.close();
      }),
    );
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  return { port, close };
}
