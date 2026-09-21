import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform, arch } from "node:os";
import { join, dirname, resolve } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  cp,
  stat,
  readdir,
} from "node:fs/promises";
import { createHmac, randomBytes, createHash } from "node:crypto";
import { createServer } from "node:net";
import { parse, stringify } from "yaml";
import QRCode from "qrcode";
import { generate } from "selfsigned";
import { restoreBackup, verifyBackup } from "./backup.ts";
const exec = promisify(execFile);
export const SELF_HOST_RELEASE = "self-hosted/v0.8.1";
export const SELF_HOST_COMMIT = "8c7a4d9dbbaf8b552893822e89d7bf06f33f9220";
export const VERSION = "0.3.0";
export const dataHome = () =>
  resolve(process.env.SUPASYNC_HOME ?? join(homedir(), ".config", "supasync"));
export type InstallState = {
  version: string;
  mode: string;
  endpoint: string;
  publicKey?: string;
  release?: string;
  composeDir?: string;
  tasks: string[];
  vaults: Array<{ path: string; vaultId?: string }>;
  vaultId?: string;
  adminEmail?: string;
  databasePort?: number;
  protocolVersion: 3;
};
export async function atomicJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
  await chmod(file, 0o600);
}
export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export const readState = () =>
  readJson<InstallState>(join(dataHome(), "install.json"));
export async function run(
  command: string,
  args: string[],
  cwd?: string,
  input?: string,
): Promise<string> {
  if (input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        args,
        { cwd, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) =>
          error
            ? reject(
                new Error(
                  `${command} failed (${error.code ?? "unknown"}): ${stderr.split("\n").find((line) => line.startsWith("ERROR:") || line.startsWith("FATAL:")) ?? "inspect local service health"}`,
                ),
              )
            : resolve(stdout),
      );
      child.stdin?.end(input);
    });
  }
  try {
    return (
      await exec(command, args, { cwd, maxBuffer: 8 * 1024 * 1024 })
    ).stdout.trim();
  } catch (error) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${String((error as { stderr?: string }).stderr ?? "verify installation and service health").slice(-2000)}`,
    );
  }
}
async function check(command: string, args: string[]) {
  try {
    return await run(command, args);
  } catch {
    return null;
  }
}
export async function discover() {
  const [docker, compose, tailscale, supabase, obsidian] = await Promise.all([
    check("docker", ["info", "--format", "{{.ServerVersion}}"]),
    check("docker", ["compose", "version", "--short"]),
    check("tailscale", ["status", "--json"]),
    check("supabase", ["--version"]),
    check(platform() === "win32" ? "where" : "which", ["obsidian"]),
  ]);
  let tail: { BackendState?: string; Self?: { DNSName?: string } } = {};
  try {
    tail = JSON.parse(tailscale ?? "{}");
  } catch {}
  const vaults: string[] = [];
  const config =
    platform() === "darwin"
      ? join(
          homedir(),
          "Library",
          "Application Support",
          "obsidian",
          "obsidian.json",
        )
      : platform() === "win32"
        ? join(process.env.APPDATA ?? homedir(), "obsidian", "obsidian.json")
        : join(homedir(), ".config", "obsidian", "obsidian.json");
  const known = await readJson<{ vaults?: Record<string, { path: string }> }>(
    config,
  );
  for (const vault of Object.values(known?.vaults ?? {}))
    if (typeof vault.path === "string") vaults.push(vault.path);
  return {
    os: platform(),
    architecture: arch(),
    node: process.versions.node,
    docker,
    compose,
    supabase,
    obsidian: Boolean(obsidian || known),
    vaults,
    tailscale: {
      installed: tailscale !== null,
      connected: tail.BackendState === "Running",
      hostname: tail.Self?.DNSName?.replace(/\.$/, "") ?? null,
    },
    state: await readState(),
  };
}
export async function freePort(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
export function connectionProfile(state: InstallState) {
  return {
    version: 3,
    vaultId: state.vaultId,
    serverUrl: state.endpoint,
    publicKey: state.publicKey,
    deployment:
      state.mode === "local-tailnet"
        ? "local-tailnet"
        : state.mode === "local"
          ? "local"
          : "existing",
  };
}
export async function writeProfile(state: InstallState) {
  const profile = connectionProfile(state);
  await atomicJson(join(dataHome(), "connection.json"), profile);
  await QRCode.toFile(
    join(dataHome(), "connection.png"),
    JSON.stringify(profile),
    { width: 400 },
  );
}
function jwt(secret: string, role: string) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ role, iss: "supabase", iat: now, exp: now + 10 * 365 * 86400 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
export function configureOfficialCompose(
  text: string,
  port: number,
  databasePort = 55432,
): string {
  const compose = parse(text);
  compose.name = "supasync";
  for (const [name, service] of Object.entries(compose.services) as Array<
    [string, Record<string, unknown>]
  >) {
    delete service.container_name;
    delete service.ports;
    if (name === "api-gw") service.ports = [`127.0.0.1:${port}:8000`];
    if (name === "db") service.ports = [`127.0.0.1:${databasePort}:5432`];
  }
  return stringify(compose);
}
export async function compose(
  state: InstallState,
  args: string[],
  input?: string,
) {
  if (!state.composeDir)
    throw new Error("No self-hosted backend is configured");
  return run(
    "docker",
    [
      "compose",
      "--project-name",
      `supasync-${createHash("sha256").update(state.composeDir).digest("hex").slice(0, 12)}`,
      "--env-file",
      ".env",
      "-f",
      "docker-compose.yml",
      ...args,
    ],
    state.composeDir,
    input,
  );
}
export async function prepareBackend(
  state: InstallState,
  assets: string,
  port: number,
) {
  const target = join(dataHome(), "backend");
  const source = join(dataHome(), "upstream");
  await mkdir(dataHome(), { recursive: true, mode: 0o700 });
  if (!(await check("git", ["-C", source, "rev-parse", "HEAD"]))) {
    await run("git", [
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--sparse",
      "--branch",
      SELF_HOST_RELEASE,
      "https://github.com/supabase/supabase.git",
      source,
    ]);
    await run("git", ["sparse-checkout", "set", "docker"], source);
  }
  if ((await run("git", ["rev-parse", "HEAD"], source)) !== SELF_HOST_COMMIT)
    throw new Error("Pinned Supabase source mismatch");
  const existing = await readJson<{ release: string }>(
    join(target, "supasync-backend.json"),
  );
  if (existing && existing.release !== SELF_HOST_RELEASE)
    throw new Error(
      "Backend update requires a verified backup and explicit update",
    );
  if (!existing) {
    if (!(await freePort(port)))
      throw new Error(`Port ${port} is occupied; choose another port`);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await cp(join(source, "docker"), target, { recursive: true });
    await writeFile(
      join(target, "docker-compose.yml"),
      configureOfficialCompose(
        await readFile(join(target, "docker-compose.yml"), "utf8"),
        port,
        state.databasePort,
      ),
    );
    const envFile = join(target, ".env");
    let env = await readFile(join(target, ".env.example"), "utf8");
    const secret = randomBytes(32).toString("hex");
    const vars: Record<string, string> = {
      JWT_SECRET: secret,
      POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
      ANON_KEY: jwt(secret, "anon"),
      SERVICE_ROLE_KEY: jwt(secret, "service_role"),
      DASHBOARD_PASSWORD: randomBytes(24).toString("hex"),
      SECRET_KEY_BASE: randomBytes(48).toString("hex"),
      REALTIME_DB_ENC_KEY: randomBytes(8).toString("hex"),
      VAULT_ENC_KEY: randomBytes(16).toString("hex"),
      PG_META_CRYPTO_KEY: randomBytes(32).toString("hex"),
      SUPABASE_PUBLIC_URL: state.endpoint,
      API_EXTERNAL_URL: state.endpoint,
      SITE_URL: state.endpoint,
      ENABLE_EMAIL_AUTOCONFIRM: "true",
      DISABLE_SIGNUP: "true",
      PGRST_DB_SCHEMAS: "public,storage,graphql_public,supasync",
      FUNCTIONS_VERIFY_JWT: "false",
      API_GW_HTTP_PORT: String(port),
      POOLER_TENANT_ID: "supasync",
      COMPOSE_FILE: "docker-compose.yml",
    };
    for (const [key, value] of Object.entries(vars)) {
      const pattern = new RegExp(`^${key}=.*$`, "m");
      env = pattern.test(env)
        ? env.replace(pattern, `${key}=${value}`)
        : `${env}\n${key}=${value}`;
    }
    await writeFile(envFile, env, { mode: 0o600 });
    await chmod(envFile, 0o600);
    await atomicJson(join(target, "supasync-backend.json"), {
      release: SELF_HOST_RELEASE,
      commit: SELF_HOST_COMMIT,
    });
  }
  const env = await readFile(join(target, ".env"), "utf8");
  state.publicKey = /^ANON_KEY=(.*)$/m.exec(env)?.[1];
  state.composeDir = target;
  state.release = SELF_HOST_RELEASE;
  await cp(
    join(assets, "functions", "supasync-binary"),
    join(target, "volumes", "functions", "supasync-binary"),
    { recursive: true },
  );
}
export async function migrateBackend(state: InstallState, assets: string) {
  const sql = await readFile(join(assets, "schema.sql"), "utf8");
  // A successful marker is stored inside the same transaction as schema installation.
  const applied = await compose(state, [
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
    "select to_regclass('supasync.vaults') is not null",
  ]);
  if (applied.trim() === "t") {
    const version = await compose(state, [
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
      "select protocol_version from supasync.settings where id",
    ]);
    if (version.trim() !== "3")
      throw new Error(
        "Unsupported schema version; back up before a versioned migration",
      );
    return;
  }
  await compose(
    state,
    [
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
    `begin;\n${sql}\ncommit;`,
  );
}
export async function health(state: InstallState) {
  const headers = { apikey: state.publicKey ?? "" };
  // The pinned gateway restricts its OpenAPI root to server administration.
  const env = state.composeDir
    ? await readFile(join(state.composeDir, ".env"), "utf8")
    : "";
  const administrativeKey = /^SERVICE_ROLE_KEY=(.*)$/m.exec(env)?.[1];
  const result: Record<string, unknown> = {
    endpoint: state.endpoint,
    protocolVersion: 3,
    databasePort: state.databasePort ?? 55432,
  };
  for (const [name, path] of [
    ["auth", "/auth/v1/health"],
    ["storage", "/storage/v1/status"],
    ["api", "/rest/v1/"],
    ["binary", "/functions/v1/supasync-binary"],
  ] as const) {
    try {
      const r = await fetch(`${state.endpoint}${path}`, {
        headers:
          name === "api" && administrativeKey
            ? {
                apikey: administrativeKey,
                Authorization: `Bearer ${administrativeKey}`,
              }
            : headers,
        signal: AbortSignal.timeout(8000),
      });
      result[name] = name === "binary" ? r.status === 405 : r.ok;
      result[`${name}Status`] = r.status;
    } catch {
      result[name] = false;
    }
  }
  return result;
}
export async function waitForHealth(state: InstallState) {
  let status: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 20; attempt++) {
    status = await health(state);
    if (status.auth && status.api && status.storage && status.binary)
      return status;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(
    `Backend health failed: ${JSON.stringify(status)}; run supasync doctor`,
  );
}
export async function installPlugin(
  vaultPath: string,
  assets: string,
  state: InstallState,
) {
  const vault = resolve(vaultPath);
  if (!(await stat(vault)).isDirectory())
    throw new Error("Selected vault folder does not exist");
  const target = join(vault, ".obsidian", "plugins", "supasync");
  await mkdir(target, { recursive: true });
  for (const file of [
    "main.js",
    "manifest.json",
    "styles.css",
    "versions.json",
  ])
    await cp(join(assets, "obsidian", file), join(target, file));
  const old =
    (await readJson<Record<string, unknown>>(join(target, "data.json"))) ?? {};
  await atomicJson(join(target, "data.json"), {
    supabaseUrl: state.endpoint,
    anonKey: state.publicKey,
    vaultId: state.vaultId,
    email: state.adminEmail,
    installationId: old.installationId ?? crypto.randomUUID(),
    autoSync: old.autoSync ?? true,
  });
  const list =
    (await readJson<string[]>(
      join(vault, ".obsidian", "community-plugins.json"),
    )) ?? [];
  if (!list.includes("supasync")) list.push("supasync");
  await atomicJson(join(vault, ".obsidian", "community-plugins.json"), list);
  if (!state.vaults.some((v) => v.path === vault))
    state.vaults.push({ path: vault, vaultId: state.vaultId });
}
export async function tailscaleSetup(port: number) {
  const raw = await run("tailscale", ["status", "--json"]);
  const status = JSON.parse(raw);
  if (status.BackendState !== "Running") {
    await run("tailscale", ["up"]);
  }
  const fresh = JSON.parse(await run("tailscale", ["status", "--json"]));
  const host = fresh.Self?.DNSName?.replace(/\.$/, "");
  if (!host) throw new Error("Tailscale has no HTTPS hostname");
  await run("tailscale", ["serve", "--bg", `http://127.0.0.1:${port}`]);
  return `https://${host}`;
}
export async function setup(options: {
  mode: string;
  port: number;
  endpoint?: string;
  publicKey?: string;
  vault?: string;
  dryRun: boolean;
  databasePort?: number;
  email?: string;
  password?: string;
  vaultName?: string;
  vaultId?: string;
  assets: string;
  confirm: (plan: string) => Promise<boolean>;
}) {
  const previous = await readState();
  if (previous && previous.protocolVersion !== 3)
    throw new Error(
      "Existing v2 installation: choose a fresh SUPASYNC_HOME; setup never resets data",
    );
  if (previous && previous.mode !== options.mode)
    throw new Error(
      "An installation exists in another mode; use a separate SUPASYNC_HOME to avoid overwriting it",
    );
  const plan = `Mode: ${options.mode}\nState: ${dataHome()}\nBackend: pinned official Supabase ${SELF_HOST_RELEASE}; loopback port ${options.port}\nSelected vault: ${options.vault ?? "none"}\nNo database reset or volume deletion.`;
  if (options.dryRun) return { dryRun: true, plan };
  if (!(await options.confirm(plan))) return { cancelled: true };
  const state: InstallState = previous ?? {
    version: VERSION,
    mode: options.mode,
    endpoint: options.endpoint ?? `http://127.0.0.1:${options.port}`,
    publicKey: options.publicKey,
    databasePort: options.databasePort ?? 55432,
    tasks: [],
    vaults: [],
    protocolVersion: 3,
  };
  const task = async (name: string, work: () => Promise<unknown>) => {
    await work();
    if (!state.tasks.includes(name)) state.tasks.push(name);
    await atomicJson(join(dataHome(), "install.json"), state);
  };
  if (options.mode === "local" || options.mode === "local-tailnet") {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    await run("docker", ["compose", "version"]);
    if (options.mode === "local-tailnet")
      await task("tailscale", async () => {
        state.endpoint = await tailscaleSetup(options.port);
      });
    await task("backend-files", () =>
      prepareBackend(state, options.assets, options.port),
    );
    await task("backend-db", () =>
      compose(state, ["up", "-d", "--wait", "db"]),
    );
    // PostgREST checks exposed schema existence before it reports healthy.
    await task("api-schema", () =>
      databaseSql(state, "create schema if not exists supasync;"),
    );
    await task("backend-up", () => compose(state, ["up", "-d", "--wait"]));
    await task("schema", () => migrateBackend(state, options.assets));
  } else
    throw new Error(
      "Use local or local-tailnet setup. Development uses supasync dev; existing endpoints use plugin connection profiles.",
    );
  await task("provision", () => provision(state, options));
  await task("health", () => waitForHealth(state));
  await task("connection-profile", () => writeProfile(state));
  if (options.vault)
    await task("plugin", () =>
      installPlugin(options.vault!, options.assets, state),
    );
  const configFile = join(dataHome(), "config.json");
  await atomicJson(configFile, {
    ...(await readJson<Record<string, unknown>>(configFile)),
    url: state.endpoint,
    anonKey: state.publicKey,
  });
  return {
    ready: true,
    endpoint: state.endpoint,
    profile: join(dataHome(), "connection.png"),
    next: "Open SupaSync in Obsidian and sign in with your admin account.",
    hermes: join(dataHome(), "hermes.json"),
  };
}

export { createBackup, verifyBackup, restoreBackup } from "./backup.ts";

export async function databaseSql(state: InstallState, sql: string) {
  return compose(
    state,
    [
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    sql,
  );
}
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
async function provision(
  state: InstallState,
  options: {
    email?: string;
    password?: string;
    vaultName?: string;
    vault?: string;
    vaultId?: string;
  },
) {
  if (!options.email) throw new Error("An admin email is required");
  const env = await readFile(join(state.composeDir!, ".env"), "utf8");
  const serviceKey = /^SERVICE_ROLE_KEY=(.*)$/m.exec(env)?.[1];
  if (!serviceKey)
    throw new Error("Backend administrative credential is unavailable");
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  // Match the requested email only. Fixtures in other installations never choose the administrator.
  const users = await fetch(
    `${state.endpoint}/auth/v1/admin/users?page=1&per_page=1000`,
    { headers },
  );
  if (!users.ok) throw new Error("Auth administration unavailable");
  const listed = (await users.json()) as {
    users: Array<{ id: string; email: string }>;
  };
  let uid = listed.users.find(
    (u) => u.email.toLowerCase() === options.email!.toLowerCase(),
  )?.id;
  if (!uid) {
    if (!options.password)
      throw new Error("An admin password is required for first setup");
    const created = await fetch(`${state.endpoint}/auth/v1/admin/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: options.email,
        password: options.password,
        email_confirm: true,
      }),
    });
    if (!created.ok) throw new Error("Could not create admin account");
    uid = (await created.json()).id;
  }
  if (!uid || !/^[0-9a-f-]{36}$/.test(uid))
    throw new Error("Invalid admin identity");
  const configured = (
    await databaseSql(
      state,
      "select coalesce(admin_uid::text,'') from supasync.settings where id;",
    )
  ).trim();
  if (configured && configured !== uid)
    throw new Error("A different administrator is already configured");
  state.adminEmail = options.email;
  const existingLocal = options.vault
    ? state.vaults.find((v) => v.path === resolve(options.vault!))
    : undefined;
  if (options.vaultId) {
    if (!/^[a-f0-9-]{36}$/i.test(options.vaultId))
      throw new Error("Invalid vault UUID");
    const exists = (
      await databaseSql(
        state,
        `select exists(select from supasync.vaults where id=${literal(options.vaultId)}::uuid);`,
      )
    ).trim();
    if (exists !== "t") throw new Error("Selected remote vault does not exist");
    state.vaultId = options.vaultId;
  } else if (existingLocal?.vaultId) state.vaultId = existingLocal.vaultId;
  else if (options.vault && state.vaults.length)
    state.vaultId = crypto.randomUUID();
  else state.vaultId ??= crypto.randomUUID();
  // Persist the local-to-remote choice before provisioning, so retries keep the UUID.
  if (options.vault && !existingLocal)
    state.vaults.push({ path: resolve(options.vault), vaultId: state.vaultId });
  else if (existingLocal) existingLocal.vaultId = state.vaultId;
  await atomicJson(join(dataHome(), "install.json"), state);
  await databaseSql(
    state,
    `begin; update supasync.settings set admin_uid=${literal(uid)}::uuid where id;
    insert into supasync.vaults(id,name) values(${literal(state.vaultId)}::uuid,${literal(options.vaultName ?? "Personal")}) on conflict(id) do nothing; commit;`,
  );
  // Persist the chosen UUID before later setup steps, so a resumed run cannot create another vault.
  await atomicJson(join(dataHome(), "install.json"), state);
  await provisionHermes(state);
}
export async function provisionHermes(state: InstallState) {
  const credentials = await readJson<{ connectionString: string; ca: string }>(
    join(dataHome(), "hermes.json"),
  );
  if (!credentials) {
    const password = randomBytes(32).toString("base64url");
    await databaseSql(
      state,
      `alter role supasync_hermes login password ${literal(password)};`,
    );
    // The official DB image does not include an openssl executable. Generate TLS
    // material locally with Node, then copy it into the persistent database volume.
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 10);
    const cert = await generate([{ name: "commonName", value: "localhost" }], {
      keySize: 3072,
      algorithm: "sha256",
      notAfterDate: expires,
    });
    const tls = join(dataHome(), "tls");
    await mkdir(tls, { recursive: true, mode: 0o700 });
    await writeFile(join(tls, "server.key"), cert.private, { mode: 0o600 });
    await writeFile(join(tls, "server.crt"), cert.cert, { mode: 0o600 });
    await compose(state, [
      "exec",
      "-T",
      "--user",
      "root",
      "db",
      "mkdir",
      "-p",
      "/var/lib/postgresql/data/supasync-tls",
    ]);
    await compose(state, [
      "cp",
      join(tls, "server.key"),
      "db:/var/lib/postgresql/data/supasync-tls/server.key",
    ]);
    await compose(state, [
      "cp",
      join(tls, "server.crt"),
      "db:/var/lib/postgresql/data/supasync-tls/server.crt",
    ]);
    await compose(state, [
      "exec",
      "-T",
      "--user",
      "root",
      "db",
      "sh",
      "-ec",
      "chown postgres:postgres /var/lib/postgresql/data/supasync-tls/server.key /var/lib/postgresql/data/supasync-tls/server.crt; chmod 600 /var/lib/postgresql/data/supasync-tls/server.key; chmod 644 /var/lib/postgresql/data/supasync-tls/server.crt",
    ]);
    const hba = (await databaseSql(state, "show hba_file;")).trim();
    await compose(state, [
      "exec",
      "-T",
      "--user",
      "root",
      "db",
      "sh",
      "-ec",
      'grep -q "SupaSync Hermes TLS" "$1" || sed -i "1i# SupaSync Hermes TLS\\nhostnossl all supasync_hermes 0.0.0.0/0 reject\\nhostnossl all supasync_hermes ::/0 reject" "$1"',
      "--",
      hba,
    ]);
    await compose(
      state,
      [
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "supabase_admin",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      "alter system set ssl='on'; alter system set ssl_cert_file='/var/lib/postgresql/data/supasync-tls/server.crt'; alter system set ssl_key_file='/var/lib/postgresql/data/supasync-tls/server.key'; select pg_reload_conf();",
    );
    const ca = await compose(state, [
      "exec",
      "-T",
      "db",
      "cat",
      "/var/lib/postgresql/data/supasync-tls/server.crt",
    ]);
    await atomicJson(join(dataHome(), "hermes.json"), {
      connectionString: `postgresql://supasync_hermes:${password}@localhost:${state.databasePort ?? 55432}/postgres`,
      ca,
    });
  }
}

/** An explicit restore creates only a new installation and never runs account/vault provisioning. */
export async function restoreInstallation(options: {
  directory: string;
  assets: string;
  port: number;
  databasePort: number;
}) {
  await verifyBackup(options.directory);
  if (await readState())
    throw new Error("Restore requires a fresh SUPASYNC_HOME");
  const state: InstallState = {
    version: VERSION,
    mode: "local",
    endpoint: `http://127.0.0.1:${options.port}`,
    databasePort: options.databasePort,
    tasks: [],
    vaults: [],
    protocolVersion: 3,
  };
  await prepareBackend(state, options.assets, options.port);
  await atomicJson(join(dataHome(), "install.json"), state);
  await compose(state, ["up", "-d", "--wait", "db"]);
  await databaseSql(state, "create schema if not exists supasync;");
  await compose(state, ["up", "-d", "--wait"]);
  await migrateBackend(state, options.assets);
  await restoreBackup(state, options.directory);
  state.adminEmail = (
    await databaseSql(
      state,
      "select u.email from auth.users u join supasync.settings s on s.admin_uid=u.id;",
    )
  ).trim();
  const ids = (
    await databaseSql(
      state,
      "select id from supasync.vaults order by created_at;",
    )
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (ids.length === 1) state.vaultId = ids[0];
  await provisionHermes(state);
  await writeProfile(state);
  await atomicJson(join(dataHome(), "config.json"), {
    url: state.endpoint,
    anonKey: state.publicKey,
  });
  await atomicJson(join(dataHome(), "install.json"), state);
  return {
    restored: true,
    endpoint: state.endpoint,
    next: "Inspect restored files with the CLI, then install the plugin into a selected local vault.",
  };
}
