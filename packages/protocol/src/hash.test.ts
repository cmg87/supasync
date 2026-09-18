import { describe, expect, it } from "vitest";
import { hashMarkdown, utf8Bytes } from "./hash.ts";
import { canonicalJson } from "./canonical-json.ts";
import { compareSeq, seqFromBigInt, seqToBigInt } from "./seq.ts";
import { createEnvelope, envelopeDigest } from "./envelope.ts";

describe("markdown hashing", () => {
  it("hashes exact UTF-8 including a trailing newline", async () => {
    const a = await hashMarkdown("hello\n");
    const b = await hashMarkdown("hello");
    expect(a).not.toBe(b);
    expect(utf8Bytes("hello\n").length).toBe(6);
  });

  it("preserves CRLF versus LF", async () => {
    const crlf = await hashMarkdown("a\r\nb");
    const lf = await hashMarkdown("a\nb");
    expect(crlf).not.toBe(lf);
  });

  it("rejects NUL-containing markdown", async () => {
    await expect(hashMarkdown("ok\u0000bad")).rejects.toThrow("INVALID_TEXT");
  });
});

describe("canonical JSON", () => {
  it("sorts keys deeply", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });
});

describe("sequence cursors", () => {
  it("round-trips values beyond 32-bit", () => {
    const seq = seqFromBigInt(4_000_000_000n);
    expect(seq).toBe("4000000000");
    expect(seqToBigInt(seq)).toBe(4_000_000_000n);
    expect(compareSeq("9", "10")).toBe(-1);
  });

  it("rejects non-decimal cursors", () => {
    expect(() => seqToBigInt("1e2")).toThrow(/invalid sequence/);
    expect(() => seqToBigInt("01")).not.toThrow();
  });
});

describe("operation envelopes", () => {
  it("produces a stable digest for identical payloads", async () => {
    const env = createEnvelope({
      serverEpoch: "epoch",
      vaultId: "vault",
      clientId: "client",
      clientGeneration: 1,
      operationId: "op",
      type: "create",
      payload: { path: "a.md", textSha256: "abc" },
    });
    const again = { ...env, payload: { textSha256: "abc", path: "a.md" } };
    expect(await envelopeDigest(env)).toBe(await envelopeDigest(again));
  });
});
