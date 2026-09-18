import { describe, expect, it } from "vitest";
import { isExcluded } from "@supasync/sync-core";

describe("exclusions", () => {
  it("excludes config, git, trash, diagnostics, and OS noise", () => {
    expect(isExcluded(".obsidian/app.json")).toBe(true);
    expect(isExcluded(".git/HEAD")).toBe(true);
    expect(isExcluded(".trash/note.md")).toBe(true);
    expect(isExcluded("__supasync_diag__/ping.md")).toBe(true);
    expect(isExcluded(".DS_Store")).toBe(true);
    expect(isExcluded("_inbox/todo.md")).toBe(false);
  });
});
