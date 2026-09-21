import { expect, it, vi } from "vitest";
import type { App } from "obsidian";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path,
}));

import { ObsidianVaultAdapter } from "./obsidian-vault.ts";

it("omits empty and slash vault roots from Obsidian listings", async () => {
  const app = {
    vault: {
      configDir: ".obsidian",
      getAllLoadedFiles: () => [
        { path: "" },
        { path: "/" },
        { path: "notes" },
        { path: "notes/readme.md", extension: "md", stat: { size: 12 } },
      ],
    },
  } as unknown as App;

  await expect(new ObsidianVaultAdapter(app).list()).resolves.toEqual([
    { path: "notes", kind: "folder", byteLength: 0 },
    { path: "notes/readme.md", kind: "file", byteLength: 12 },
  ]);
});
