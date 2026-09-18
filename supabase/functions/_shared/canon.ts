export const PATH_CANON_VERSION = "pathcanon-1";
const MAX_PATH_BYTES = 1024;

const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
  "clock$",
]);

function fold(component: string): string {
  return component.normalize("NFC").toLowerCase().replaceAll("ß", "ss").replaceAll("ẞ", "ss");
}

export function canonicalizePath(input: string): { display: string; pathKey: string } {
  if (typeof input !== "string" || !input || input.includes("\u0000") || input.startsWith("/") || input.includes("\\")) {
    throw new Error("INVALID_PATH");
  }
  const parts = input.replace(/\/+$/u, "").split("/");
  const components = parts.map((raw) => {
    if (!raw || raw === "." || raw === "..") throw new Error("INVALID_PATH");
    const nfc = raw.normalize("NFC");
    if (nfc.endsWith(" ") || nfc.endsWith(".")) throw new Error("INVALID_PATH");
    if (WINDOWS_RESERVED.has(fold(nfc).split(".")[0] ?? fold(nfc))) throw new Error("INVALID_PATH");
    return nfc;
  });
  const display = components.join("/");
  if (new TextEncoder().encode(display).length > MAX_PATH_BYTES) throw new Error("LIMIT_EXCEEDED");
  return { display, pathKey: components.map(fold).join("/") };
}

export { PATH_CANON_VERSION };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) out[key] = sortValue(record[key]);
  }
  return out;
}

const HEX = "0123456789abcdef";

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf];
  }
  return out;
}

export async function hashText(text: string): Promise<string> {
  if (text.includes("\u0000")) throw new Error("INVALID_TEXT");
  return sha256Hex(new TextEncoder().encode(text));
}
