# Testing

Use a project-local Supabase stack. Do not reset an unrelated instance and do not use a real personal vault.

```bash
npm test
npm run dev:backend
supabase test db
```

Required families are listed in the architecture plan: CRUD, multi-device, conflicts, delivery failures, durability, journal/snapshot, blob integrity, namespace, authorization, recovery/migration, cleanup, and device UX.

Property tests cover path canon and merge. Three in-memory clients must converge or preserve an explicit conflict copy.

## Platforms

| Target | Status |
|---|---|
| Node unit/property tests | runnable with `npm test` |
| Local Supabase pgTAP | runnable after `supabase start` |
| Obsidian desktop plugin bundle | `npm run build` |
| Real Android install | unverified in this environment |
| Real iOS install | unverified in this environment |
| Real Cloudflare R2 | unverified until `R2_*` secrets are provided |

A phone's `localhost` is not the desktop. Signed URLs must use a hostname the phone can reach.

## Results recorded 2026-09-18

Commands:

```bash
npm install
npx vitest run          # 39 passed, 1 skipped
npx tsc --pretty false
npm run build
node scripts/release.mjs
supabase start          # project_id=supasync, isolated local stack
docker exec … psql … authorization_test.sql   # 12/12 pgTAP
```

| Target | Result |
|---|---|
| Node unit/property/sync-core | 38 passed |
| Two Auth users, vault isolation, stale write, idempotent commit | passed against local Supabase |
| pgTAP grants/RLS | 12 passed |
| Plugin bundle `dist/obsidian/{main.js,manifest.json,styles.css,versions.json}` | built; no Node `fs`/`path`/`crypto`/`child_process` requires |
| CLI `apps/cli/dist/cli.js` | built |
| Real Android / iOS install | unverified |
| Real Cloudflare R2 | unverified (adapter present; needs `R2_*` secrets) |
| Real Obsidian desktop two-vault run | unverified in this environment |

Schema/protocol: Postgres `supasync` schema, protocol version `1`, path canon `pathcanon-1`. Attachment limit 25 MiB. Cursors are decimal strings.


Record separately against 10,000 small Markdown files: hardware, cold bootstrap time, one-note sync, idle request rate, peak memory. No bandwidth claim is made without those measurements.
