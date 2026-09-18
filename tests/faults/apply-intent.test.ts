import { describe, expect, it } from "vitest";
import { MemoryStore } from "@supasync/sync-core";

describe("durability intents", () => {
  it("persists an apply intent across store instances in memory", async () => {
    const store = new MemoryStore();
    await store.putIntent({ path: "a.md", beforeHash: "1", afterHash: "2", seq: "3", entryId: "e" });
    expect((await store.getIntent("a.md"))?.afterHash).toBe("2");
  });
});
