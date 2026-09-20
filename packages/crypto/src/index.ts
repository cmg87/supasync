import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  canonicalJson,
  canonicalizePath,
  foldPathComponent,
} from "@supasync/protocol";

export const CRYPTO_VERSION = 1 as const;
export const ALGORITHM = "xchacha20poly1305" as const;
const utf8 = new TextEncoder();
const decode = new TextDecoder("utf-8", { fatal: true });
export type Purpose =
  | "content"
  | "attachment"
  | "name"
  | "name-index"
  | "recovery"
  | "device";
export type Context = {
  vaultId: string;
  entryId: string;
  objectId: string;
  purpose: Purpose;
  keyVersion: number;
  chunk?: number;
  final?: boolean;
};
export type CipherEnvelope = {
  cryptoVersion: 1;
  keyVersion: number;
  algorithm: typeof ALGORITHM;
  nonce: string;
  ciphertext: string;
};
export function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
export function encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unencode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value))
    throw new Error("Invalid binary encoding");
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
export function deriveKey(
  master: Uint8Array,
  vaultId: string,
  purpose: Purpose,
  keyVersion = 1,
): Uint8Array {
  if (master.length !== 32 || keyVersion !== 1)
    throw new Error("Unsupported key version or key size");
  return hkdf(
    sha256,
    master,
    utf8.encode(`supasync:v2:${vaultId}`),
    utf8.encode(`supasync:crypto1:${purpose}:key${keyVersion}`),
    32,
  );
}
function aad(context: Context): Uint8Array {
  return utf8.encode(
    canonicalJson({
      protocolVersion: 2,
      cryptoVersion: 1,
      algorithm: ALGORITHM,
      ...context,
    }),
  );
}
export function encrypt(
  master: Uint8Array,
  plaintext: Uint8Array,
  context: Context,
): CipherEnvelope {
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const key = deriveKey(
    master,
    context.vaultId,
    context.purpose,
    context.keyVersion,
  );
  try {
    return {
      cryptoVersion: 1,
      keyVersion: context.keyVersion,
      algorithm: ALGORITHM,
      nonce: encode(nonce),
      ciphertext: encode(
        xchacha20poly1305(key, nonce, aad(context)).encrypt(plaintext),
      ),
    };
  } finally {
    key.fill(0);
  }
}
export function decrypt(
  master: Uint8Array,
  envelope: CipherEnvelope,
  context: Context,
): Uint8Array {
  if (
    envelope.cryptoVersion !== 1 ||
    envelope.algorithm !== ALGORITHM ||
    envelope.keyVersion !== context.keyVersion
  )
    throw new Error("Unsupported encryption version");
  const nonce = unencode(envelope.nonce);
  if (nonce.length !== 24) throw new Error("Invalid nonce");
  const key = deriveKey(
    master,
    context.vaultId,
    context.purpose,
    context.keyVersion,
  );
  try {
    return xchacha20poly1305(key, nonce, aad(context)).decrypt(
      unencode(envelope.ciphertext),
    );
  } catch {
    throw new Error("Encrypted data could not be authenticated");
  } finally {
    key.fill(0);
  }
}
export function encryptName(
  master: Uint8Array,
  name: string,
  context: Omit<Context, "purpose">,
): CipherEnvelope {
  if (canonicalizePath(name).display !== name || name.includes("/"))
    throw new Error("Invalid basename");
  return encrypt(master, utf8.encode(name), { ...context, purpose: "name" });
}
export function decryptName(
  master: Uint8Array,
  envelope: CipherEnvelope,
  context: Omit<Context, "purpose">,
): string {
  const name = decode.decode(
    decrypt(master, envelope, { ...context, purpose: "name" }),
  );
  if (canonicalizePath(name).display !== name || name.includes("/"))
    throw new Error("Invalid decrypted basename");
  return name;
}
export function nameToken(
  master: Uint8Array,
  vaultId: string,
  parentId: string | null,
  name: string,
): string {
  const key = deriveKey(master, vaultId, "name-index");
  try {
    return encode(
      hmac(
        sha256,
        key,
        utf8.encode(canonicalJson([parentId, foldPathComponent(name)])),
      ),
    );
  } finally {
    key.fill(0);
  }
}
export function recoveryKey(): string {
  const secret = randomKey();
  return `ssr1-${encode(secret)}-${encode(sha256(secret).slice(0, 6))}`;
}
export function parseRecovery(key: string): Uint8Array {
  const match = /^ssr1-([A-Za-z0-9_-]{43})-([A-Za-z0-9_-]{8})$/.exec(
    key.trim(),
  );
  if (!match) throw new Error("Invalid recovery key");
  const secret = unencode(match[1]!);
  if (encode(sha256(secret).slice(0, 6)) !== match[2])
    throw new Error("Recovery key checksum mismatch");
  return secret;
}
const recoveryContext = (vaultId: string): Context => ({
  vaultId,
  entryId: vaultId,
  objectId: "recovery",
  purpose: "recovery",
  keyVersion: 1,
});
export function wrapRecovery(
  master: Uint8Array,
  recovery: string,
  vaultId: string,
): CipherEnvelope {
  const secret = parseRecovery(recovery);
  try {
    return encrypt(secret, master, recoveryContext(vaultId));
  } finally {
    secret.fill(0);
  }
}
export function unwrapRecovery(
  envelope: CipherEnvelope,
  recovery: string,
  vaultId: string,
): Uint8Array {
  const secret = parseRecovery(recovery);
  try {
    const key = decrypt(secret, envelope, recoveryContext(vaultId));
    if (key.length !== 32) throw new Error("Invalid vault key");
    return key;
  } finally {
    secret.fill(0);
  }
}
export function deviceKeypair(): { publicKey: string; privateKey: Uint8Array } {
  const privateKey = randomKey();
  return { privateKey, publicKey: encode(x25519.getPublicKey(privateKey)) };
}
export type DeviceEnvelope = {
  senderPublicKey: string;
  envelope: CipherEnvelope;
};
export function wrapDevice(
  master: Uint8Array,
  recipientPublicKey: string,
  context: Context,
): DeviceEnvelope {
  const sender = deviceKeypair();
  const shared = x25519.getSharedSecret(
    sender.privateKey,
    unencode(recipientPublicKey),
  );
  try {
    return {
      senderPublicKey: sender.publicKey,
      envelope: encrypt(shared, master, { ...context, purpose: "device" }),
    };
  } finally {
    sender.privateKey.fill(0);
    shared.fill(0);
  }
}
export function unwrapDevice(
  wrapped: DeviceEnvelope,
  privateKey: Uint8Array,
  context: Context,
): Uint8Array {
  const shared = x25519.getSharedSecret(
    privateKey,
    unencode(wrapped.senderPublicKey),
  );
  try {
    return decrypt(shared, wrapped.envelope, { ...context, purpose: "device" });
  } finally {
    shared.fill(0);
  }
}
/** Framed chunks bind order and a terminal frame. Truncation/reordering cannot authenticate. */
export function encryptChunk(
  master: Uint8Array,
  bytes: Uint8Array,
  context: Context,
  index: number,
  final: boolean,
): CipherEnvelope {
  return encrypt(master, bytes, { ...context, chunk: index, final });
}
export function decryptChunk(
  master: Uint8Array,
  value: CipherEnvelope,
  context: Context,
  index: number,
  final: boolean,
): Uint8Array {
  return decrypt(master, value, { ...context, chunk: index, final });
}
export function sealObject(
  master: Uint8Array,
  bytes: Uint8Array,
  context: Context,
): Uint8Array {
  const chunks: CipherEnvelope[] = [];
  for (let i = 0; i < bytes.length; i += 1024 * 1024)
    chunks.push(
      encryptChunk(
        master,
        bytes.slice(i, i + 1024 * 1024),
        context,
        chunks.length,
        false,
      ),
    );
  chunks.push(
    encryptChunk(master, new Uint8Array(), context, chunks.length, true),
  );
  return utf8.encode(JSON.stringify({ format: 1, chunks }));
}
export function openObject(
  master: Uint8Array,
  ciphertext: Uint8Array,
  context: Context,
): Uint8Array {
  const value = JSON.parse(decode.decode(ciphertext)) as {
    format: number;
    chunks: CipherEnvelope[];
  };
  if (
    value.format !== 1 ||
    !Array.isArray(value.chunks) ||
    value.chunks.length < 1 ||
    value.chunks.length > 65
  )
    throw new Error("Invalid encrypted object");
  const chunks = value.chunks.map((chunk, i) =>
    decryptChunk(master, chunk, context, i, i === value.chunks.length - 1),
  );
  if (chunks.at(-1)!.length !== 0) throw new Error("Invalid terminal frame");
  const result = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    result.set(chunk, at);
    at += chunk.length;
  }
  return result;
}
