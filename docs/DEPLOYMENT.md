# Deployment

1. Create a dedicated Supabase project. Do not reuse an unrelated production project.
2. `supabase link` then `supabase db push` to apply `supabase/migrations`.
3. Deploy functions:

```bash
supabase functions deploy supasync-api
supabase functions deploy supasync-maintenance
```

4. Set backend secrets (`R2_*` only if using R2). Never ship those secrets in the plugin.
5. Create an Auth user (email/password is the v1 mobile-friendly path).
6. Install plugin assets into `.obsidian/plugins/supasync/`.
7. Sign in, create or select a vault, run the diagnostic round-trip.

Local:

```bash
supabase start
supabase functions serve
```

The local API URL is `http://127.0.0.1:54321`. Configure mobile devices with a LAN or tunnel hostname, not `localhost`.
