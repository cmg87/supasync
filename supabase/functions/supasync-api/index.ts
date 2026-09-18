import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { canonicalizePath, hashText, sha256Hex } from "../_shared/canon.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return json({ ok: false, error: { code: "AUTH_REQUIRED", message: "missing bearer token" } }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(token);
    if (userError || !userData.user) {
      return json({ ok: false, error: { code: "AUTH_REQUIRED", message: "invalid or expired session" } }, 401);
    }
    const actorId = userData.user.id;

    const body = await req.json();
    const operation = String(body.operation ?? "");
    let payload = (body.payload ?? {}) as Record<string, unknown>;
    payload = await preparePayload(operation, payload);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (operation === "finalize_blob") {
      return json(await finalizeBlob(admin, actorId, payload));
    }
    if (operation === "begin_blob_upload") {
      const reserved = await callRpc(admin, "begin_blob_upload", actorId, payload);
      if (!reserved.ok) return json(reserved);
      const transfer = await signUpload(admin, reserved.data);
      return json({ ok: true, data: { ...toCamel(reserved.data as Record<string, unknown>), transfer } });
    }
    if (operation === "get_blob_download") {
      const loc = await callRpc(admin, "get_blob_download", actorId, payload);
      if (!loc.ok) return json(loc);
      const transfer = await signDownload(admin, loc.data as Record<string, unknown>);
      return json({
        ok: true,
        data: {
          ...toCamel(loc.data as Record<string, unknown>),
          transfer,
        },
      });
    }

    const result = await callRpc(admin, operation, actorId, payload);
    if (result.ok && result.data && typeof result.data === "object") {
      return json({ ok: true, data: toCamel(result.data as Record<string, unknown>) });
    }
    return json(result, result.ok ? 200 : statusFor(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    const code = message === "INVALID_PATH" || message === "INVALID_TEXT" || message === "HASH_MISMATCH" || message === "LIMIT_EXCEEDED"
      ? message
      : "UNAVAILABLE";
    return json({ ok: false, error: { code, message } }, 400);
  }
});

async function preparePayload(operation: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (operation === "commit" || operation === "restore_revision" || operation === "create_conflict_copy" || operation === "resolve_conflict") {
    const envelope = (payload.envelope ?? payload) as Record<string, unknown>;
    const inner = (envelope.payload ?? {}) as Record<string, unknown>;
    if (typeof inner.path === "string") {
      const canon = canonicalizePath(inner.path);
      inner.path = canon.display;
      payload.path_key = canon.pathKey;
    }
    if (typeof inner.to_path === "string") {
      const canon = canonicalizePath(inner.to_path);
      inner.to_path = canon.display;
      payload.path_key = canon.pathKey;
    }
    if (typeof inner.text === "string") {
      payload.text_sha256 = await hashText(inner.text);
    }
    envelope.payload = inner;
    payload.envelope = snakeKeys(envelope);
  }
  if (operation === "rename_tree" && typeof payload.to_path === "string") {
    const canon = canonicalizePath(payload.to_path);
    payload.to_path = canon.display;
    payload.path_key = canon.pathKey;
  }
  return payload;
}

async function callRpc(
  admin: ReturnType<typeof createClient>,
  operation: string,
  actorId: string,
  payload: Record<string, unknown>,
) {
  const { data, error } = await admin.rpc("supasync_rpc", {
    p_op: operation,
    p_actor_id: actorId,
    p_request: payload,
  });
  if (error) {
    return { ok: false, error: { code: "UNAVAILABLE", message: error.message } };
  }
  return data as { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> } };
}

async function finalizeBlob(
  admin: ReturnType<typeof createClient>,
  actorId: string,
  payload: Record<string, unknown>,
) {
  const claimed = await callRpc(admin, "claim_blob_finalization", actorId, payload);
  if (!claimed.ok) return claimed;
  const info = claimed.data as Record<string, unknown>;
  if (info.alreadyReady) {
    return { ok: true, data: { blobId: info.blobId ?? info.blob_id, state: "ready" } };
  }
  const provider = String(info.provider ?? "supabase_storage");
  const stagingKey = String(info.stagingKey ?? info.staging_key);
  const finalKey = String(info.finalKey ?? info.final_key);
  const expectedSha = String(info.expectedSha256 ?? info.expected_sha256);
  const expectedLen = Number(info.expectedLength ?? info.expected_length);
  const bucket = String(info.bucket ?? "supasync-blobs");

  let bytes: Uint8Array;
  if (provider === "r2") {
    bytes = await r2Get(info, stagingKey);
    await r2Put(info, finalKey, bytes);
  } else {
    const { data, error } = await admin.storage.from(bucket).download(stagingKey);
    if (error || !data) {
      return { ok: false, error: { code: "RETRYABLE_STORAGE", message: error?.message ?? "staging object missing" } };
    }
    bytes = new Uint8Array(await data.arrayBuffer());
    const { error: copyError } = await admin.storage.from(bucket).copy(stagingKey, finalKey);
    if (copyError) {
      const { error: upError } = await admin.storage.from(bucket).upload(finalKey, bytes, { upsert: false, contentType: "application/octet-stream" });
      if (upError) {
        return { ok: false, error: { code: "RETRYABLE_STORAGE", message: upError.message } };
      }
    }
  }
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== expectedSha || bytes.byteLength !== expectedLen) {
    await callRpc(admin, "complete_blob_finalization", actorId, {
      ...payload,
      lease: info.lease,
      blob_id: info.blobId ?? info.blob_id,
      final_key: finalKey,
      verified_sha256: actualSha,
      verified_length: bytes.byteLength,
    });
    return { ok: false, error: { code: "HASH_MISMATCH", message: "uploaded bytes do not match the reservation" } };
  }
  const completed = await callRpc(admin, "complete_blob_finalization", actorId, {
    vault_id: payload.vault_id,
    blob_id: info.blobId ?? info.blob_id,
    lease: info.lease,
    final_key: finalKey,
    verified_sha256: actualSha,
    verified_length: bytes.byteLength,
  });
  return completed.ok ? { ok: true, data: toCamel((completed.data ?? {}) as Record<string, unknown>) } : completed;
}

async function signUpload(admin: ReturnType<typeof createClient>, data: unknown): Promise<Record<string, unknown>> {
  const row = data as Record<string, unknown>;
  const provider = String(row.provider ?? "supabase_storage");
  const key = String(row.stagingKey ?? row.staging_key);
  if (provider === "r2") {
    return await r2Sign(row, key, "PUT");
  }
  const bucket = String(row.bucket ?? "supasync-blobs");
  const { data: signed, error } = await admin.storage.from(bucket).createSignedUploadUrl(key);
  if (error || !signed) throw new Error(error?.message ?? "sign failed");
  return {
    url: signed.signedUrl,
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

async function signDownload(admin: ReturnType<typeof createClient>, data: Record<string, unknown>) {
  const provider = String(data.provider ?? "supabase_storage");
  const key = String(data.objectKey ?? data.object_key);
  if (provider === "r2") {
    return await r2Sign(data, key, "GET");
  }
  const bucket = String(data.bucket ?? "supasync-blobs");
  const { data: signed, error } = await admin.storage.from(bucket).createSignedUrl(key, 120);
  if (error || !signed) throw new Error(error?.message ?? "sign failed");
  return {
    url: signed.signedUrl,
    method: "GET",
    headers: {},
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

async function r2Sign(backend: Record<string, unknown>, key: string, method: string) {
  const creds = r2Creds(backend);
  if (!creds) throw new Error("R2 credentials are not configured on the server");
  const url = `${creds.endpoint}/${creds.bucket}/${key}`;
  const headers = await awsSign({ method, url, accessKey: creds.accessKey, secret: creds.secret, region: creds.region });
  return { url, method, headers, expiresAt: new Date(Date.now() + 120_000).toISOString() };
}

async function r2Get(backend: Record<string, unknown>, key: string): Promise<Uint8Array> {
  const signed = await r2Sign(backend, key, "GET") as { url: string; headers: Record<string, string> };
  const res = await fetch(signed.url, { headers: signed.headers });
  if (!res.ok) throw new Error("RETRYABLE_STORAGE");
  return new Uint8Array(await res.arrayBuffer());
}

async function r2Put(backend: Record<string, unknown>, key: string, bytes: Uint8Array): Promise<void> {
  const signed = await r2Sign(backend, key, "PUT") as { url: string; headers: Record<string, string> };
  const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes });
  if (!res.ok) throw new Error("RETRYABLE_STORAGE");
}

function r2Creds(backend: Record<string, unknown>) {
  const accessKey = Deno.env.get("R2_ACCESS_KEY_ID");
  const secret = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const endpoint = String(backend.endpoint ?? Deno.env.get("R2_ENDPOINT") ?? "");
  const bucket = String(backend.bucket ?? Deno.env.get("R2_BUCKET") ?? "");
  const region = String(backend.region ?? "auto");
  if (!accessKey || !secret || !endpoint || !bucket) return null;
  return { accessKey, secret, endpoint, bucket, region };
}

async function awsSign(input: {
  method: string;
  url: string;
  accessKey: string;
  secret: string;
  region: string;
}): Promise<Record<string, string>> {
  const parsed = new URL(input.url);
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalQuery = parsed.searchParams.toString();
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalHeaders = `host:${parsed.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    input.method,
    parsed.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");
  const signingKey = await hmac(
    await hmac(
      await hmac(await hmac(new TextEncoder().encode("AWS4" + input.secret), dateStamp), input.region),
      "s3",
    ),
    "aws4_request",
  );
  const signature = toHex(await hmacRaw(signingKey, stringToSign));
  return {
    host: parsed.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function hmac(key: Uint8Array | BufferSource, value: string): Promise<Uint8Array> {
  return hmacRaw(key, value);
}

async function hmacRaw(key: BufferSource, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function snakeKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)] = v;
  }
  return out;
}

function toCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamel);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const camel = k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
      out[camel] = toCamel(v);
    }
    return out;
  }
  return value;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function statusFor(result: { ok: boolean; error?: { code: string } }): number {
  const code = result.error?.code;
  if (code === "AUTH_REQUIRED") return 401;
  if (code === "PERMISSION_DENIED") return 403;
  if (code === "RATE_LIMITED") return 429;
  return 200;
}
