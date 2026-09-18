-- SupaSync initial schema, grants, RLS, and service-only RPCs.
-- Data lives in the non-exposed `supasync` schema. Public contains a single
-- service-role dispatcher, an optional notes view, and a Realtime wakeup table.

create schema if not exists supasync;

revoke all on schema supasync from public, anon, authenticated;
grant usage on schema supasync to postgres, service_role, authenticated;

alter default privileges in schema supasync revoke all on tables from public, anon, authenticated;
alter default privileges in schema supasync revoke all on sequences from public, anon, authenticated;
alter default privileges in schema supasync revoke execute on functions from public, anon, authenticated;
alter default privileges in schema supasync grant all on tables to service_role;
alter default privileges in schema supasync grant all on sequences to service_role;
alter default privileges in schema supasync grant execute on functions to service_role;

do $$
begin
  create type supasync.member_role as enum ('owner', 'editor', 'reader');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type supasync.member_status as enum ('enabled', 'revoked');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type supasync.entry_kind as enum ('markdown', 'blob', 'folder');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type supasync.blob_state as enum ('reserved', 'uploading', 'finalizing', 'ready', 'failed', 'deleting');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type supasync.backend_provider as enum ('supabase_storage', 'r2');
exception when duplicate_object then null;
end $$;

create table if not exists supasync.vaults (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users (id),
  protocol_version integer not null default 1,
  server_epoch uuid not null default gen_random_uuid(),
  head_seq bigint not null default 0 check (head_seq >= 0),
  namespace_seq bigint not null default 0 check (namespace_seq >= 0),
  replay_floor bigint not null default 0 check (replay_floor >= 0 and replay_floor <= head_seq),
  default_storage_backend_id uuid,
  max_blob_bytes bigint not null default 26214400,
  max_text_bytes bigint not null default 2097152,
  retention_days integer not null default 30,
  min_versions_per_entry integer not null default 20,
  created_at timestamptz not null default now()
);

create table if not exists supasync.vault_members (
  vault_id uuid not null references supasync.vaults (id) on delete cascade,
  user_id uuid not null references auth.users (id),
  role supasync.member_role not null,
  status supasync.member_status not null default 'enabled',
  created_at timestamptz not null default now(),
  primary key (vault_id, user_id)
);

create table if not exists supasync.clients (
  vault_id uuid not null references supasync.vaults (id) on delete cascade,
  client_id uuid not null,
  user_id uuid not null references auth.users (id),
  label text not null default 'device',
  platform text not null default 'unknown',
  generation integer not null default 1 check (generation >= 1),
  last_seen timestamptz not null default now(),
  applied_cursor bigint not null default 0,
  bootstrap_state text not null default 'new',
  enabled boolean not null default true,
  primary key (vault_id, client_id)
);

create table if not exists supasync.storage_backends (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid not null references supasync.vaults (id) on delete cascade,
  provider supasync.backend_provider not null,
  endpoint text,
  region text,
  bucket text not null,
  display_label text not null,
  secret_ref text not null,
  config jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  unique (vault_id, id)
);

alter table supasync.vaults
  drop constraint if exists vaults_default_storage_backend_id_fkey;
alter table supasync.vaults
  add constraint vaults_default_storage_backend_id_fkey
  foreign key (id, default_storage_backend_id)
  references supasync.storage_backends (vault_id, id);

create table if not exists supasync.text_bodies (
  vault_id uuid not null references supasync.vaults (id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  body text not null,
  byte_length integer not null check (byte_length >= 0),
  primary key (vault_id, sha256)
);

create table if not exists supasync.blobs (
  vault_id uuid not null references supasync.vaults (id) on delete cascade,
  blob_id uuid not null default gen_random_uuid(),
  expected_sha256 text not null check (expected_sha256 ~ '^[0-9a-f]{64}$'),
  expected_length bigint not null check (expected_length >= 0),
  verified_sha256 text check (verified_sha256 is null or verified_sha256 ~ '^[0-9a-f]{64}$'),
  verified_length bigint,
  mime_hint text,
  state supasync.blob_state not null default 'reserved',
  staging_key text not null,
  expiry timestamptz not null,
  finalization_lease uuid,
  finalization_expires timestamptz,
  deleting_since timestamptz,
  primary key (vault_id, blob_id)
);

create table if not exists supasync.blob_locations (
  vault_id uuid not null,
  blob_id uuid not null,
  backend_id uuid not null,
  object_key text not null,
  verified_sha256 text not null,
  verified_length bigint not null,
  state text not null default 'sealed',
  primary key (vault_id, blob_id, backend_id, object_key),
  foreign key (vault_id, blob_id) references supasync.blobs (vault_id, blob_id),
  foreign key (vault_id, backend_id) references supasync.storage_backends (vault_id, id)
);

create table if not exists supasync.entries (
  vault_id uuid not null references supasync.vaults (id) on delete cascade,
  entry_id uuid not null,
  path text not null,
  path_key text not null,
  parent_id uuid,
  kind supasync.entry_kind not null,
  current_version integer not null default 0,
  current_seq bigint,
  deleted boolean not null default false,
  conflict_of uuid,
  conflict_operation_id uuid,
  primary key (vault_id, entry_id),
  foreign key (vault_id, parent_id) references supasync.entries (vault_id, entry_id),
  unique (vault_id, entry_id, current_version)
);

create unique index if not exists entries_live_path_key
  on supasync.entries (vault_id, path_key)
  where deleted = false;

create table if not exists supasync.revisions (
  vault_id uuid not null references supasync.vaults (id) on delete cascade,
  seq bigint not null,
  entry_id uuid not null,
  version integer not null check (version >= 1),
  parent_seq bigint,
  path text not null,
  path_key text not null,
  kind supasync.entry_kind not null,
  text_sha256 text,
  blob_id uuid,
  tombstone boolean not null default false,
  actor_id uuid not null,
  client_id uuid not null,
  operation_id uuid not null,
  server_ts timestamptz not null default now(),
  conflict_of uuid,
  conflict_operation_id uuid,
  primary key (vault_id, seq),
  unique (vault_id, entry_id, version),
  foreign key (vault_id, entry_id) references supasync.entries (vault_id, entry_id),
  foreign key (vault_id, text_sha256) references supasync.text_bodies (vault_id, sha256),
  foreign key (vault_id, blob_id) references supasync.blobs (vault_id, blob_id),
  foreign key (vault_id, parent_seq) references supasync.revisions (vault_id, seq),
  constraint revision_content_shape check (
    (tombstone and text_sha256 is null and blob_id is null)
    or (not tombstone and kind = 'markdown' and text_sha256 is not null and blob_id is null)
    or (not tombstone and kind = 'blob' and blob_id is not null and text_sha256 is null)
    or (not tombstone and kind = 'folder' and text_sha256 is null and blob_id is null)
  )
);

alter table supasync.entries
  drop constraint if exists entries_current_revision_fkey;
alter table supasync.entries
  add constraint entries_current_revision_fkey
  foreign key (vault_id, current_seq) references supasync.revisions (vault_id, seq);

create table if not exists supasync.operation_receipts (
  vault_id uuid not null,
  client_id uuid not null,
  generation integer not null,
  operation_id uuid not null,
  request_digest text not null,
  outcome jsonb not null,
  created_seq bigint,
  created_at timestamptz not null default now(),
  primary key (vault_id, client_id, generation, operation_id),
  foreign key (vault_id, client_id) references supasync.clients (vault_id, client_id)
);

create table if not exists supasync.snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  vault_id uuid not null references supasync.vaults (id) on delete cascade,
  client_id uuid not null,
  user_id uuid not null,
  server_epoch uuid not null,
  head_seq bigint not null,
  expires_at timestamptz not null,
  state text not null default 'active',
  item_count integer not null default 0
);

create table if not exists supasync.snapshot_items (
  snapshot_id uuid not null references supasync.snapshots (snapshot_id) on delete cascade,
  entry_id uuid not null,
  seq bigint not null,
  primary key (snapshot_id, entry_id)
);

create table if not exists supasync.storage_migrations (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid not null references supasync.vaults (id) on delete cascade,
  source_backend_id uuid not null,
  target_backend_id uuid not null,
  state text not null default 'running',
  copied_count integer not null default 0,
  total_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create table if not exists public.supasync_wakeup (
  vault_id uuid primary key,
  head_seq bigint not null,
  updated_at timestamptz not null default now()
);

alter table public.supasync_wakeup replica identity full;

create index if not exists revisions_feed_idx on supasync.revisions (vault_id, seq);
create index if not exists revisions_entry_history_idx on supasync.revisions (vault_id, entry_id, version);
create index if not exists members_user_idx on supasync.vault_members (user_id, status);
create index if not exists clients_progress_idx on supasync.clients (vault_id, applied_cursor);
create index if not exists blobs_state_idx on supasync.blobs (vault_id, state);
create index if not exists snapshot_items_keyset_idx on supasync.snapshot_items (snapshot_id, entry_id);

create or replace function supasync.is_enabled_member(p_vault_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = supasync
as $$
  select exists (
    select 1
    from supasync.vault_members m
    where m.vault_id = p_vault_id
      and m.user_id = p_user_id
      and m.status = 'enabled'
  );
$$;

revoke all on function supasync.is_enabled_member(uuid, uuid) from public, anon;
grant execute on function supasync.is_enabled_member(uuid, uuid) to authenticated, service_role;

alter table supasync.vaults enable row level security;
alter table supasync.vault_members enable row level security;
alter table supasync.clients enable row level security;
alter table supasync.storage_backends enable row level security;
alter table supasync.text_bodies enable row level security;
alter table supasync.blobs enable row level security;
alter table supasync.blob_locations enable row level security;
alter table supasync.entries enable row level security;
alter table supasync.revisions enable row level security;
alter table supasync.operation_receipts enable row level security;
alter table supasync.snapshots enable row level security;
alter table supasync.snapshot_items enable row level security;
alter table supasync.storage_migrations enable row level security;
alter table public.supasync_wakeup enable row level security;

create policy vaults_member_read on supasync.vaults
  for select to authenticated
  using (supasync.is_enabled_member(id, auth.uid()));

create policy members_member_read on supasync.vault_members
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()));

create policy clients_self_read on supasync.clients
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()));

create policy backends_member_read on supasync.storage_backends
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()));

create policy bodies_member_read on supasync.text_bodies
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()));

create policy blobs_member_read on supasync.blobs
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()) and state = 'ready');

create policy blob_locations_member_read on supasync.blob_locations
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()) and state = 'sealed');

create policy entries_member_read on supasync.entries
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()));

create policy revisions_member_read on supasync.revisions
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()));

create policy receipts_self_read on supasync.operation_receipts
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()));

create policy snapshots_self_read on supasync.snapshots
  for select to authenticated
  using (user_id = auth.uid());

create policy snapshot_items_self_read on supasync.snapshot_items
  for select to authenticated
  using (
    exists (
      select 1 from supasync.snapshots s
      where s.snapshot_id = snapshot_items.snapshot_id
        and s.user_id = auth.uid()
    )
  );

create policy migrations_owner_read on supasync.storage_migrations
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()));

create policy wakeup_member_read on public.supasync_wakeup
  for select to authenticated
  using (supasync.is_enabled_member(vault_id, auth.uid()));

grant select on public.supasync_wakeup to authenticated, service_role;
grant select on all tables in schema supasync to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.supasync_wakeup;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

insert into storage.buckets (id, name, public, file_size_limit)
values ('supasync-blobs', 'supasync-blobs', false, 26214400)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

-- No authenticated/anon policies on this private bucket. Clients use
-- short-lived signed URLs created by the service-role gateway.
