import { DEFAULT_LIMITS } from "./constants.ts";
import { ProtocolError } from "./errors.ts";
import { hashMarkdown } from "./hash.ts";
import { canonicalizePath, isMarkdownPath } from "./path/canonicalize.ts";

export async function prepareMarkdownBody(text: string): Promise<{ text: string; sha256: string; byteLength: number }> {
  if (typeof text !== "string") {
    throw new ProtocolError("INVALID_TEXT", "markdown body must be a string");
  }
  if (text.includes("\u0000")) {
    throw new ProtocolError("INVALID_TEXT", "markdown contains a NUL byte; the local original was left intact");
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > DEFAULT_LIMITS.maxTextBytes) {
    throw new ProtocolError("LIMIT_EXCEEDED", "markdown exceeds the configured size limit", {
      byteLength: bytes.length,
      max: DEFAULT_LIMITS.maxTextBytes,
    });
  }
  return {
    text,
    sha256: await hashMarkdown(text),
    byteLength: bytes.length,
  };
}

export function requireMarkdownPath(path: string): void {
  if (!isMarkdownPath(path)) {
    throw new ProtocolError("UNSUPPORTED_CONVERSION", "expected a markdown path", { path });
  }
}

export function requireBlobPath(path: string): void {
  const canonical = canonicalizePath(path);
  if (isMarkdownPath(canonical.display)) {
    throw new ProtocolError("UNSUPPORTED_CONVERSION", "blob paths must not use the markdown extension", {
      path,
    });
  }
}
