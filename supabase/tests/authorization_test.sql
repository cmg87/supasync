-- pgTAP authorization and protocol tests.

begin;
select plan(12);

select has_schema('supasync');
select has_function('public', 'supasync_rpc', array['text', 'uuid', 'jsonb']);

select is(
  public.supasync_rpc('list_vaults', null, '{}'::jsonb) -> 'error' ->> 'code',
  'AUTH_REQUIRED',
  'dispatcher rejects a null actor for user operations'
);

set local role authenticated;
select throws_ok(
  $$ select public.supasync_rpc('list_vaults', '00000000-0000-0000-0000-000000000001'::uuid, '{}'::jsonb) $$,
  '42501'
);

reset role;
set local role anon;
select throws_ok(
  $$ select public.supasync_rpc('list_vaults', '00000000-0000-0000-0000-000000000001'::uuid, '{}'::jsonb) $$,
  '42501'
);

reset role;
select has_table('public', 'supasync_wakeup', 'wakeup table exists');
select has_table('supasync', 'vaults', 'vaults table exists');
select has_table('supasync', 'revisions', 'revisions table exists');
select has_table('supasync', 'operation_receipts', 'receipts table exists');
select is(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'supasync' and c.relname = 'entries'),
  true,
  'entries has RLS enabled'
);
select is(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'supasync_wakeup'),
  true,
  'wakeup has RLS enabled'
);
select ok(
  exists(select 1 from pg_views where schemaname = 'public' and viewname = 'supasync_notes'),
  'notes view exists'
);

select * from finish();
rollback;
