export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export function assertPublicApiKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new AuthError("A publishable or anon API key is required");
  }
  if (looksLikeSecretKey(trimmed)) {
    throw new AuthError("Service-role and secret keys are not allowed in the plugin");
  }
}

export function looksLikeSecretKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.includes("service_role") || trimmed.startsWith("sb_secret_")) {
    return true;
  }
  const parts = trimmed.split(".");
  if (parts.length !== 3) {
    return false;
  }
  try {
    const payload = JSON.parse(base64UrlJson(parts[1] ?? ""));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

export function isPublicApiKey(key: string): boolean {
  try {
    assertPublicApiKey(key);
    return true;
  } catch {
    return false;
  }
}

export function sessionSecretId(url: string): string {
  let host = "project";
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
  return `supasync-session-${slug}`.slice(0, 80);
}

export function backendKeyFromUrl(url: string): string {
  return sessionSecretId(url).replace(/^supasync-session-/, "") || "backend";
}

function base64UrlJson(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  return atob(padded);
}
