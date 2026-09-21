import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  atomicJson,
  readJson,
  compose,
  databaseSql,
  waitForHealth,
  type InstallState,
} from "./index.ts";
function docker(state: InstallState, args: string[]) {
  if (!state.composeDir) throw new Error("A self-hosted backend is required");
  const name = `supasync-${createHash("sha256").update(state.composeDir).digest("hex").slice(0, 12)}`;
  return spawn(
    "docker",
    [
      "compose",
      "--project-name",
      name,
      "--env-file",
      ".env",
      "-f",
      "docker-compose.yml",
      ...args,
    ],
    { cwd: state.composeDir, stdio: ["pipe", "pipe", "pipe"] },
  );
}
async function exportFile(state: InstallState, args: string[], file: string) {
  const child = docker(state, args);
  child.stdin.end();
  child.stderr.resume();
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Backup export failed")),
    );
  });
  await Promise.all([
    pipeline(
      child.stdout,
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
    ),
    done,
  ]);
}
async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
export async function createBackup(state: InstallState, directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length)
    throw new Error("Backup destination must be empty");
  // pg_dump takes one consistent database snapshot. Ready objects are immutable and
  // retained indefinitely; copying Storage afterwards is a safe superset of that snapshot.
  await exportFile(
    state,
    [
      "exec",
      "-T",
      "db",
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--format=custom",
      "--data-only",
      "--schema=auth",
      "--schema=storage",
      "--schema=supasync",
      "--exclude-table-data=auth.schema_migrations",
      "--exclude-table-data=storage.migrations",
      "--schema=supasync_private",
      "--no-owner",
      "--no-acl",
    ],
    join(directory, "database.dump"),
  );
  await exportFile(
    state,
    ["exec", "-T", "storage", "tar", "-cf", "-", "-C", "/var/lib/storage", "."],
    join(directory, "storage.tar"),
  );
  await atomicJson(join(directory, "manifest.json"), {
    format: 1,
    createdAt: new Date().toISOString(),
    backendRelease: state.release,
    protocolVersion: 3,
    databaseHash: await digest(join(directory, "database.dump")),
    storageHash: await digest(join(directory, "storage.tar")),
    retention: "immutable ready objects; no garbage collection",
  });
  return {
    directory,
    next: "Test restoration into a separate empty installation.",
  };
}
export async function verifyBackup(directory: string) {
  const manifest = await readJson<{
    format: number;
    protocolVersion: number;
    databaseHash: string;
    storageHash: string;
  }>(join(directory, "manifest.json"));
  if (!manifest || manifest.format !== 1 || manifest.protocolVersion !== 3)
    throw new Error("Unsupported backup");
  for (const [name, hash] of [
    ["database.dump", manifest.databaseHash],
    ["storage.tar", manifest.storageHash],
  ])
    if ((await digest(join(directory, name!))) !== hash)
      throw new Error("Backup checksum mismatch");
  return {
    verified: true,
    scope: "Archive byte integrity",
    restoreTest: "Still required in an isolated installation",
    contents: "Plaintext database and private binary objects",
  };
}

async function importFile(state: InstallState, args: string[], file: string) {
  const child = docker(state, args);
  child.stdout.resume();
  child.stderr.resume();
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Restore failed; services remain stopped. Keep the backup and inspect the isolated target.",
            ),
          ),
    );
  });
  await Promise.all([pipeline(createReadStream(file), child.stdin), done]);
}
/** Restore only into a fresh matching installation. Never clear a user's existing vaults. */
export async function restoreBackup(state: InstallState, directory: string) {
  await verifyBackup(directory);
  const manifest = await readJson<{ backendRelease: string }>(
    join(directory, "manifest.json"),
  );
  if (manifest?.backendRelease !== state.release)
    throw new Error("Restore requires the same pinned backend release");
  const count = await compose(state, [
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-At",
    "-c",
    "select (select count(*) from auth.users)+(select count(*) from supasync.vaults)+(select count(*) from storage.objects)",
  ]);
  if (count.trim() !== "0")
    throw new Error(
      "Restore target is not empty; use a separate SUPASYNC_HOME and port",
    );
  // Remove the empty seed through Storage's supported API before restoring its archived row.
  const env = await readFile(join(state.composeDir!, ".env"), "utf8");
  const serviceKey = /^SERVICE_ROLE_KEY=(.*)$/m.exec(env)?.[1];
  if (!serviceKey) throw new Error("Target backend credential unavailable");
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const listed = await fetch(`${state.endpoint}/storage/v1/bucket`, {
    headers,
  });
  if (!listed.ok) throw new Error("Target Storage API is unavailable");
  const buckets = (await listed.json()) as Array<{ id: string }>;
  if (buckets.some((b) => b.id === "supasync-blobs")) {
    const deleted = await fetch(
      `${state.endpoint}/storage/v1/bucket/supasync-blobs`,
      { method: "DELETE", headers },
    );
    if (!deleted.ok) throw new Error("Could not remove the empty seed bucket");
  }
  // Stop the gateway too: no requests may enter during restore, and its upstream
  // DNS/connection state must be rebuilt when the stopped services reconnect.
  await compose(state, [
    "stop",
    "api-gw",
    "functions",
    "auth",
    "rest",
    "storage",
  ]);
  await compose(state, [
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-c",
    "delete from supasync.settings",
  ]);
  await importFile(
    state,
    [
      "exec",
      "-T",
      "db",
      "pg_restore",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "--data-only",
      "--disable-triggers",
      "--single-transaction",
      "--exit-on-error",
    ],
    join(directory, "database.dump"),
  );
  // A one-off container mounts the same official Storage volume without serving requests.
  await importFile(
    state,
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "tar",
      "storage",
      "-xf",
      "-",
      "-C",
      "/var/lib/storage",
    ],
    join(directory, "storage.tar"),
  );
  await databaseSql(
    state,
    "update supasync.settings set epoch=gen_random_uuid() where id;",
  );
  await compose(state, ["up", "-d", "--wait"]);
  await waitForHealth(state);
  return {
    restored: true,
    next: "Sign in with the restored admin account. Verify notes and attachments before switching devices.",
  };
}
