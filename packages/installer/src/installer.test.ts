import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import {
  configureOfficialCompose,
  connectionProfile,
  installPlugin,
  type InstallState,
} from "./index.ts";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state: InstallState = {
  version: "0.3.0",
  mode: "local",
  endpoint: "http://127.0.0.1:8000",
  publicKey: "public-key",
  tasks: [],
  vaults: [],
  protocolVersion: 3,
  vaultId: "vault-id",
  adminEmail: "admin@example.test",
};
it("exposes only loopback API and PostgreSQL ports", () => {
  const c = parse(
    configureOfficialCompose(
      'services:\n  api-gw:\n    container_name: old\n    ports: ["8000:8000"]\n  db:\n    ports: ["5432:5432"]\n  studio:\n    ports: ["3000:3000"]\n',
      8000,
    ),
  );
  expect(c.services["api-gw"].ports).toEqual(["127.0.0.1:8000:8000"]);
  expect(c.services.db.ports).toEqual(["127.0.0.1:55432:5432"]);
  expect(c.services.studio.ports).toBeUndefined();
  expect(c.services["api-gw"].container_name).toBeUndefined();
});
it("exports only non-secret connection information", () => {
  expect(connectionProfile(state)).toMatchObject({
    version: 3,
    serverUrl: state.endpoint,
    publicKey: "public-key",
    vaultId: "vault-id",
  });
});
it("installs complete connection settings without copying legacy secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "supasync-installer-"));
  try {
    const assets = join(root, "assets"),
      vault = join(root, "vault"),
      target = join(vault, ".obsidian", "plugins", "supasync");
    await mkdir(join(assets, "obsidian"), { recursive: true });
    await mkdir(target, { recursive: true });
    for (const file of [
      "main.js",
      "manifest.json",
      "styles.css",
      "versions.json",
    ])
      await writeFile(join(assets, "obsidian", file), "test");
    await writeFile(
      join(target, "data.json"),
      JSON.stringify({
        password: "old-secret",
        recovery: "old-key",
        daemonEnabled: true,
      }),
    );
    await installPlugin(vault, assets, structuredClone(state));
    const saved = JSON.parse(await readFile(join(target, "data.json"), "utf8"));
    expect(saved).toMatchObject({
      supabaseUrl: state.endpoint,
      anonKey: state.publicKey,
      vaultId: state.vaultId,
      email: state.adminEmail,
    });
    expect(JSON.stringify(saved)).not.toMatch(/old-secret|old-key|daemon/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
