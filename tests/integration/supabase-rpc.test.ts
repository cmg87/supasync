/**
 * Integration tests against local Supabase.
 * Start the stack with `npm run dev:backend` before running this file.
 */
import { describe, expect, it } from "vitest";

const url = process.env.SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!url || !service)("local supabase rpc", () => {
  it("rejects unauthenticated dispatcher use via PostgREST", async () => {
    const res = await fetch(`${url}/rest/v1/rpc/supasync_v2_rpc`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY ?? "",
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_op: "list_vaults", p_actor_id: null, p_request: {}, p_session_id: null }),
    });
    expect(res.status === 401 || res.status === 403 || res.status === 404).toBe(true);
  });
});
