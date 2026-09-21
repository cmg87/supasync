import { createClient } from "@supabase/supabase-js";
const url = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const bucket = "supasync-blobs";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type",
  "Content-Type": "application/json",
};
const respond = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: cors });
const hash = async (bytes: ArrayBuffer) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const relative = (value: string) => {
  const u = new URL(value);
  return u.pathname + u.search;
};
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST")
    return respond({ error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const { action, id, token } = await req.json();
    let blob;
    if (typeof token === "string") {
      const result = await admin.rpc("supasync_transfer", {
        p_id: id,
        p_token: token,
      });
      if (result.error || !result.data)
        return respond({ error: "PERMISSION_DENIED" }, 403);
      blob = result.data;
    } else {
      const authorization = req.headers.get("Authorization") ?? "";
      const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false },
      });
      const check = await user.schema("supasync").rpc("capabilities");
      if (check.error) return respond({ error: "PERMISSION_DENIED" }, 403);
      const result = await user
        .schema("supasync")
        .from("blobs")
        .select("*")
        .eq("id", id)
        .single();
      if (result.error) return respond({ error: "NOT_FOUND" }, 404);
      blob = result.data;
    }
    if (action === "upload") {
      // A staging upload can be retried; final objects are never overwritten.
      const result = await admin.storage
        .from(bucket)
        .createSignedUploadUrl(`staging/${id}`, { upsert: true });
      if (result.error) throw result.error;
      return respond({
        url: relative(result.data.signedUrl),
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (action === "finalize") {
      if (!blob.ready) {
        const source = await admin.storage
          .from(bucket)
          .download(`staging/${id}`);
        if (source.error) throw source.error;
        const bytes = await source.data.arrayBuffer();
        if (
          bytes.byteLength !== Number(blob.byte_length) ||
          (await hash(bytes)) !== blob.sha256
        )
          return respond({ error: "HASH_MISMATCH" }, 400);
        const write = await admin.storage
          .from(bucket)
          .upload(blob.storage_key, bytes, {
            upsert: false,
            contentType: "application/octet-stream",
          });
        if (write.error) {
          const existing = await admin.storage
            .from(bucket)
            .download(blob.storage_key);
          if (existing.error) throw existing.error;
          const old = await existing.data.arrayBuffer();
          if (
            old.byteLength !== bytes.byteLength ||
            (await hash(old)) !== blob.sha256
          )
            return respond({ error: "HASH_MISMATCH" }, 400);
        }
        const ready = await admin.rpc("supasync_ready_blob", {
          p_id: id,
          p_sha256: blob.sha256,
          p_length: blob.byte_length,
        });
        if (ready.error) throw ready.error;
        await admin.storage.from(bucket).remove([`staging/${id}`]);
      }
      return respond({ ready: true });
    }
    if (action === "download" && blob.ready) {
      const result = await admin.storage
        .from(bucket)
        .createSignedUrl(blob.storage_key, 120);
      if (result.error) throw result.error;
      return respond({
        url: relative(result.data.signedUrl),
        method: "GET",
        headers: {},
        sha256: blob.sha256,
        byte_length: Number(blob.byte_length),
      });
    }
    return respond({ error: "INVALID_REQUEST" }, 400);
  } catch {
    return respond({ error: "TRANSFER_FAILED" }, 400);
  }
});
