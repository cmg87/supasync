import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
Deno.serve(async req => {
 const secret = Deno.env.get('SUPASYNC_MAINTENANCE_SECRET');
 if (!secret || req.headers.get('x-supasync-maintenance') !== secret) return new Response('Forbidden', { status: 403 });
 // Revisions and ciphertext are retained until a separately verified retention/backup policy permits GC.
 return new Response(JSON.stringify({ ok: true, retention: 'preserve-all', protocolVersion: 2 }), { headers: { 'Content-Type': 'application/json' } });
});
