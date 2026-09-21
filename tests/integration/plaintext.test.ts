import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { SupaSyncClient } from "@supasync/client";
import {
  MemoryStore,
  MemoryVault,
  PlaintextSyncApi,
  SyncEngine,
} from "@supasync/sync-core";
import { createEnvelope, PATH_CANON_FIXTURES } from "@supasync/protocol";

describe.skipIf(!process.env.SUPASYNC_TEST_URL)(
  "real PostgREST + PostgreSQL",
  () => {
    it.each(PATH_CANON_FIXTURES)(
      "uses the shared SQL path contract: $name",
      (fixture) => {
        const query = () =>
          sql(
            `select supasync_private.path_key('${fixture.input.replaceAll("'", "''")}')`,
          );
        if (fixture.expect === "reject") expect(query).toThrow();
        else expect(query()).toBe(fixture.pathKey);
      },
    );
    function client(transport: typeof fetch = fetch) {
      return new SupaSyncClient({
        url: process.env.SUPASYNC_TEST_URL!,
        anonKey: "public-fixture-key",
        session: {
          getAccessToken: async () => process.env.SUPASYNC_TEST_TOKEN!,
        },
        fetch: transport,
      });
    }
    function sql(value: string) {
      return execFileSync(
        "docker",
        [
          "exec",
          "-i",
          process.env.SUPASYNC_TEST_CONTAINER!,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
        ],
        { input: value, encoding: "utf8" },
      ).trim();
    }
    function device(c: SupaSyncClient, id: string) {
      const store = new MemoryStore({ vaultId: id }),
        vault = new MemoryVault(),
        api = new PlaintextSyncApi(c, store, id);
      return {
        store,
        vault,
        api,
        engine: new SyncEngine({ api, store, vault, vaultId: id }),
      };
    }
    it("syncs plaintext, direct Hermes edits, folders, offline conflicts and history", async () => {
      const c = client(),
        id = crypto.randomUUID();
      await c.createVault(id, "Integration");
      const a = device(c, id),
        b = device(c, id);
      await a.vault.writeText("Notes/note.md", "base\n");
      await a.vault.writeText("other.txt", "plain text\n");
      expect((await a.engine.cycle()).errors).toEqual([]);
      expect((await b.engine.cycle()).errors).toEqual([]);
      expect(await b.vault.readText("Notes/note.md")).toBe("base\n");
      expect(
        sql(
          `select content from supasync.files where vault_id='${id}' and path='other.txt'`,
        ),
      ).toBe("plain text");
      const row = JSON.parse(
        sql(
          `select row_to_json(f) from supasync.files f where vault_id='${id}' and path='Notes/note.md'`,
        ),
      );
      const caps = await c.capabilities(id);
      const request = createEnvelope({
        serverEpoch: caps.serverEpoch,
        vaultId: id,
        clientId: "hermes",
        operationId: crypto.randomUUID(),
        entryId: row.id,
        type: "update",
        baseRevisionId: String(row.revision),
        payload: { text: "Hermes\n" },
      });
      sql(
        `set role supasync_hermes;begin;select supasync.prepare_mutation('${JSON.stringify(request)}'::jsonb);update supasync.files set content='Hermes'||chr(10) where id='${row.id}';commit;`,
      );
      expect((await b.engine.cycle()).errors).toEqual([]);
      expect(await b.vault.readText("Notes/note.md")).toBe("Hermes\n");
      await a.engine.cycle();
      await a.vault.writeText("Notes/note.md", "Laptop\n");
      await b.vault.writeText("Notes/note.md", "Phone\n");
      await a.engine.cycle();
      await b.engine.cycle();
      await a.engine.cycle();
      await b.engine.cycle();
      const texts = await Promise.all(
        (await b.vault.list())
          .filter((x) => x.kind === "file")
          .map((x) => b.vault.readText(x.path)),
      );
      expect(texts).toContain("Laptop\n");
      expect(texts).toContain("Phone\n");
      await a.engine.cycle();
      await b.engine.cycle();
      await a.engine.cycle();
      await a.vault.rename("Notes", "Moved");
      await a.engine.renameLocal("Notes", "Moved");
      expect((await a.engine.cycle()).errors).toEqual([]);
      expect((await b.engine.cycle()).errors).toEqual([]);
      expect(await b.vault.exists("Moved/note.md")).toBe(true);
      expect((await a.api.history(row.id)).length).toBeGreaterThan(2);
    });
    it("replays the original receipt after the server commits but the response is lost", async () => {
      let lose = false;
      const requests: string[] = [];
      const c = client(async (url, init) => {
        const response = await fetch(url, init);
        if (String(url).endsWith("/mutate")) {
          requests.push(init!.body as string);
          if (lose) {
            lose = false;
            throw new Error("lost response");
          }
        }
        return response;
      });
      const id = crypto.randomUUID();
      await c.createVault(id, "Retry");
      const a = device(c, id);
      await a.vault.writeText("retry.md", "exact payload");
      lose = true;
      expect((await a.engine.cycle()).errors).toContain("lost response");
      expect(await a.store.listOutbox()).toHaveLength(1);
      expect((await a.engine.cycle()).errors).toEqual([]);
      expect(requests[0]).toBe(requests[1]);
      expect(
        sql(`select count(*) from supasync.revisions where vault_id='${id}'`),
      ).toBe("1");
    });
  },
);
