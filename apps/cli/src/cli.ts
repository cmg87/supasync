import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { select, input, password, confirm } from "@inquirer/prompts";
import {
  setup,
  discover,
  readState,
  dataHome,
  readJson,
  health,
  compose,
  installPlugin,
  VERSION,
  createBackup,
  verifyBackup,
  restoreBackup,
  restoreInstallation,
} from "@supasync/installer";
import {
  createEnvelope,
  canonicalizePath,
  encode,
  type RevisionRecord,
} from "@supasync/protocol";
import { database, durableMutation, retryPending } from "./runtime.ts";
import { runDevelopment } from "./development.ts";

const args = process.argv.slice(2),
  [command, action] = args;
const has = (name: string) => args.includes(`--${name}`);
function flag(name: string, fallback?: string) {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
}
if (flag("home")) process.env.SUPASYNC_HOME = resolve(flag("home")!);
const assets = join(dirname(fileURLToPath(import.meta.url)), "assets");
const output = (value: unknown) =>
  console.log(
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
async function main() {
  if (has("version") || command === "version") {
    output(VERSION);
    return;
  }
  if (has("help") || command === "help") {
    output(
      `SupaSync ${VERSION}\nsetup [--mode local|local-tailnet] [--vault-path PATH] [--email EMAIL] [--password-stdin] [--dry-run]\ndoctor | backend status|up|down|logs\nplugin install --vault-path PATH\nvault list\nlist|get|search|history --vault UUID [--path PATH] [--query TEXT]\nwrite --vault UUID --path PATH --file FILE --base-revision REV [--operation-id UUID]\nrename|delete|restore --vault UUID --path PATH --base-revision REV [--to PATH|--revision REV]\nretry\nhermes connection\nbackup create|verify --file DIRECTORY\nrestore-backup --file DIRECTORY\ndev start|seed|reset|stop\nHermes uses SUPASYNC_DATABASE_URL and verified PostgreSQL TLS; no Supabase login.`,
    );
    return;
  }
  if (!command || command === "setup") {
    const found = await discover();
    const mode =
      flag("mode") ??
      (process.stdin.isTTY
        ? await select({
            message: "Backend access",
            choices: [
              { name: "This computer", value: "local" },
              {
                name: "Private HTTPS through Tailscale",
                value: "local-tailnet",
              },
            ],
          })
        : "local");
    let vault = flag("vault-path");
    if (!vault && !has("dry-run") && process.stdin.isTTY) {
      const chosen = await select({
        message: "Obsidian vault",
        choices: [
          ...found.vaults.map((p) => ({ name: p, value: p })),
          { name: "Choose another folder", value: "" },
        ],
      });
      vault = chosen || (await input({ message: "Vault folder" }));
    }
    const previous = await readState();
    const email =
      flag("email") ??
      previous?.adminEmail ??
      (!has("dry-run") && process.stdin.isTTY
        ? await input({ message: "Admin email" })
        : undefined);
    let secret: string | undefined;
    if (has("password-stdin")) {
      secret = "";
      for await (const chunk of process.stdin) secret += chunk;
      secret = secret.trimEnd();
    } else if (!previous && !has("dry-run") && process.stdin.isTTY)
      secret = await password({ message: "Admin password", mask: true });
    if (!has("dry-run") && !vault)
      throw new Error("Select a vault with --vault-path");
    const result = await setup({
      mode,
      port: Number(flag("port", "8000")),
      databasePort: Number(flag("database-port", "55432")),
      vault,
      email,
      password: secret,
      vaultName: flag("vault-name", vault ? basename(vault) : "Personal"),
      vaultId: flag("vault-id"),
      dryRun: has("dry-run"),
      assets,
      confirm: async (plan) => {
        output(plan);
        return (
          has("yes") ||
          (await confirm({
            message: "Install into these locations?",
            default: true,
          }))
        );
      },
    });
    secret = undefined;
    output(result);
    return;
  }
  if (command === "dev") {
    await runDevelopment(action ?? "start", assets, has("yes"));
    return;
  }
  if (command === "doctor") {
    const state = await readState();
    output({
      version: VERSION,
      environment: await discover(),
      backend: state ? await health(state) : "Not installed",
    });
    return;
  }
  if (command === "hermes" && action === "connection") {
    const creds = await readJson<{ connectionString: string; ca: string }>(
      join(dataHome(), "hermes.json"),
    );
    if (!creds) throw new Error("Run setup first");
    output({
      connectionString: creds.connectionString,
      tls: "verify-full",
      ca: creds.ca,
      instructions:
        "Treat this connection string as a secret. Remote hosts can use an SSH tunnel to the loopback DB port.",
    });
    return;
  }
  if (command === "backend") {
    const state = await readState();
    if (!state) throw new Error("Run setup first");
    const commands: Record<string, string[]> = {
      status: ["ps"],
      up: ["up", "-d", "--wait"],
      down: ["down"],
      logs: ["logs", "--tail", "100", "--no-color"],
    };
    if (!commands[action!]) throw new Error("Unknown backend action");
    output(await compose(state, commands[action!]!));
    return;
  }
  if (command === "plugin") {
    const state = await readState();
    if (!state || !flag("vault-path"))
      throw new Error("Requires setup and --vault-path");
    await installPlugin(resolve(flag("vault-path")!), assets, state);
    output("Plugin installed; restart Obsidian.");
    return;
  }
  if (command === "backup" || command === "restore-backup") {
    const directory = flag("file");
    if (!directory) throw new Error("--file DIRECTORY is required");
    if (action === "verify") {
      output(await verifyBackup(resolve(directory)));
      return;
    }
    const state = await readState();
    if (command === "restore-backup" && !state) {
      output(
        await restoreInstallation({
          directory: resolve(directory),
          assets,
          port: Number(flag("port", "8000")),
          databasePort: Number(flag("database-port", "55432")),
        }),
      );
      return;
    }
    if (!state) throw new Error("Run setup first");
    output(
      command === "restore-backup"
        ? await restoreBackup(state, resolve(directory))
        : await createBackup(state, resolve(directory)),
    );
    return;
  }
  const db = await database();
  try {
    if (command === "retry") {
      output(await retryPending(db.client));
      return;
    }
    if (command === "vault" && action === "list") {
      output(
        (
          await db.client.query(
            "select id,name from supasync.vaults order by name",
          )
        ).rows,
      );
      return;
    }
    if (command === "vault" && action === "create") {
      output(
        (
          await db.client.query(
            "select supasync.create_vault($1,$2) as result",
            [crypto.randomUUID(), flag("name", "Personal")],
          )
        ).rows[0].result,
      );
      return;
    }
    const vault = flag("vault");
    if (!vault) throw new Error("--vault UUID is required");
    const path = flag("path");
    if (path) canonicalizePath(path);
    if (command === "list") {
      output(
        (
          await db.client.query(
            "select id,path,kind,revision::text,content_hash from supasync.files where vault_id=$1 and not deleted order by path",
            [vault],
          )
        ).rows,
      );
      return;
    }
    if (command === "search") {
      output(
        (
          await db.client.query(
            "select id,path,content,revision::text from supasync.search($1,$2)",
            [vault, flag("query", "")],
          )
        ).rows,
      );
      return;
    }
    if (!path) throw new Error("--path is required");
    const row = (
      await db.client.query(
        "select *,revision::text from supasync.files where vault_id=$1 and path_key=supasync_private.path_key($2) order by deleted limit 1",
        [vault, path],
      )
    ).rows[0];
    if (command === "get") {
      if (!row) throw new Error("Not found");
      output(row);
      return;
    }
    if (command === "history") {
      if (!row) throw new Error("Not found");
      output(
        (
          await db.client.query(
            "select revision::text,seq::text,state from supasync.revisions where file_id=$1 order by seq",
            [row.id],
          )
        ).rows,
      );
      return;
    }
    if (!["write", "rename", "delete", "restore"].includes(command!))
      throw new Error("Unknown command");
    const base = flag("base-revision");
    if (base === undefined || !/^\d+$/.test(base))
      throw new Error("--base-revision is required (0 for create)");
    if (command !== "write" && !row) throw new Error("Not found");
    let payload: Record<string, unknown> = {};
    if (command === "write") {
      if (!flag("file")) throw new Error("--file is required");
      const bytes = await readFile(flag("file")!);
      let text: string | null = null;
      if (!has("binary"))
        try {
          const value = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
          if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
            text = value;
        } catch {}
      if (path.toLowerCase().endsWith(".md") && text === null)
        throw new Error("Markdown must be valid UTF-8 text");
      payload =
        text === null
          ? { path, kind: "blob", bytes: encode(bytes) }
          : { path, kind: "markdown", text };
    } else if (command === "rename")
      payload = { path: canonicalizePath(flag("to", "")!).display };
    else if (command === "restore") {
      const old = (
        await db.client.query(
          "select state from supasync.revisions where file_id=$1 and revision=$2",
          [row.id, flag("revision")],
        )
      ).rows[0]?.state as RevisionRecord | undefined;
      if (!old || old.tombstone)
        throw new Error("A live historical revision is required");
      payload = {
        path,
        ...(old.kind === "markdown"
          ? { text: old.content }
          : { blob_id: old.blobId }),
      };
    }
    if (row?.kind === "folder") {
      payload.treeBase = (
        await db.client.query(
          "select jsonb_object_agg(id::text,revision::text) as tree from supasync.files where vault_id=$1 and not deleted and (id=$2 or starts_with(path,$3||'/'))",
          [vault, row.id, row.path],
        )
      ).rows[0].tree;
    }
    const request = createEnvelope({
      serverEpoch: db.capabilities.serverEpoch,
      vaultId: vault,
      clientId: "hermes",
      operationId: flag("operation-id", crypto.randomUUID())!,
      type:
        command === "write"
          ? base === "0"
            ? "create"
            : "update"
          : command === "restore"
            ? "restore_revision"
            : (command as "rename" | "delete"),
      entryId: row?.id ?? crypto.randomUUID(),
      baseRevisionId: base,
      payload,
    });
    const result = await durableMutation(db.client, request);
    output(result);
    if (result.outcome === "conflict") process.exitCode = 2;
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Command failed");
  process.exitCode = 1;
});
