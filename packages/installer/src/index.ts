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
const exec = promisify(execFile);
export const SELF_HOST_RELEASE = "self-hosted/v0.8.1";
export const SELF_HOST_COMMIT = "8c7a4d9dbbaf8b552893822e89d7bf06f33f9220";
export const VERSION = "0.2.0";
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
  vaults: Array<{ path: string; vaultId?: string; daemon: boolean }>;
  protocolVersion: 2;
  cryptoVersion: 1;
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
        (error, stdout) =>
          error
            ? reject(
                new Error(
                  `${command} failed (${error.code ?? "unknown"}); inspect local service health`,
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
  } catch {
    throw new Error(
      `${command} failed; verify it is installed and available to this user`,
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
    version: 1,
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
export function configureOfficialCompose(text: string, port: number): string {
  const compose = parse(text);
  compose.name = "supasync";
  for (const [name, service] of Object.entries(compose.services) as Array<
    [string, Record<string, unknown>]
  >) {
    delete service.container_name;
    delete service.ports;
    if (name === "api-gw") service.ports = [`127.0.0.1:${port}:8000`];
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
    join(assets, "functions", "supasync-api"),
    join(target, "volumes", "functions", "supasync-api"),
    { recursive: true },
  );
  await cp(
    join(assets, "functions", "supasync-maintenance"),
    join(target, "volumes", "functions", "supasync-maintenance"),
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
    "select to_regclass('supasync_v2.vaults') is not null",
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
      "select schema_version from supasync_v2.metadata where id",
    ]);
    if (version.trim() !== "1")
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
  const result: Record<string, unknown> = {
    endpoint: state.endpoint,
    protocolVersion: 2,
  };
  for (const [name, path] of [
    ["auth", "/auth/v1/health"],
    ["storage", "/storage/v1/status"],
    ["api", "/functions/v1/supasync-api"],
  ] as const) {
    try {
      const r = await fetch(`${state.endpoint}${path}`, {
        headers,
        signal: AbortSignal.timeout(8000),
        ...(name === "api"
          ? {
              method: "POST",
              body: JSON.stringify({
                protocolVersion: 2,
                operation: "list_vaults",
                payload: {},
              }),
            }
          : {}),
      });
      result[name] = name === "api" ? r.status === 401 : r.ok;
    } catch {
      result[name] = false;
    }
  }
  return result;
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
    ...old,
    supabaseUrl: state.endpoint,
    anonKey: state.publicKey,
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
    state.vaults.push({ path: vault, daemon: false });
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
  assets: string;
  confirm: (plan: string) => Promise<boolean>;
}) {
  const previous = await readState();
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
    tasks: [],
    vaults: [],
    protocolVersion: 2,
    cryptoVersion: 1,
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
    await task("backend-up", () => compose(state, ["up", "-d", "--wait"]));
    await task("schema", () => migrateBackend(state, options.assets));
  } else if (options.mode === "developer") {
    await run("supabase", ["start"]); // Developer mode only; persistent installs never use this.
    const status = JSON.parse(await run("supabase", ["status", "-o", "json"]));
    state.endpoint = status.API_URL;
    state.publicKey = status.ANON_KEY;
  } else if (!state.publicKey || !options.endpoint)
    throw new Error(
      "An existing deployment requires its URL and public client key",
    );
  await task("health", async () => {
    const h = await health(state);
    if (!h.auth || !h.api || !h.storage)
      throw new Error("Backend health failed; run supasync doctor");
  });
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
    next: "Open SupaSync in Obsidian, sign in, then save and verify the recovery key.",
  };
}
export { service, serviceDefinition } from "./services.ts";

export { createBackup, verifyBackup, restoreBackup } from "./backup.ts";
