import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
import { requestUrl } from "obsidian";
import { createObsidianFetch } from "./obsidian-fetch.ts";

describe("Obsidian auth transport", () => {
  it("accepts Supabase's empty logout response", async () => {
    vi.mocked(requestUrl).mockResolvedValue({ status: 204, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "", json: null });
    const response = await createObsidianFetch()("http://127.0.0.1:54321/auth/v1/logout?scope=local", { method: "POST" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});
