import pg from "pg";
import { join } from "node:path";
import { readFile, readdir, unlink } from "node:fs/promises";
import { atomicJson, dataHome, readJson } from "@supasync/installer";
import {
  digestCanonical,
  hashBytes,
  unencode,
  type CommitEnvelope,
  type CommitResult,
} from "@supasync/protocol";

export async function database() {
  const saved = await readJson<{ connectionString: string; ca?: string }>(
    join(dataHome(), "hermes.json"),
  );
  const value = process.env.SUPASYNC_DATABASE_URL ?? saved?.connectionString;
  if (!value)
    throw new Error("Set SUPASYNC_DATABASE_URL or run supasync setup");
  const u = new URL(value);
  if (!["postgres:", "postgresql:"].includes(u.protocol))
    throw new Error("Invalid PostgreSQL connection string");
  const ca = process.env.SUPASYNC_DATABASE_CA
    ? await readFile(process.env.SUPASYNC_DATABASE_CA, "utf8")
    : saved?.ca;
  const client = new pg.Client({
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.slice(1) || "postgres",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
  });
  await client.connect();
  const result = await client.query(
    "select supasync.capabilities() as capabilities",
  );
  return {
    client,
    capabilities: result.rows[0].capabilities,
    close: () => client.end(),
  };
}
export async function durableMutation(
  client: pg.Client,
  request: CommitEnvelope,
): Promise<CommitResult> {
  if (!/^[a-f0-9-]{36}$/i.test(request.operationId))
    throw new Error("Invalid operation UUID");
  const directory = join(dataHome(), "outbox-v3");
  const file = join(directory, `${request.operationId}.json`);
  const existing = await readJson<CommitEnvelope>(file);
  if (
    existing &&
    (await digestCanonical(existing)) !== (await digestCanonical(request))
  )
    throw new Error("ID_REUSE");
  await atomicJson(file, request);
  const wire = structuredClone(request);
  if (typeof wire.payload.bytes === "string") {
    const bytes = unencode(wire.payload.bytes),
      id = request.operationId;
    const reserved = await client.query(
      "select supasync.reserve_blob($1,$2,$3,$4) as blob",
      [id, request.vaultId, await hashBytes(bytes), bytes.length],
    );
    const blob = reserved.rows[0].blob;
    if (!blob.ready) {
      const transfer = await binaryTransfer("upload", id, blob.token);
      const response = await fetch(transfer.url, {
        method: transfer.method,
        headers: transfer.headers,
        body: bytes as unknown as BodyInit,
      });
      if (!response.ok) throw new Error("Attachment upload failed");
      await binaryTransfer("finalize", id, blob.token);
    }
    delete wire.payload.bytes;
    wire.payload.blob_id = id;
  }
  const result = await client.query(
    "select supasync.mutate($1::jsonb) as result",
    [JSON.stringify(wire)],
  );
  // Keep a receipt locally before retiring the pending payload.
  await atomicJson(
    join(dataHome(), "receipts-v3", `${request.operationId}.json`),
    result.rows[0].result,
  );
  await unlink(file);
  return result.rows[0].result;
}
export async function binaryTransfer(
  action: string,
  id: string,
  token: string,
) {
  const config = await readJson<{ url: string; anonKey: string }>(
    join(dataHome(), "config.json"),
  );
  const url = process.env.SUPASYNC_URL ?? config?.url;
  if (!url) throw new Error("Set SUPASYNC_URL for binary transfers");
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(endpoint.hostname)
  )
    throw new Error("HTTPS_REQUIRED");
  const response = await fetch(
    `${url.replace(/\/$/, "")}/functions/v1/supasync-binary`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPASYNC_PUBLIC_KEY ?? config?.anonKey ?? "",
      },
      body: JSON.stringify({ action, id, token }),
    },
  );
  if (!response.ok) throw new Error("Binary transfer failed");
  const result = await response.json();
  if (result.url?.startsWith("/"))
    result.url = url.replace(/\/$/, "") + result.url;
  return result;
}
export async function retryPending(client: pg.Client) {
  const directory = join(dataHome(), "outbox-v3");
  const files = await readdir(directory).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  const results = [];
  for (const file of files) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(file)) continue;
    const request = await readJson<CommitEnvelope>(join(directory, file));
    if (request) results.push(await durableMutation(client, request));
  }
  return results;
}
