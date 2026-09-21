import { DEFAULT_LIMITS, PATH_CANON_VERSION } from "../constants.ts";
import { ProtocolError } from "../errors.ts";

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
  "clock$",
]);

export type CanonicalPath = {
  version: typeof PATH_CANON_VERSION;
  display: string;
  pathKey: string;
  components: string[];
};

export function foldPathComponent(component: string): string {
  const nfc = component.normalize("NFC");
  return extraCaseFold(nfc.toLowerCase());
}

function extraCaseFold(value: string): string {
  return value.replaceAll("ß", "ss").replaceAll("ẞ", "ss").replaceAll("ς", "σ");
}

function isReservedDeviceName(folded: string): boolean {
  const base = folded.split(".")[0] ?? folded;
  return WINDOWS_RESERVED.has(base);
}

function validateComponent(raw: string): string {
  if (raw.length === 0 || raw === "." || raw === "..") {
    throw new ProtocolError(
      "INVALID_PATH",
      "path component is empty or a traversal segment",
      {
        component: raw,
      },
    );
  }
  if (raw.includes("\u0000") || /[\u0000-\u001F\u007F]/.test(raw)) {
    throw new ProtocolError(
      "INVALID_PATH",
      "path component contains a control character",
      {
        component: raw,
      },
    );
  }
  if (/[\\/:*?"<>|]/u.test(raw)) {
    throw new ProtocolError(
      "INVALID_PATH",
      "path component contains a cross-platform reserved character",
      {
        component: raw,
      },
    );
  }
  const nfc = raw.normalize("NFC");
  if (nfc.endsWith(" ") || nfc.endsWith(".")) {
    throw new ProtocolError(
      "INVALID_PATH",
      "path component has a trailing space or dot",
      {
        component: raw,
      },
    );
  }
  const folded = foldPathComponent(nfc);
  if (isReservedDeviceName(folded)) {
    throw new ProtocolError(
      "INVALID_PATH",
      "path component is a reserved device name",
      {
        component: raw,
      },
    );
  }
  const bytes = new TextEncoder().encode(nfc);
  if (bytes.length > DEFAULT_LIMITS.maxComponentBytes) {
    throw new ProtocolError(
      "LIMIT_EXCEEDED",
      "path component exceeds the maximum length",
      {
        component: raw,
        max: DEFAULT_LIMITS.maxComponentBytes,
      },
    );
  }
  return nfc;
}

export function canonicalizePath(input: string): CanonicalPath {
  if (typeof input !== "string" || input.length === 0) {
    throw new ProtocolError(
      "INVALID_PATH",
      "path must be a non-empty relative vault path",
    );
  }
  if (input.includes("\u0000")) {
    throw new ProtocolError("INVALID_PATH", "path contains a NUL byte");
  }
  if (
    input.startsWith("/") ||
    input.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(input)
  ) {
    throw new ProtocolError("INVALID_PATH", "absolute paths are not allowed");
  }
  const replaced = input.replaceAll("\\", "/");
  if (replaced !== input) {
    throw new ProtocolError(
      "INVALID_PATH",
      "backslash separators are not allowed",
    );
  }
  if (
    replaced.startsWith("./") ||
    replaced === "." ||
    replaced.startsWith("../")
  ) {
    throw new ProtocolError(
      "INVALID_PATH",
      "paths must be relative without a leading dot segment",
    );
  }
  const trimmed = replaced.replace(/\/+$/u, "");
  if (trimmed.length === 0) {
    throw new ProtocolError(
      "INVALID_PATH",
      "path must be a non-empty relative vault path",
    );
  }
  const parts = trimmed.split("/");
  const components = parts.map(validateComponent);
  const display = components.join("/");
  const pathKey = components.map(foldPathComponent).join("/");
  const bytes = new TextEncoder().encode(display);
  if (bytes.length > DEFAULT_LIMITS.maxPathBytes) {
    throw new ProtocolError(
      "LIMIT_EXCEEDED",
      "path exceeds the maximum length",
      {
        max: DEFAULT_LIMITS.maxPathBytes,
      },
    );
  }
  return {
    version: PATH_CANON_VERSION,
    display,
    pathKey,
    components,
  };
}

export function parentDisplayPath(display: string): string | null {
  const idx = display.lastIndexOf("/");
  if (idx <= 0) return null;
  return display.slice(0, idx);
}

export function joinDisplayPath(parent: string | null, name: string): string {
  const leaf = canonicalizePath(name).display;
  if (leaf.includes("/")) {
    throw new ProtocolError(
      "INVALID_PATH",
      "file name must be a single component",
    );
  }
  if (!parent) return leaf;
  return canonicalizePath(`${parent}/${leaf}`).display;
}

export function replacePrefix(
  display: string,
  fromPrefix: string,
  toPrefix: string,
): string {
  if (display === fromPrefix) return toPrefix;
  if (!display.startsWith(`${fromPrefix}/`)) {
    throw new ProtocolError(
      "INVALID_PATH",
      "path is not under the renamed prefix",
      {
        display,
        fromPrefix,
      },
    );
  }
  return `${toPrefix}${display.slice(fromPrefix.length)}`;
}

export function isMarkdownPath(display: string): boolean {
  return display.toLowerCase().endsWith(".md");
}
