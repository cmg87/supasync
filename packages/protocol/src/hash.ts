import { canonicalJson } from "./canonical-json.ts";

const HEX = "0123456789abcdef";

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0xf];
    out += HEX[byte & 0xf];
  }
  return out;
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function bytesContainNul(data: Uint8Array): boolean {
  return data.includes(0);
}

export function textContainsNul(text: string): boolean {
  return text.includes("\u0000");
}

export async function hashMarkdown(text: string): Promise<string> {
  if (textContainsNul(text)) {
    throw new Error("INVALID_TEXT");
  }
  return sha256Hex(utf8Bytes(text));
}

export async function hashBytes(data: Uint8Array): Promise<string> {
  return sha256Hex(data);
}

export async function digestCanonical(value: unknown): Promise<string> {
  return sha256Hex(utf8Bytes(canonicalJson(value)));
}
