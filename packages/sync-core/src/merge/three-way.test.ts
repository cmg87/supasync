import { describe, expect, it } from "vitest";
import { mergeMarkdown } from "./three-way.ts";

describe("three-way markdown merge", () => {
  it("takes remote when local equals base", () => {
    const result = mergeMarkdown("a\n", "a\n", "a\nb\n");
    expect(result).toEqual({ kind: "clean", text: "a\nb\n" });
  });

  it("merges non-overlapping line edits", () => {
    const base = "one\ntwo\nthree\n";
    const local = "one!\ntwo\nthree\n";
    const remote = "one\ntwo\nthree!\n";
    const result = mergeMarkdown(base, local, remote);
    expect(result.kind).toBe("clean");
    if (result.kind === "clean") expect(result.text).toBe("one!\ntwo\nthree!\n");
  });

  it("conflicts on overlapping edits", () => {
    const result = mergeMarkdown("x\n", "x local\n", "x remote\n");
    expect(result.kind).toBe("conflict");
  });

  it("conflicts when both change frontmatter", () => {
    const base = "---\ntitle: a\n---\nbody\n";
    const local = "---\ntitle: b\n---\nbody\n";
    const remote = "---\ntitle: c\n---\nbody\n";
    expect(mergeMarkdown(base, local, remote)).toEqual({ kind: "conflict", reason: "frontmatter" });
  });

  it("does not invent a merge without a base", () => {
    expect(mergeMarkdown(null, "a", "b")).toEqual({ kind: "conflict", reason: "no_base" });
  });
});
