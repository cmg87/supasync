import { describe, expect, it } from "vitest";
import { MemoryBackend, MemoryStore, MemoryVault, SyncEngine } from "@supasync/sync-core";

describe("three-client convergence", () => {
  it("converges creates from partitioned clients", async () => {
    const backend = new MemoryBackend();
    const make = async (label: string) => {
      const vault = new MemoryVault();
      const store = new MemoryStore({ label, vaultId: backend.vaultId, serverEpoch: backend.serverEpoch });
      return { vault, engine: new SyncEngine({ api: backend, vault, store, vaultId: backend.vaultId }) };
    };
    const a = await make("a");
    const b = await make("b");
    const c = await make("c");
    await a.vault.writeText("a.md", "from a\n");
    await b.vault.writeText("b.md", "from b\n");
    await a.engine.cycle();
    await b.engine.cycle();
    await c.engine.cycle();
    await a.engine.cycle();
    await b.engine.cycle();
    expect(await c.vault.readText("a.md")).toBe("from a\n");
    expect(await c.vault.readText("b.md")).toBe("from b\n");
    expect(await a.vault.readText("b.md")).toBe("from b\n");
  });
});
