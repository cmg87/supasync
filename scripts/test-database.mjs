import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const name = `supasync-test-${randomUUID().slice(0, 8)}`;
const docker = (args, input) =>
  execFileSync("docker", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const sql = (text) =>
  docker(
    [
      "exec",
      "-i",
      name,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    text,
  );
const asyncSql = (text) =>
  new Promise((resolve, reject) => {
    const p = spawn("docker", [
      "exec",
      "-i",
      name,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ]);
    let out = "",
      err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", reject);
    p.on("close", (c) => (c ? reject(new Error(err)) : resolve(out)));
    p.stdin.end(text);
  });
const quote = (value) =>
  `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const admin = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  vault = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
let checks = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
const hermes = (text) =>
  sql(`set role supasync_hermes; ${text}`).replace(/^SET\n/, "");
let epoch;
let gateway;
const httpTests = process.argv.includes("--http");
const request = (type, id, base, payload) => ({
  protocolVersion: 3,
  serverEpoch: epoch,
  vaultId: vault,
  operationId: randomUUID(),
  entryId: id,
  type,
  baseRevisionId: base,
  payload,
});
const mutate = (r) =>
  JSON.parse(hermes(`select supasync.mutate(${quote(r)});`));
try {
  docker(["network", "create", name]);
  docker([
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "--network",
    name,
    "--network-alias",
    "db",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "postgres:17",
  ]);
  for (let i = 0; ; i++) {
    try {
      docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      break;
    } catch {
      if (i > 60) throw new Error("Database startup timed out");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  sql(
    readFileSync(
      new URL("../tests/support/postgres.sql", import.meta.url),
      "utf8",
    ),
  );
  for (const file of readdirSync(
    new URL("../supabase/migrations/", import.meta.url),
  ).sort())
    sql(
      readFileSync(
        new URL(`../supabase/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  sql(
    `insert into auth.users values('${admin}','admin@example.test'); update supasync.settings set admin_uid='${admin}'; insert into supasync.vaults(id,name) values('${vault}','Test');`,
  );
  epoch = sql("select epoch from supasync.settings");
  const id = randomUUID();
  const create = request("create", id, "0", {
    path: "Notes/a.md",
    kind: "markdown",
    text: "Original\n",
  });
  const first = mutate(create);
  ok(first.outcome === "accepted", "create accepted");
  ok(
    sql(`select content from supasync.files where id='${id}'`) === "Original",
    "plaintext directly queryable",
  );
  ok(
    JSON.stringify(mutate(create)) === JSON.stringify(first),
    "identical retry returns original receipt",
  );
  assert.throws(
    () =>
      mutate({ ...create, payload: { ...create.payload, text: "different" } }),
    /ID_REUSE/,
  );
  checks++;
  const second = mutate(request("update", id, "1", { text: "Changed\n" }));
  ok(second.revision.revision === "2", "file revision advances");
  ok(
    mutate(request("update", id, "1", { text: "Stale" })).outcome ===
      "conflict",
    "stale edit rejected",
  );
  ok(
    mutate(request("delete", id, "1", {})).outcome === "conflict",
    "stale delete rejected",
  );
  const direct = request("update", id, "2", { text: "Direct SQL\n" });
  hermes(
    `begin;select supasync.prepare_mutation(${quote(direct)});update supasync.files set content='Direct SQL'||chr(10) where id='${id}';commit;`,
  );
  ok(
    sql(`select revision from supasync.files where id='${id}'`) === "3",
    "direct SQL advances revision",
  );
  ok(
    sql(`select count(*) from supasync.revisions where file_id='${id}'`) ===
      "3",
    "direct SQL creates history",
  );
  assert.throws(
    () =>
      hermes(`update supasync.files set content='unguarded' where id='${id}'`),
    /MUTATION_CONTEXT_REQUIRED/,
  );
  checks++;
  assert.throws(
    () => hermes("delete from supasync.revisions"),
    /permission denied/,
  );
  checks++;
  assert.throws(
    () => sql("set role anon; select supasync.list_vaults();"),
    /permission denied/,
  );
  checks++;
  assert.throws(
    () =>
      sql(
        "set role authenticated;select set_config('request.jwt.claim.sub','cccccccc-cccc-cccc-cccc-cccccccccccc',false);select supasync.list_vaults();",
      ),
    /PERMISSION_DENIED/,
  );
  checks++;
  ok(
    sql(
      `set role authenticated;select set_config('request.jwt.claim.sub','${admin}',false);select count(*) from supasync.files;`,
    ).endsWith("1"),
    "configured Auth admin reads canonical data",
  );
  const rollback = request("update", id, "3", { text: "Rolled back" });
  hermes(`begin;select supasync.mutate(${quote(rollback)});rollback;`);
  ok(
    sql(
      `select count(*) from supasync.mutation_receipts where operation_id='${rollback.operationId}'`,
    ) === "0",
    "rollback removes receipt",
  );
  ok(
    sql(`select content from supasync.files where id='${id}'`) === "Direct SQL",
    "rollback preserves canonical data",
  );
  const a = randomUUID(),
    b = randomUUID();
  const ar = request("create", a, "0", {
      path: "A.md",
      kind: "markdown",
      text: "A",
    }),
    br = request("create", b, "0", {
      path: "B.md",
      kind: "markdown",
      text: "B",
    });
  const writer = asyncSql(
    `set role supasync_hermes;begin;select supasync.mutate(${quote(ar)});select pg_sleep(1.5);commit;`,
  );
  await new Promise((r) => setTimeout(r, 300));
  const concurrent = asyncSql(
    `set role supasync_hermes;select supasync.mutate(${quote(br)});`,
  );
  await new Promise((r) => setTimeout(r, 300));
  ok(
    sql(`select count(*) from supasync.files where id in ('${a}','${b}')`) ===
      "0",
    "later writer cannot publish ahead of open transaction",
  );
  await Promise.all([writer, concurrent]);
  ok(
    sql(
      `select (select seq from supasync.files where id='${a}')<(select seq from supasync.files where id='${b}')`,
    ) === "t",
    "journal follows commit visibility",
  );
  const folder = randomUUID(),
    child = randomUUID();
  mutate(request("create", folder, "0", { path: "Folder", kind: "folder" }));
  mutate(
    request("create", child, "0", {
      path: "Folder/note.md",
      kind: "markdown",
      text: "Child",
    }),
  );
  const rename = mutate(
    request("rename", folder, "1", {
      path: "Moved",
      treeBase: { [folder]: "1", [child]: "1" },
    }),
  );
  ok(rename.outcome === "accepted", "atomic folder move");
  ok(
    sql(`select path from supasync.files where id='${child}'`) ===
      "Moved/note.md",
    "child UUID survives move",
  );
  const head = sql("select head from supasync.settings");
  mutate(request("update", child, "2", { text: "Newer" }));
  const snapshot = JSON.parse(
    hermes(`select supasync.snapshot('${vault}','${head}');`),
  );
  ok(
    snapshot.items.find((x) => x.entryId === child).revision.content ===
      "Child",
    "snapshot reads fixed historical ceiling",
  );
  assert.throws(
    () =>
      mutate(
        request("create", randomUUID(), "0", {
          path: "../escape",
          kind: "markdown",
          text: "x",
        }),
      ),
    /INVALID_PATH/,
  );
  checks++;
  assert.throws(
    () =>
      mutate(
        request("create", randomUUID(), "0", {
          path: "bad.bin",
          kind: "blob",
          blob_id: randomUUID(),
        }),
      ),
    /BLOB_NOT_READY/,
  );
  checks++;
  const deleted = mutate(request("delete", child, "3", {}));
  ok(deleted.outcome === "accepted", "delete writes tombstone");
  ok(
    sql(`select count(*) from supasync.revisions where file_id='${child}'`) ===
      "4",
    "delete retains history",
  );
  ok(
    mutate(request("restore_revision", child, "4", { text: "Restored" }))
      .outcome === "accepted",
    "restore requires current revision",
  );
  console.log(
    `PostgreSQL: ${checks} checks passed (disposable container ${name})`,
  );
  if (httpTests) {
    const secret = randomUUID() + randomUUID();
    docker([
      "run",
      "--rm",
      "-d",
      "--name",
      `${name}-rest`,
      "--network",
      name,
      "-p",
      "127.0.0.1::3000",
      "-e",
      "PGRST_DB_URI=postgres://postgres@db:5432/postgres",
      "-e",
      "PGRST_DB_SCHEMAS=supasync",
      "-e",
      "PGRST_DB_ANON_ROLE=anon",
      "-e",
      `PGRST_JWT_SECRET=${secret}`,
      "postgrest/postgrest:v12.2.12",
    ]);
    const port = docker(["port", `${name}-rest`, "3000/tcp"])
      .split(":")
      .at(-1);
    const upstream = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        await fetch(upstream);
        break;
      } catch {
        if (i > 60) throw new Error("PostgREST startup timed out");
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    gateway = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const headers = { ...req.headers };
        delete headers.host;
        delete headers["content-length"];
        const response = await fetch(
          upstream + req.url.replace(/^\/rest\/v1/, ""),
          {
            method: req.method,
            headers,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          },
        );
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
    await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
    const body = Buffer.from(
      JSON.stringify({
        role: "authenticated",
        sub: admin,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    const unsigned =
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url",
      ) +
      "." +
      body;
    const jwt =
      unsigned +
      "." +
      createHmac("sha256", secret).update(unsigned).digest("base64url");
    await new Promise((resolve, reject) => {
      const p = spawn(
        "npx",
        ["vitest", "run", "tests/integration/plaintext.test.ts"],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            SUPASYNC_TEST_URL: `http://127.0.0.1:${gateway.address().port}`,
            SUPASYNC_TEST_TOKEN: jwt,
            SUPASYNC_TEST_CONTAINER: name,
          },
        },
      );
      p.on("error", reject);
      p.on("close", (code) =>
        code
          ? reject(new Error(`HTTP integration tests failed (${code})`))
          : resolve(),
      );
    });
  }
} finally {
  if (gateway) await new Promise((r) => gateway.close(r));
  try {
    docker(["rm", "-f", `${name}-rest`]);
  } catch {}
  try {
    docker(["rm", "-f", name]);
  } finally {
    docker(["network", "rm", name]);
  }
}
