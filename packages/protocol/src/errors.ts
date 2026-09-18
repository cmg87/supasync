export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "PERMISSION_DENIED",
  "BASE_CONFLICT",
  "PATH_COLLISION",
  "STALE_NAMESPACE",
  "CURSOR_EXPIRED",
  "EPOCH_MISMATCH",
  "CLIENT_GENERATION_EXPIRED",
  "BLOB_NOT_READY",
  "HASH_MISMATCH",
  "LIMIT_EXCEEDED",
  "PROTOCOL_UPGRADE_REQUIRED",
  "INVALID_PATH",
  "INVALID_TEXT",
  "ID_REUSE",
  "NOT_FOUND",
  "UNAVAILABLE",
  "RATE_LIMITED",
  "RETRYABLE_TRANSPORT",
  "RETRYABLE_STORAGE",
  "QUARANTINED_TRANSFER",
  "UNSUPPORTED_CONVERSION",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
    this.retryable =
      code === "UNAVAILABLE" ||
      code === "RATE_LIMITED" ||
      code === "RETRYABLE_TRANSPORT" ||
      code === "RETRYABLE_STORAGE";
  }
}

export function isProtocolError(value: unknown): value is ProtocolError {
  return value instanceof ProtocolError;
}

export function errorFromWire(
  payload: { code: string; message: string; details?: Record<string, unknown> },
): ProtocolError {
  const code = (ERROR_CODES as readonly string[]).includes(payload.code)
    ? (payload.code as ErrorCode)
    : "UNAVAILABLE";
  return new ProtocolError(code, payload.message, payload.details ?? {});
}
