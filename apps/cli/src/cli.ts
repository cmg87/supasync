import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  createBackup,
  verifyBackup,
  restoreBackup,
  setup,
  discover,
  readState,
  atomicJson,
  readJson,
  dataHome,
  health,
  compose,
  installPlugin,
  tailscaleSetup,
  service,
  VERSION,
} from "@supasync/installer";
import { DaemonClient } from "@supasync/daemon-client";
import {
  canonicalizePath,
  hashBytes,
  createEnvelope,
} from "@supasync/protocol";
import {
  deviceKeypair,
  wrapDevice,
  unwrapDevice,
  encode,
} from "@supasync/crypto";
import { runtime, openVault, type RuntimeConfig } from "./runtime.ts";
import { runDaemon, type AttachedVault } from "../../daemon/src/main.ts";
const args = process.argv.slice(2);
const [group, action] = args;
function flag(name: string, fallback?: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const has = (name: string) => args.includes(`--${name}`);
if (flag("home")) process.env.SUPASYNC_HOME = resolve(flag("home")!);
const assets = join(dirname(fileURLToPath(import.meta.url)), "assets");
async function question(prompt: string) {
  if (!stdin.isTTY)
    throw new Error(
      "Interactive input unavailable; supply explicit noninteractive options",
    );
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}
async function secret(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    let value = "";
    for await (const chunk of stdin) value += chunk;
    return value.trim();
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const read = (data: Buffer) => {
      for (const c of data.toString()) {
        if (c === "\u0003") {
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (c === "\r" || c === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (c === "\u007f") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    const finish = () => {
      stdin.off("data", read);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    stdin.on("data", read);
  });
}
function output(value: unknown) {
  console.log(
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}
async function daemon() {
  const token = await readJson<{ token: string }>(
    join(dataHome(), "daemon-token.json"),
  );
  if (!token) throw new Error("Daemon has not been started");
  return new DaemonClient("http://127.0.0.1:49582", token.token);
}
async function main() {
  if (has("version") || group === "version") {
    output(VERSION);
    return;
  }
  if (has("help") || group === "help") {
    output(
      `SupaSync ${VERSION}\nsetup [--mode local|local-tailnet|existing|managed|developer] [--dry-run] [--yes] [--vault-path PATH]\ndoctor | status\nbackend status|up|down|logs\nplugin install|update --vault-path PATH\ntailscale setup|status\nservice install|start|stop|restart|uninstall|logs\nsignup | login --email EMAIL [--password-stdin]\nvault list|create|attach|detach|sync --vault ID --dir PATH\nrecovery show|verify --vault ID\ndevice list|pair|approve|revoke --vault ID\nsync --dir PATH --vault ID\ndaemon run|token\nbackup create|verify --file PATH\nAll keys use a user-only file fallback outside the vault; doctor reports this.`,
    );
    return;
  }
  if (!group || group === "setup") {
    const env = await discover();
    output({
      os: env.os,
      node: env.node,
      docker: env.docker,
      compose: env.compose,
      obsidian: env.obsidian,
      vaults: env.vaults,
      tailscale: env.tailscale,
    });
    const mode =
      flag("mode") ??
      (stdin.isTTY
        ? await question(
            "Mode [local-tailnet/local/existing/managed/developer]: ",
          )
        : "local");
    if (
      !["local-tailnet", "local", "existing", "managed", "developer"].includes(
        mode,
      )
    )
      throw new Error("Unknown deployment mode");
    const result = await setup({
      mode,
      port: Number(flag("port", "8000")),
      endpoint: flag("url"),
      publicKey: flag("anon-key"),
      vault: flag("vault-path"),
      dryRun: has("dry-run"),
      assets,
      confirm: async (plan) => {
        output(plan);
        return (
          has("yes") ||
          (await question("Apply these changes? [y/N] ")).toLowerCase() === "y"
        );
      },
    });
    output(result);
    return;
  }
  if (group === "doctor") {
    const env = await discover();
    const state = await readState();
    output({
      runtime: { version: VERSION, node: env.node, os: env.os },
      backend: state ? await health(state) : "not configured",
      docker: env.docker,
      compose: env.compose,
      tailscale: env.tailscale,
      credentialStorage: "user-only file fallback (0700 directory, 0600 files)",
      protocolVersion: 2,
      cryptoVersion: 1,
      daemon: (await (await daemon().catch(() => null))
        ?.status()
        .catch(() => ({ reachable: false }))) ?? { reachable: false },
      verification:
        "Real-device and reboot results are recorded separately; availability is not proof of an encrypted round-trip.",
    });
    return;
  }
  if (group === "status") {
    output({
      install: await readState(),
      daemon: await (await daemon().catch(() => null))
        ?.status()
        .catch(() => null),
    });
    return;
  }
  if (group === "backend") {
    const state = await readState();
    if (!state) throw new Error("Run setup first");
    const commands: Record<string, string[]> = {
      status: ["ps", "--format", "json"],
      up: ["up", "-d", "--wait"],
      down: ["down"],
      logs: ["logs", "--tail", "100", "--no-color"],
    };
    if (action === "update") {
      output({
        installed: state.release,
        target: "self-hosted/v0.8.1",
        changeRequired: state.release !== "self-hosted/v0.8.1",
      });
      if (!has("dry-run") && state.release !== "self-hosted/v0.8.1")
        throw new Error(
          "Create and verify a backup before a versioned backend upgrade",
        );
      return;
    }
    if (!commands[action!]) throw new Error("Unknown backend command");
    output(await compose(state, commands[action!]!));
    return;
  }
  if (group === "plugin") {
    const state = await readState();
    const path = flag("vault-path");
    if (!state || !path) throw new Error("Requires setup and --vault-path");
    if (has("dry-run")) {
      output({ target: path, assets: join(assets, "obsidian") });
      return;
    }
    await installPlugin(path, assets, state);
    await atomicJson(join(dataHome(), "install.json"), state);
    output("Plugin installed. Restart Obsidian and enable SupaSync.");
    return;
  }
  if (group === "tailscale") {
    output(
      action === "setup"
        ? await tailscaleSetup(Number(flag("port", "8000")))
        : (await discover()).tailscale,
    );
    return;
  }
  if (group === "service") {
    output(await service(action ?? "status", fileURLToPath(import.meta.url)));
    return;
  }
  if (group === "daemon") {
    if (action === "run") {
      await runDaemon(Number(flag("port", "49582")));
      return;
    }
    if (action === "token") {
      const token = await readJson<{ token: string }>(
        join(dataHome(), "daemon-token.json"),
      );
      if (!token) throw new Error("Start the daemon first");
      output(token.token);
      return;
    }
    throw new Error("Use daemon run or daemon token");
  }
  if (group === "config") {
    const old = await readJson<RuntimeConfig>(join(dataHome(), "config.json"));
    await atomicJson(join(dataHome(), "config.json"), {
      ...old,
      url: flag("url", old?.url),
      anonKey: flag("anon-key", old?.anonKey),
    });
    return;
  }
  if (group === "restore" && flag("backup")) {
    const state = await readState();
    if (!state) throw new Error("Set up a fresh isolated target first");
    if (!has("empty-target"))
      throw new Error(
        "Restore requires --empty-target and verifies that the target has no users, vaults, or objects",
      );
    output(await restoreBackup(state, resolve(flag("backup")!)));
    return;
  }
  if (group === "backup") {
    const directory = resolve(
      flag("file", join(dataHome(), `backup-${Date.now()}`))!,
    );
    if (action === "verify") {
      output(await verifyBackup(directory));
      return;
    }
    const state = await readState();
    if (action !== "create" || !state)
      throw new Error("Requires a configured self-hosted backend");
    output(await createBackup(state, directory));
    return;
  }
  const r = await runtime();
  if (group === "signup" || group === "login") {
    const email = flag("email") ?? (await question("Email: "));
    const password = await secret("Password (hidden): ");
    output(
      group === "signup"
        ? (await r.auth.signUp(email, password)).status
        : (await r.auth.signIn(email, password))
          ? "Signed in"
          : "Failed",
    );
    return;
  }
  if (group === "logout") {
    await r.auth.signOut();
    output("Signed out");
    return;
  }
  if (group === "vaults" || (group === "vault" && action === "list")) {
    const result = await r.client.listVaults();
    for (const vault of result.vaults)
      if (vault.encryptedLabel)
        vault.name =
          (await r.keys.label(vault.id, vault.encryptedLabel)) ??
          "Locked encrypted vault";
    output(result);
    return;
  }
  if (group === "create-vault" || (group === "vault" && action === "create")) {
    const prepared = await r.keys.create(
      flag("name") ?? (await question("Vault name: ")),
      async (plan) => {
        await r.client.rpc("create_vault", plan);
        return plan;
      },
    );
    output({
      vaultId: prepared.vaultId,
      recoveryKey: await r.keys.pendingRecovery(prepared.vaultId),
      next:
        "Save this key outside the vault, then run recovery verify --vault " +
        prepared.vaultId,
    });
    return;
  }
  const vaultId = flag("vault", r.config.vaultId);
  if (!vaultId) throw new Error("--vault is required");
  if (group === "recovery") {
    if (action === "show") {
      const recovery = await r.keys.pendingRecovery(vaultId);
      if (!recovery)
        throw new Error(
          "Recovery is already verified or unavailable on this device",
        );
      output(recovery);
      return;
    }
    if (action === "verify") {
      const keys = await r.client.rpc<{
        recoveryEnvelope: import("@supasync/protocol").EncryptedValue;
      }>("get_vault_keys", { vaultId });
      await r.keys.recover(
        vaultId,
        keys.recoveryEnvelope,
        await secret("Recovery key (hidden): "),
      );
      output("Recovery verified; this device is enrolled.");
      return;
    }
  }
  const path = resolve(flag("dir", process.cwd())!);
  if (group === "vault" && action === "detach") {
    const list =
      (await readJson<AttachedVault[]>(join(dataHome(), "attached.json"))) ??
      [];
    await atomicJson(
      join(dataHome(), "attached.json"),
      list.filter((v) => v.vaultId !== vaultId || v.path !== path),
    );
    output(
      "Detached; restart the daemon to release ownership. Local files retained.",
    );
    return;
  }
  if (group === "vault" && action === "attach") {
    const plugin = await readJson<{ daemonEnabled?: boolean }>(
      join(path, ".obsidian", "plugins", "supasync", "data.json"),
    );
    if (plugin && !plugin.daemonEnabled)
      throw new Error(
        "Enable Delegate sync to daemon in this vault first, then attach. This pauses in-process sync before ownership changes.",
      );
    if (!(await r.keys.get(vaultId))) throw new Error("Verify recovery first");
    const list =
      (await readJson<AttachedVault[]>(join(dataHome(), "attached.json"))) ??
      [];
    if (!list.some((v) => v.path === path && v.vaultId === vaultId))
      list.push({ path, vaultId });
    await atomicJson(join(dataHome(), "attached.json"), list);
    output(
      "Attached. Close in-process sync before starting the daemon. Configure plugin delegation before reopening Obsidian.",
    );
    return;
  }
  if (group === "device") {
    const state = new (await import("./file-store.ts")).FileStore(
      join(dataHome(), "devices", `${vaultId}.json`),
    );
    const meta = await state.getMeta();
    await state.putMeta(meta);
    await r.client.registerClient({
      vaultId,
      clientId: meta.clientId,
      label: "device-management",
      platform: "cli",
    });
    const payload = { vaultId, clientId: meta.clientId };
    if (action === "list") {
      output(await r.client.rpc("list_devices", payload));
      return;
    }
    if (action === "revoke") {
      output(
        await r.client.rpc("revoke_device", {
          ...payload,
          targetClientId: flag("device"),
        }),
      );
      return;
    }
    if (action === "pair") {
      const pair = deviceKeypair();
      const pairingId = crypto.randomUUID();
      await r.secrets.set(
        `supasync-pair-${pairingId}`,
        encode(pair.privateKey),
      );
      await r.client.rpc("pair_begin", {
        ...payload,
        pairingId,
        publicKey: pair.publicKey,
      });
      output({
        pairingId,
        publicKey: pair.publicKey,
        expiresIn: "10 minutes",
        next: "Approve this exact public key on an enrolled device, then device receive --pairing ID",
      });
      return;
    }
    const pairingId = flag("pairing");
    if (!pairingId) throw new Error("--pairing required");
    const pairing = await r.client.rpc<{
      publicKey: string;
      clientId: string;
      envelope: import("@supasync/crypto").DeviceEnvelope;
    }>("pair_get", { ...payload, pairingId });
    const context = {
      vaultId,
      entryId: pairing.clientId,
      objectId: pairingId,
      purpose: "device" as const,
      keyVersion: 1,
    };
    if (action === "approve") {
      if (flag("public-key") !== pairing.publicKey)
        throw new Error(
          "Supply --public-key matching the new device display; do not trust a server-substituted key",
        );
      const master = await r.keys.get(vaultId);
      if (!master) throw new Error("Vault locked");
      try {
        await r.client.rpc("pair_approve", {
          ...payload,
          pairingId,
          envelope: wrapDevice(master, pairing.publicKey, context),
        });
      } finally {
        master.fill(0);
      }
      output("Approved");
      return;
    }
    if (action === "receive") {
      const raw = await r.secrets.get(`supasync-pair-${pairingId}`);
      if (!raw || !pairing.envelope) throw new Error("Pairing not approved");
      const { unencode } = await import("@supasync/crypto");
      const master = unwrapDevice(pairing.envelope, unencode(raw), context);
      await r.keys.enroll(vaultId, master);
      master.fill(0);
      await r.client.rpc("pair_consume", { ...payload, pairingId });
      await r.secrets.delete(`supasync-pair-${pairingId}`);
      output("Device enrolled");
      return;
    }
  }
  if (
    ["list", "get", "history", "write", "restore", "rename", "delete"].includes(
      group!,
    )
  ) {
    const vault = await openVault(path, vaultId);
    try {
      const report = await vault.engine.cycle();
      if (report.errors.length) throw new Error(report.errors.join(", "));
      const manifest = await vault.store.getManifest();
      const requested = flag("path");
      const row = [...manifest.values()].find((v) =>
        flag("entry")
          ? v.entryId === flag("entry")
          : requested && v.path === canonicalizePath(requested).display,
      );
      if (group === "list") {
        output(
          [...manifest.values()]
            .filter((v) => !v.deleted)
            .map((v) => ({
              entryId: v.entryId,
              path: v.path,
              kind: v.kind,
              revision: v.remoteSeq,
            })),
        );
        return;
      }
      if (group === "get") {
        if (!row || row.deleted) throw new Error("NOT_FOUND");
        stdout.write(await vault.vault.readBytes(row.path));
        return;
      }
      if (group === "history") {
        if (!row) throw new Error("NOT_FOUND");
        output(await vault.api.history(row.entryId));
        return;
      }
      const expected = flag("base-revision");
      if (expected === undefined)
        throw new Error("--base-revision is required (use 0 to create)");
      if ((row?.remoteSeq ?? "0") !== expected)
        throw new Error(
          "BASE_CONFLICT: read the current revision before editing",
        );
      const operationId = flag("operation-id") ?? crypto.randomUUID();
      const meta = await vault.store.getMeta();
      let payload: Record<string, unknown>;
      let type: "create" | "update" | "delete" | "rename" | "restore_revision";
      let bytes: Uint8Array | undefined;
      if (group === "delete") {
        if (!row) throw new Error("NOT_FOUND");
        type = "delete";
        payload = {};
      } else if (group === "rename") {
        if (!row || !flag("to"))
          throw new Error("--to and an existing entry are required");
        type = "rename";
        payload = {
          path: canonicalizePath(flag("to")!).display,
          kind: row.kind,
        };
      } else {
        if (!requested && !row) throw new Error("--path is required");
        if (group === "restore") {
          if (!row || !flag("revision"))
            throw new Error("--revision is required");
          bytes = await vault.api.revisionBytes(row.entryId, flag("revision")!);
        } else {
          if (!flag("file"))
            throw new Error("--file is required; content is read locally");
          bytes = await readFile(resolve(flag("file")!));
        }
        const target = row?.path ?? canonicalizePath(requested!).display;
        const kind = row?.kind ?? (/\.md$/i.test(target) ? "markdown" : "blob");
        if (kind === "folder")
          throw new Error("Cannot write content to a folder");
        payload = {
          path: target,
          kind,
          ...(kind === "markdown"
            ? { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
            : { bytes: encode(bytes) }),
        };
        type =
          group === "restore" ? "restore_revision" : row ? "update" : "create";
      }
      const existing = (await vault.store.listOutbox()).find(
        (v) => v.operationId === operationId,
      );
      if (existing)
        throw new Error(
          "Operation is pending; use sync to retry its exact saved payload",
        );
      const envelope = createEnvelope({
        vaultId,
        serverEpoch: meta.serverEpoch!,
        clientId: meta.clientId,
        clientGeneration: meta.generation,
        operationId,
        entryId: row?.entryId ?? crypto.randomUUID(),
        baseRevisionId: expected === "0" ? undefined : expected,
        type,
        payload,
      });
      await vault.store.putOutbox({
        operationId,
        envelope,
        extras: {},
        status: "queued",
        sentHash: bytes ? await hashBytes(bytes) : (row?.localHash ?? null),
      });
      const result = await vault.api.commit(envelope);
      // Preserve the operation/result locally even when a competing write wins.
      await vault.store.putCache(`agent-operation:${operationId}`, {
        envelope,
        result,
      });
      await vault.store.deleteOutbox(operationId);
      output(result);
      if (result.outcome === "conflict") process.exitCode = 2;
    } finally {
      await vault.close();
    }
    return;
  }
  if (
    group === "sync" ||
    group === "pull" ||
    group === "push" ||
    (group === "vault" && action === "sync")
  ) {
    const vault = await openVault(path, vaultId);
    try {
      output(await vault.engine.cycle());
    } finally {
      await vault.close();
    }
    return;
  }
  throw new Error("Unknown command; run supasync --help");
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "SupaSync failed");
  process.exitCode = 1;
});
