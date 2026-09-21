// Full installer smoke test. Creates its own installation/vault; never opens a real vault.
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import pg from "pg";
// Docker Snap has a private /tmp; bind-mounted fixtures must be under the host home.
await mkdir(resolve(".tmp"), { recursive: true });
const root = await mkdtemp(join(resolve(".tmp"), "install-test-"));
const home = join(root, "install"),
  vault = join(root, "vault");
const cli = resolve("apps/cli/dist/cli.js");
const freePort = () =>
  new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => r(port));
    });
  });
const port = await freePort(),
  dbPort = await freePort();
const environment = { ...process.env, SUPASYNC_HOME: home };
const homes = [home];
let passed = false;
const run = (args, input = "") =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, ...args], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (b) => {
      out += b;
    });
    p.stderr.on("data", (b) => {
      err += b;
    });
    p.stdin.end(input);
    p.on("error", reject);
    p.on("close", (code) =>
      code ? reject(new Error(`CLI failed: ${out}\n${err}`)) : resolve(out),
    );
  });
try {
  await mkdir(vault, { recursive: true });
  if (process.env.SUPASYNC_SOURCE_CACHE) {
    await mkdir(home, { recursive: true });
    await cp(process.env.SUPASYNC_SOURCE_CACHE, join(home, "upstream"), {
      recursive: true,
    });
  }
  console.log(`Testing isolated installation in ${root}`);
  const secret = randomUUID() + randomUUID();
  const args = [
    "setup",
    "--mode",
    "local",
    "--port",
    String(port),
    "--database-port",
    String(dbPort),
    "--vault-path",
    vault,
    "--email",
    "admin@example.test",
    "--password-stdin",
    "--yes",
  ];
  console.log(await run(args, secret));
  console.log(await run(args, secret));
  const config = JSON.parse(
    await readFile(
      join(vault, ".obsidian", "plugins", "supasync", "data.json"),
      "utf8",
    ),
  );
  assert.ok(config.vaultId && config.supabaseUrl && config.anonKey);
  assert.ok(!JSON.stringify(config).includes(secret));
  const vaults = JSON.parse(await run(["vault", "list"]));
  assert.equal(vaults.length, 1);
  console.log(
    "Installer rerun, non-secret settings, and Hermes TLS connection passed.",
  );
  const id = config.vaultId;
  const state = JSON.parse(await readFile(join(home, "install.json"), "utf8"));
  const project =
    "supasync-" +
    createHash("sha256").update(state.composeDir).digest("hex").slice(0, 12);
  const tap = execFileSync(
    "docker",
    [
      "compose",
      "--project-name",
      project,
      "--env-file",
      ".env",
      "-f",
      "docker-compose.yml",
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      cwd: state.composeDir,
      input:
        "create extension if not exists pgtap with schema extensions;set search_path to extensions,public;\n" +
        (await readFile("supabase/tests/authorization_test.sql", "utf8")),
      encoding: "utf8",
    },
  );
  assert.ok(!tap.includes("not ok"), tap);
  console.log("Authorization pgTAP: 8 checks passed.");
  await writeFile(join(root, "note.md"), "canonical plaintext\n");
  const created = JSON.parse(
    await run([
      "write",
      "--vault",
      id,
      "--path",
      "note.md",
      "--file",
      join(root, "note.md"),
      "--base-revision",
      "0",
    ]),
  );
  assert.equal(created.outcome, "accepted");
  const note = JSON.parse(
    await run(["get", "--vault", id, "--path", "note.md"]),
  );
  assert.equal(note.content, "canonical plaintext\n");
  assert.equal(
    JSON.parse(await run(["search", "--vault", id, "--query", "canonical"]))
      .length,
    1,
  );
  const login = await fetch(
    `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: config.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: secret }),
    },
  );
  assert.equal(login.status, 200);
  const session = await login.json();
  const headers = {
    apikey: config.anonKey,
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
    "Content-Profile": "supasync",
  };
  const rpc = async (name, body) => {
    const r = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const caps = await rpc("capabilities", {});
  const rejected = await fetch(
    `${config.supabaseUrl}/rest/v1/rpc/capabilities`,
    {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        "Content-Type": "application/json",
        "Content-Profile": "supasync",
      },
      body: "{}",
    },
  );
  assert.ok(rejected.status >= 400);
  const attachment = new Uint8Array([0, 255, 1, 8, 29, 98]);
  await writeFile(join(root, "attachment.bin"), attachment);
  const binary = JSON.parse(
    await run([
      "write",
      "--vault",
      id,
      "--path",
      "attachment.bin",
      "--file",
      join(root, "attachment.bin"),
      "--binary",
      "--base-revision",
      "0",
    ]),
  );
  assert.equal(binary.outcome, "accepted");
  const download = async (url, key, token, blob) => {
    const r = await fetch(`${url}/functions/v1/supasync-binary`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "download", id: blob }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    const info = await r.json(),
      bytes = await fetch(new URL(info.url, url));
    assert.ok(bytes.ok);
    assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()), attachment);
  };
  await download(
    config.supabaseUrl,
    config.anonKey,
    session.access_token,
    binary.revision.blobId,
  );
  const journal = await rpc("pull_changes", { p_vault_id: id, p_after: "0" });
  assert.equal(journal.revisions.length, 2);
  const creds = JSON.parse(await readFile(join(home, "hermes.json"), "utf8"));
  const db = new pg.Client({
    connectionString: creds.connectionString,
    ssl: { ca: creds.ca, rejectUnauthorized: true },
  });
  await db.connect();
  try {
    assert.equal(
      (await db.query("select ssl from pg_stat_ssl where pid=pg_backend_pid()"))
        .rows[0].ssl,
      true,
    );
    await assert.rejects(db.query("delete from supasync.revisions"));
  } finally {
    await db.end();
  }
  const insecure = new pg.Client({
    connectionString: creds.connectionString,
    ssl: false,
  });
  try {
    await assert.rejects(insecure.connect(), /no encryption|pg_hba/);
  } finally {
    await insecure.end().catch(() => {});
  }
  console.log(
    "Real Auth/PostgREST, TLS Hermes CRUD/search, binary Storage round trip, and journal passed.",
  );
  const backup = join(root, "backup");
  const other = JSON.parse(
    await run(["vault", "create", "--name", "Work"]),
  ).vault;
  const otherPath = join(root, "other-vault");
  await mkdir(otherPath);
  await run([
    "setup",
    "--mode",
    "local",
    "--vault-path",
    otherPath,
    "--vault-id",
    other.id,
    "--email",
    "admin@example.test",
    "--yes",
  ]);
  const otherConfig = JSON.parse(
    await readFile(
      join(otherPath, ".obsidian", "plugins", "supasync", "data.json"),
      "utf8",
    ),
  );
  assert.equal(otherConfig.vaultId, other.id);
  await run(args, secret);
  assert.equal(
    JSON.parse(
      await readFile(
        join(vault, ".obsidian", "plugins", "supasync", "data.json"),
        "utf8",
      ),
    ).vaultId,
    id,
  );
  assert.equal(JSON.parse(await run(["vault", "list"])).length, 2);
  console.log("Multiple local vaults retained their explicit remote bindings.");
  await run(["backup", "create", "--file", backup]);
  await run(["backup", "verify", "--file", backup]);
  await run(["backend", "down"]);
  const restoreHome = join(root, "restored");
  homes.push(restoreHome);
  await mkdir(restoreHome, { recursive: true });
  await cp(join(home, "upstream"), join(restoreHome, "upstream"), {
    recursive: true,
  });
  environment.SUPASYNC_HOME = restoreHome;
  const restorePort = await freePort();
  await run([
    "restore-backup",
    "--file",
    backup,
    "--port",
    String(restorePort),
    "--database-port",
    String(await freePort()),
  ]);
  const restored = JSON.parse(
    await run(["get", "--vault", id, "--path", "note.md"]),
  );
  assert.equal(restored.content, note.content);
  assert.equal(restored.id, note.id);
  const restoreConfig = JSON.parse(
    await readFile(join(restoreHome, "config.json"), "utf8"),
  );
  const restoredLogin = await fetch(
    `${restoreConfig.url}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: restoreConfig.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "admin@example.test", password: secret }),
    },
  );
  assert.equal(restoredLogin.status, 200);
  const restoredToken = (await restoredLogin.json()).access_token;
  await download(
    restoreConfig.url,
    restoreConfig.anonKey,
    restoredToken,
    binary.revision.blobId,
  );
  const restoredCaps = await fetch(
    `${restoreConfig.url}/rest/v1/rpc/capabilities`,
    {
      method: "POST",
      headers: {
        apikey: restoreConfig.anonKey,
        Authorization: `Bearer ${restoredToken}`,
        "Content-Type": "application/json",
        "Content-Profile": "supasync",
      },
      body: "{}",
    },
  );
  assert.notEqual((await restoredCaps.json()).serverEpoch, caps.serverEpoch);
  console.log(
    "Backup and fresh-install restore preserved note IDs, account login, and binary bytes; epoch rotated.",
  );
  passed = true;
} finally {
  for (const installation of homes) {
    environment.SUPASYNC_HOME = installation;
    try {
      await run(["backend", "down"]);
    } catch {}
    // Remove only this runner's Compose volumes. Paths are generated by mkdtemp above.
    try {
      const state = JSON.parse(
        await readFile(join(installation, "install.json"), "utf8"),
      );
      const { createHash } = await import("node:crypto");
      const project =
        "supasync-" +
        createHash("sha256")
          .update(state.composeDir)
          .digest("hex")
          .slice(0, 12);
      execFileSync(
        "docker",
        [
          "compose",
          "--project-name",
          project,
          "--env-file",
          ".env",
          "-f",
          "docker-compose.yml",
          "down",
          "--volumes",
        ],
        { cwd: state.composeDir, stdio: "ignore" },
      );
    } catch {}
  }
  // Bind-mounted PostgreSQL files may have another UID. Only this mkdtemp root is mounted.
  if (passed && !process.env.SUPASYNC_KEEP_TEST_ARTIFACTS) {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "0",
        "--mount",
        `type=bind,source=${root},target=/disposable`,
        "--entrypoint",
        "find",
        "postgres:17",
        "/disposable",
        "-mindepth",
        "1",
        "-delete",
      ],
      { stdio: "ignore" },
    );
    await rm(root, { recursive: true, force: true });
    console.log("Disposable installation data cleaned.");
  } else
    console.log(`Disposable test artifacts retained for inspection: ${root}`);
}
