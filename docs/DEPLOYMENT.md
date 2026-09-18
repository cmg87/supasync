# Deployment

1. Create a dedicated Supabase project. Do not reuse an unrelated production project.
2. `supabase link` then `supabase db push` to apply `supabase/migrations`.
3. Deploy functions:

```bash
supabase functions deploy supasync-api
supabase functions deploy supasync-maintenance
```

4. Set backend secrets (`R2_*` only if using R2). Never ship those secrets in the plugin.
5. Install plugin assets into `.obsidian/plugins/supasync/`.
6. In the plugin, enter the project URL and publishable/anon key, then **Create account** or **Sign in**. The plugin creates or selects the remote vault by name. Do not create Auth users in Studio, and do not paste vault UUIDs.
7. Run **Sync now** once if you want an immediate round-trip.

The CLI remains available for Hermes/headless use (`signup`, `login`, `vaults`, `create-vault`, `sync`). It is not required to onboard a normal Obsidian user.

## Local backend

```bash
npm run dev:backend
```

That starts the local Supabase stack and `supabase functions serve`. The plugin talks to `http://127.0.0.1:54321` with the local publishable/anon key printed by `supabase start`. Configure mobile devices with a LAN or tunnel hostname, not `localhost`.
