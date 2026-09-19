import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const home = resolve(process.env.SUPASYNC_HOME ?? ".tmp/v2-install");
const cli = resolve(
  process.argv[2] ?? ".tmp/v2-package-test/node_modules/supasync/dist/cli.js",
);
const env = { ...process.env, SUPASYNC_HOME: home };
const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.url).hostname))
  throw new Error(
    "This verification script only creates fixtures on a loopback backend",
  );
function run(args, input = "") {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [cli, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", rej);
    p.on("close", (c) =>
      c ? rej(new Error(`${args[0]} failed: ${err}`)) : res(out),
    );
    p.stdin.end(input);
  });
}
const id = crypto.randomUUID();
await run(
  ["signup", "--email", `supasync-fixture-${id}@example.test`],
  crypto.randomUUID(),
);
const created = JSON.parse(
  await run(["vault", "create", "--name", "encrypted installer fixture"]),
);
await run(
  ["recovery", "verify", "--vault", created.vaultId],
  created.recoveryKey,
);
const a = resolve(".tmp/smoke-vault-a-" + id),
  b = resolve(".tmp/smoke-vault-b-" + id);
await mkdir(a, { recursive: true });
await mkdir(b, { recursive: true });
await writeFile(join(a, "secret.md"), "fixture note " + id);
await writeFile(join(a, "private.bin"), Buffer.from([0, 255, 12, 77]));
for (const path of [a, b]) {
  const report = JSON.parse(
    await run(["sync", "--vault", created.vaultId, "--dir", path]),
  );
  if (report.errors.length) throw new Error(report.errors.join(","));
}
if ((await readFile(join(b, "secret.md"), "utf8")) !== "fixture note " + id)
  throw new Error("Note mismatch");
if (
  !(await readFile(join(b, "private.bin"))).equals(
    Buffer.from([0, 255, 12, 77]),
  )
)
  throw new Error("Attachment mismatch");
await writeFile(
  join(home, "smoke-fixture.json"),
  JSON.stringify({ vaultId: created.vaultId, a, b }),
  { mode: 0o600 },
);
console.log(
  "Installed package: sign-up, recovery confirmation, two-folder encrypted note and binary round-trip passed.",
);
