import { describe, expect, it } from "vitest";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const anon = process.env.SUPABASE_ANON_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function signup(email: string, password: string): Promise<{ id: string; token: string }> {
  const res = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json() as { id?: string; user?: { id: string }; access_token?: string; error?: string };
  if (!res.ok && !body.access_token) {
    const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const session = await login.json() as { access_token: string; user: { id: string } };
    return { id: session.user.id, token: session.access_token };
  }
  const token = body.access_token ?? (
    await (await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })).json() as { access_token: string }
  ).access_token;
  return { id: (body.user?.id ?? body.id) as string, token };
}

async function rpc(actorId: string, op: string, request: unknown, key = service) {
  const res = await fetch(`${url}/rest/v1/rpc/supasync_rpc`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_op: op, p_actor_id: actorId, p_request: request }),
  });
  return { status: res.status, body: await res.json() };
}

describe("two-user authorization against local supabase", () => {
  it("isolates vaults and rejects stale writes", async () => {
    const owner = await signup(`owner-${Date.now()}@example.com`, "test-password-1");
    const other = await signup(`other-${Date.now()}@example.com`, "test-password-2");
    const created = await rpc(owner.id, "create_vault", { name: "Alpha" });
    expect(created.status).toBe(200);
    expect(created.body.ok).toBe(true);
    const vaultId = created.body.data.vault.id as string;

    const outsider = await rpc(other.id, "capabilities", { vault_id: vaultId });
    expect(outsider.body.ok).toBe(false);
    expect(outsider.body.error.code).toBe("PERMISSION_DENIED");

    const clientId = crypto.randomUUID();
    const registered = await rpc(owner.id, "register_client", {
      vault_id: vaultId,
      client_id: clientId,
      label: "test",
      platform: "test",
    });
    expect(registered.body.ok).toBe(true);
    const caps = await rpc(owner.id, "capabilities", { vault_id: vaultId });
    const epoch = caps.body.data.serverEpoch as string;
    const entryId = crypto.randomUUID();
    const op1 = crypto.randomUUID();
    const first = await rpc(owner.id, "commit", {
      envelope: {
        protocol_version: 1,
        server_epoch: epoch,
        vault_id: vaultId,
        client_id: clientId,
        client_generation: 1,
        operation_id: op1,
        type: "create",
        entry_id: entryId,
        payload: { path: "a.md", kind: "markdown", text: "one\n" },
      },
      request_digest: "digest-1",
      path_key: "a.md",
      text_sha256: null,
    });
    expect(first.body.ok).toBe(true);
    const seq = first.body.data.revision.seq as string;
    const replay = await rpc(owner.id, "commit", {
      envelope: {
        protocol_version: 1,
        server_epoch: epoch,
        vault_id: vaultId,
        client_id: clientId,
        client_generation: 1,
        operation_id: op1,
        type: "create",
        entry_id: entryId,
        payload: { path: "a.md", kind: "markdown", text: "one\n" },
      },
      request_digest: "digest-1",
      path_key: "a.md",
    });
    expect(replay.body.data.revision.seq).toBe(seq);
    const stale = await rpc(owner.id, "commit", {
      envelope: {
        protocol_version: 1,
        server_epoch: epoch,
        vault_id: vaultId,
        client_id: clientId,
        client_generation: 1,
        operation_id: crypto.randomUUID(),
        type: "update",
        entry_id: entryId,
        base_revision_id: "0",
        payload: { path: "a.md", text: "two\n" },
      },
      request_digest: "digest-2",
      path_key: "a.md",
    });
    expect(stale.body.ok).toBe(false);
    expect(stale.body.error.code).toBe("BASE_CONFLICT");
  }, 30_000);
});
