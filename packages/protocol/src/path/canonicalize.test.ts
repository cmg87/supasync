import { describe, expect, it } from "vitest";
import { canonicalizePath } from "./canonicalize.ts";
import { PATH_CANON_FIXTURES } from "./fixtures.ts";
import { ProtocolError } from "../errors.ts";

describe("pathcanon-1", () => {
  for (const fixture of PATH_CANON_FIXTURES) {
    it(fixture.name, () => {
      if (fixture.expect === "reject") {
        expect(() => canonicalizePath(fixture.input)).toThrow(ProtocolError);
        return;
      }
      const result = canonicalizePath(fixture.input);
      expect(result.display).toBe(fixture.display);
      expect(result.pathKey).toBe(fixture.pathKey);
    });
  }

  it("treats composed and decomposed accents as the same path key", () => {
    const composed = canonicalizePath("caf\u00e9/note.md");
    const decomposed = canonicalizePath("cafe\u0301/note.md");
    expect(composed.pathKey).toBe(decomposed.pathKey);
    expect(composed.display).toBe(decomposed.display);
  });

  it("preserves display case while folding the comparison key", () => {
    const upper = canonicalizePath("Plan.md");
    const lower = canonicalizePath("plan.md");
    expect(upper.display).toBe("Plan.md");
    expect(lower.display).toBe("plan.md");
    expect(upper.pathKey).toBe(lower.pathKey);
  });
});
