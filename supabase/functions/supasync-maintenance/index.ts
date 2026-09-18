import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

Deno.serve(async (req) => {
  const secret = Deno.env.get("SUPASYNC_MAINTENANCE_SECRET");
  const provided = req.headers.get("x-supasync-maintenance");
  if (secret && provided !== secret) {
    return new Response(JSON.stringify({ ok: false, error: { code: "PERMISSION_DENIED", message: "maintenance auth failed" } }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc("supasync_rpc", {
    p_op: "gc_pass",
    p_actor_id: null,
    p_request: {},
  });
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: { code: "UNAVAILABLE", message: error.message } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
});
