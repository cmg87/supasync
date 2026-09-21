import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, cp, readFile } from "node:fs/promises";
import { run, atomicJson, readJson } from "@supasync/installer";

/** Development has its own project ID, ports, state directory, and explicit seeding. */
export async function runDevelopment(
  action: string,
  assets: string,
  yes: boolean,
) {
  const directory = join(homedir(), ".cache", "supasync-dev-v3");
  const marker = join(directory, "development.json");
  if (action === "start") {
    await mkdir(join(directory, "supabase"), { recursive: true });
    await cp(join(assets, "development"), join(directory, "supabase"), {
      recursive: true,
    });
    await atomicJson(marker, { project: "supasync-dev-v3" });
    console.log(await run("supabase", ["start", "--workdir", directory]));
    return;
  }
  if (
    (await readJson<{ project: string }>(marker))?.project !== "supasync-dev-v3"
  )
    throw new Error("Run supasync dev start first");
  if (action === "stop") {
    console.log(await run("supabase", ["stop", "--workdir", directory]));
    return;
  }
  if (action === "reset") {
    if (!yes)
      throw new Error(
        "Development reset removes only supasync-dev-v3 data. Repeat with --yes.",
      );
    console.log(
      await run("supabase", ["db", "reset", "--local", "--workdir", directory]),
    );
    return;
  }
  if (action === "seed") {
    const state = JSON.parse(
      await run("supabase", ["status", "-o", "json", "--workdir", directory]),
    );
    const url = new URL(state.API_URL);
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      throw new Error("Development must be loopback");
    const existing = await readJson<{
      email: string;
      password: string;
      uid: string;
    }>(join(directory, "fixture.json"));
    const email = "admin@example.test",
      password = existing?.password ?? crypto.randomUUID();
    const headers = {
      apikey: state.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${state.SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    const response = await fetch(`${state.API_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    let uid: string | undefined;
    if (response.ok) uid = (await response.json()).id;
    else {
      const listed = await fetch(
        `${state.API_URL}/auth/v1/admin/users?page=1&per_page=1000`,
        { headers },
      );
      if (listed.ok)
        uid = (await listed.json()).users.find(
          (u: { email: string }) => u.email === email,
        )?.id;
    }
    if (!uid) throw new Error("Could not create development admin");
    if (!/^[a-f0-9-]{36}$/.test(uid))
      throw new Error("Invalid fixture identity");
    await run(
      "docker",
      [
        "exec",
        "-i",
        "supabase_db_supasync-dev-v3",
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      undefined,
      `update supasync.settings set admin_uid='${uid}' where id; insert into supasync.vaults(id,name) values('dddddddd-dddd-dddd-dddd-dddddddddddd','Development') on conflict do nothing;`,
    );
    await atomicJson(join(directory, "fixture.json"), { email, password, uid });
    console.log(`Development credentials: ${join(directory, "fixture.json")}`);
    return;
  }
  throw new Error("Expected dev start|seed|reset|stop");
}
