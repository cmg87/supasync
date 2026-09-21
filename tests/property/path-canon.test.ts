import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalizePath, ProtocolError } from "@supasync/protocol";

describe("pathcanon-1 properties", () => {
  it("NFC and NFD accented paths share a key", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 8 }), (chars) => {
        const stem = chars.join("");
        const composed = `${stem}é.md`;
        const decomposed = `${stem}e\u0301.md`;
        expect(canonicalizePath(composed).pathKey).toBe(canonicalizePath(decomposed).pathKey);
      }),
      { numRuns: 50 },
    );
  });

  it("rejects traversal and absolute paths", () => {
    const bad = [
      "../x.md",
      "/x.md",
      "a/../b.md",
      "a//b.md",
      "CON.md",
      "question?.md",
      "star*.md",
      'quote".md',
      "less<than.md",
      "greater>than.md",
      "pipe|name.md",
    ];
    for (const input of bad) {
      expect(() => canonicalizePath(input)).toThrow(ProtocolError);
    }
  });
});
