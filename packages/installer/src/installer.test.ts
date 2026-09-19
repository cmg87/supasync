import { expect, it } from "vitest";
import { parse } from "yaml";
import {
  configureOfficialCompose,
  connectionProfile,
  serviceDefinition,
} from "./index.ts";
it("binds only the existing Supabase gateway to loopback and isolates container names", () => {
  const output = parse(
    configureOfficialCompose(
      'name: supabase\nservices:\n  api-gw:\n    container_name: supabase-envoy\n    ports: ["8000:8000"]\n  db:\n    container_name: supabase-db\n    ports: ["5432:5432"]\n',
      8123,
    ),
  );
  expect(output.services["api-gw"].ports).toEqual(["127.0.0.1:8123:8000"]);
  expect(output.services.db.ports).toBeUndefined();
  expect(output.services.db.container_name).toBeUndefined();
});
it("keeps connection profiles free of privileged and decryption material", () => {
  const profile = connectionProfile({
    version: "0.2.0",
    mode: "local",
    endpoint: "http://127.0.0.1:8000",
    publicKey: "public",
    tasks: [],
    vaults: [],
    protocolVersion: 2,
    cryptoVersion: 1,
  });
  expect(Object.keys(profile).sort()).toEqual([
    "deployment",
    "publicKey",
    "serverUrl",
    "version",
  ]);
});
it.each(["linux", "darwin", "win32"])(
  "renders per-user service definitions for %s",
  (os) => {
    const service = serviceDefinition(
      os,
      "/path with space/node",
      "/app/cli.js",
      "/state",
    );
    expect(service).toContain("daemon");
    expect(service).not.toContain("sudo");
  },
);
