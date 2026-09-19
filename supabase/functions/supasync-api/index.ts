import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const bucket = 'supasync-ciphertext';
const allowed: Record<string, string[]> = {
 list_vaults: [], create_vault: ['vaultId','encryptedLabel','recoveryEnvelope'], register_client: ['vaultId','clientId','publicKey'],
 capabilities: ['vaultId','clientId'], get_vault_keys: ['vaultId','clientId'], list_devices: ['vaultId','clientId'], revoke_device: ['vaultId','clientId','targetClientId'],
 pull_changes: ['vaultId','clientId','afterSeq','ceiling','limit'], get_tree: ['vaultId','clientId','afterSeq','ceiling','limit'], list_history: ['vaultId','clientId','entryId','afterSeq','ceiling','limit'],
 begin_snapshot: ['vaultId','clientId'], list_snapshot: ['vaultId','clientId','snapshotId','afterEntryId','limit'], ack_applied: ['vaultId','clientId','appliedSeq'],
 reserve_object: ['vaultId','clientId','objectId','ciphertextSha256','ciphertextLength'], finalize_object: ['vaultId','clientId','objectId','ciphertextSha256','ciphertextLength'], get_object: ['vaultId','clientId','objectId'],
 commit: ['vaultId','clientId','envelope'], pair_begin: ['vaultId','clientId','pairingId','publicKey'], pair_get: ['vaultId','clientId','pairingId'], pair_approve: ['vaultId','clientId','pairingId','envelope'], pair_consume: ['vaultId','clientId','pairingId'],
};
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } }); }
function failure(code: string, status = 400) { return response({ ok: false, error: { code, message: code } }, status); }
Deno.serve(async req => {
 if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
 if (req.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 405);
 try {
  const raw = await req.text(); if (raw.length > 65536) return failure('LIMIT_EXCEEDED', 413);
  const { operation, payload, protocolVersion } = JSON.parse(raw);
  if (protocolVersion !== 2) return failure('PROTOCOL_UPGRADE_REQUIRED', 426);
  if (!allowed[operation] || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(k => !allowed[operation].includes(k))) return failure('INVALID_REQUEST');
  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: identity, error: authError } = await admin.auth.getUser(token);
  if (authError || !identity.user) return failure('AUTH_REQUIRED', 401);
  const jwtPayload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
  if (!jwtPayload.session_id) return failure('AUTH_REQUIRED',401);
  const call = async (op: string, request = payload) => {
   const { data, error } = await admin.rpc('supasync_v2_rpc', { p_op: op, p_actor_id: identity.user!.id, p_request: request, p_session_id: jwtPayload.session_id });
   if (error) throw new Error(/^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_REQUEST');
   return data;
  };
  if (operation === 'commit') {
   const env = payload.envelope;
   if (!env || env.protocolVersion !== 2 || env.cryptoVersion !== 1 || Object.keys(env).some(k => !['protocolVersion','cryptoVersion','serverEpoch','vaultId','clientId','clientGeneration','operationId','entryId','baseRevisionId','type','payload'].includes(k))) return failure('INVALID_REQUEST');
  }
  if (operation === 'reserve_object') {
   const data = await call(operation);
   if (!data.ready) {
    const { data: signed, error } = await admin.storage.from(bucket).createSignedUploadUrl(`${data.objectKey}.staging`);
    if (error || !signed) throw new Error('RETRYABLE_STORAGE');
    data.transfer = { url: relative(signed.signedUrl), method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' } };
   }
   return response({ ok: true, data });
  }
  if (operation === 'finalize_object') {
   const reserved = await call('reserve_object');
   if (!reserved.ready) {
    const { data, error } = await admin.storage.from(bucket).download(`${reserved.objectKey}.staging`);
    if (error || !data) throw new Error('RETRYABLE_STORAGE');
    const bytes = await data.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
    if (bytes.byteLength !== reserved.ciphertextLength || hash !== reserved.ciphertextSha256) throw new Error('HASH_MISMATCH');
    // Upload the verified buffer to a separate immutable key. Never copy a mutable staging object after verification.
    const { error: writeError } = await admin.storage.from(bucket).upload(reserved.objectKey, bytes, { upsert: false, contentType: 'application/octet-stream' });
    if (writeError) {
     const existing = await admin.storage.from(bucket).download(reserved.objectKey);
     if (existing.error || !existing.data) throw new Error('RETRYABLE_STORAGE');
     const old = await existing.data.arrayBuffer();
     const oldHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',old))].map(b=>b.toString(16).padStart(2,'0')).join('');
     if (oldHash!==hash || old.byteLength!==bytes.byteLength) throw new Error('HASH_MISMATCH');
    }
    await call('verify_object');
   }
   return response({ ok: true, data: { objectId: payload.objectId, ready: true } });
  }
  if (operation === 'get_object') {
   const data = await call(operation);
   const { data: signed, error } = await admin.storage.from(bucket).createSignedUrl(data.objectKey, 120);
   if (error || !signed) throw new Error('RETRYABLE_STORAGE');
   return response({ ok: true, data: { ...data, transfer: { url: relative(signed.signedUrl), method: 'GET', headers: {} } } });
  }
  return response({ ok: true, data: await call(operation) });
 } catch (error) {
  const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_REQUEST';
  return failure(code, code==='AUTH_REQUIRED' ? 401 : code==='PERMISSION_DENIED' || code==='CLIENT_REVOKED' ? 403 : 400);
 }
});
function relative(value: string): string { const u = new URL(value); return u.pathname + u.search; }
