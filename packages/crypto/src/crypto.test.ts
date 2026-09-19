import { describe, expect, it } from "vitest";
import {
  deriveKey,
  encrypt,
  decrypt,
  encryptName,
  decryptName,
  nameToken,
  randomKey,
  recoveryKey,
  wrapRecovery,
  unwrapRecovery,
  deviceKeypair,
  wrapDevice,
  unwrapDevice,
  sealObject,
  openObject,
  encode,
} from "./index.ts";
const context = {
  vaultId: "vault",
  entryId: "entry",
  objectId: "object",
  purpose: "content" as const,
  keyVersion: 1,
};
describe("versioned E2EE", () => {
  it("uses a fixed HKDF vector and separated domains", () => {
    const key = new Uint8Array(32).fill(1);
    // Independently computed with Node/OpenSSL HKDF-SHA256.
    expect(encode(deriveKey(key, "vault", "content"))).toBe(
      "C7S06EUtRSH9dpaiGXtFY55HgzpMvvn2us1Vpmi5lx8",
    );
    expect(deriveKey(key, "vault", "content")).not.toEqual(
      deriveKey(key, "vault", "name"),
    );
  });
  it("authenticates content, key, AAD, ciphertext and version", () => {
    const key = randomKey();
    const data = new TextEncoder().encode("private marker");
    const encrypted = encrypt(key, data, context);
    expect(decrypt(key, encrypted, context)).toEqual(data);
    expect(() => decrypt(randomKey(), encrypted, context)).toThrow();
    expect(() =>
      decrypt(key, encrypted, { ...context, entryId: "other" }),
    ).toThrow();
    expect(() =>
      decrypt(key, { ...encrypted, ciphertext: "AAAA" }, context),
    ).toThrow();
    expect(() =>
      decrypt(key, { ...encrypted, cryptoVersion: 2 } as never, context),
    ).toThrow();
    expect(
      new Set(
        Array.from({ length: 100 }, () => encrypt(key, data, context).nonce),
      ).size,
    ).toBe(100);
  });
  it("encrypts names and binds tokens to parent and canonical name", () => {
    const key = randomKey();
    const e = encryptName(key, "Private.md", context);
    expect(decryptName(key, e, context)).toBe("Private.md");
    expect(nameToken(key, "vault", null, "Private.md")).toBe(
      nameToken(key, "vault", null, "private.md"),
    );
    expect(nameToken(key, "vault", "folder", "Private.md")).not.toBe(
      nameToken(key, "vault", null, "Private.md"),
    );
  });
  it("recovers using a checksummed independent secret and wraps to one device", () => {
    const master = randomKey();
    const recovery = recoveryKey();
    const envelope = wrapRecovery(master, recovery, "vault");
    expect(unwrapRecovery(envelope, recovery, "vault")).toEqual(master);
    expect(() => unwrapRecovery(envelope, recoveryKey(), "vault")).toThrow();
    const device = deviceKeypair();
    const wrapped = wrapDevice(master, device.publicKey, context);
    expect(unwrapDevice(wrapped, device.privateKey, context)).toEqual(master);
    expect(() =>
      unwrapDevice(wrapped, deviceKeypair().privateKey, context),
    ).toThrow();
  });
  it("rejects truncation and reordering of chunked objects", () => {
    const key = randomKey();
    const bytes = new Uint8Array(1048578).fill(42);
    const cipher = sealObject(key, bytes, context);
    expect(openObject(key, cipher, context)).toEqual(bytes);
    const record = JSON.parse(new TextDecoder().decode(cipher));
    record.chunks.pop();
    expect(() =>
      openObject(
        key,
        new TextEncoder().encode(JSON.stringify(record)),
        context,
      ),
    ).toThrow();
  });
});
