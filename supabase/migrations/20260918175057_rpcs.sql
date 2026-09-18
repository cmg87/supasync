-- Service-only transaction RPCs. Each function checks membership explicitly
-- because service_role bypasses RLS. head_seq advances under the vault row lock.

create or replace function supasync.err(code text, message text, details jsonb default '{}'::jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object('code', code, 'message', message, 'details', coalesce(details, '{}'::jsonb))
  );
$$;

create or replace function supasync.ok(data jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('ok', true, 'data', coalesce(data, '{}'::jsonb));
$$;

create or replace function supasync.role_rank(p_role supasync.member_role)
returns integer
language sql
immutable
as $$
  select case p_role
    when 'reader' then 1
    when 'editor' then 2
    when 'owner' then 3
  end;
$$;

create or replace function supasync.sha256_text(p_body text)
returns text
language sql
immutable
as $$
  select encode(extensions.digest(convert_to(p_body, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function supasync.revision_json(r supasync.revisions)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'vaultId', r.vault_id,
    'seq', r.seq::text,
    'entryId', r.entry_id,
    'version', r.version,
    'parentSeq', r.parent_seq::text,
    'path', r.path,
    'pathKey', r.path_key,
    'kind', r.kind,
    'textSha256', r.text_sha256,
    'blobId', r.blob_id,
    'tombstone', r.tombstone,
    'actorId', r.actor_id,
    'clientId', r.client_id,
    'operationId', r.operation_id,
    'serverTime', r.server_ts,
    'conflictOf', r.conflict_of,
    'conflictOperationId', r.conflict_operation_id
  );
$$;

create or replace function supasync.emit_wakeup(p_vault_id uuid, p_head_seq bigint)
returns void
language plpgsql
as $$
begin
  insert into public.supasync_wakeup (vault_id, head_seq, updated_at)
  values (p_vault_id, p_head_seq, now())
  on conflict (vault_id) do update
    set head_seq = excluded.head_seq,
        updated_at = excluded.updated_at;
end;
$$;

create or replace function supasync.lock_vault(p_vault_id uuid)
returns supasync.vaults
language plpgsql
as $$
declare
  v_vault supasync.vaults;
begin
  select * into v_vault from supasync.vaults where id = p_vault_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  return v_vault;
end;
$$;

create or replace function supasync.require_member(
  p_vault supasync.vaults,
  p_actor uuid,
  p_min_role supasync.member_role
)
returns supasync.vault_members
language plpgsql
as $$
declare
  v_member supasync.vault_members;
begin
  select * into v_member
  from supasync.vault_members
  where vault_id = p_vault.id
    and user_id = p_actor
    and status = 'enabled';
  if not found then
    raise exception 'PERMISSION_DENIED' using errcode = 'P0001';
  end if;
  if supasync.role_rank(v_member.role) < supasync.role_rank(p_min_role) then
    raise exception 'PERMISSION_DENIED' using errcode = 'P0001';
  end if;
  return v_member;
end;
$$;

create or replace function supasync.require_client(
  p_vault supasync.vaults,
  p_actor uuid,
  p_client_id uuid,
  p_generation integer
)
returns supasync.clients
language plpgsql
as $$
declare
  v_client supasync.clients;
begin
  select * into v_client
  from supasync.clients
  where vault_id = p_vault.id
    and client_id = p_client_id
  for update;
  if not found or not v_client.enabled then
    raise exception 'PERMISSION_DENIED' using errcode = 'P0001';
  end if;
  if v_client.user_id <> p_actor then
    raise exception 'PERMISSION_DENIED' using errcode = 'P0001';
  end if;
  if v_client.generation <> p_generation then
    raise exception 'CLIENT_GENERATION_EXPIRED' using errcode = 'P0001';
  end if;
  update supasync.clients
    set last_seen = now()
    where vault_id = p_vault.id and client_id = p_client_id;
  return v_client;
end;
$$;

create or replace function supasync.ensure_text_body(
  p_vault_id uuid,
  p_text text,
  p_sha text,
  p_len integer
)
returns text
language plpgsql
as $$
declare
  v_hash text;
begin
  if p_text is null then
    raise exception 'INVALID_TEXT' using errcode = 'P0001';
  end if;
  if position('\x00'::bytea in convert_to(p_text, 'UTF8')) > 0 then
    raise exception 'INVALID_TEXT' using errcode = 'P0001';
  end if;
  v_hash := supasync.sha256_text(p_text);
  if p_sha is not null and p_sha <> v_hash then
    raise exception 'HASH_MISMATCH' using errcode = 'P0001';
  end if;
  insert into supasync.text_bodies (vault_id, sha256, body, byte_length)
  values (p_vault_id, v_hash, p_text, coalesce(p_len, octet_length(convert_to(p_text, 'UTF8'))))
  on conflict (vault_id, sha256) do nothing;
  return v_hash;
end;
$$;

create or replace function supasync.require_ready_blob(p_vault_id uuid, p_blob_id uuid)
returns void
language plpgsql
as $$
declare
  v_blob supasync.blobs;
begin
  select * into v_blob from supasync.blobs where vault_id = p_vault_id and blob_id = p_blob_id;
  if not found or v_blob.state <> 'ready' then
    raise exception 'BLOB_NOT_READY' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function supasync.append_entry_revision(
  p_vault_id uuid,
  p_entry_id uuid,
  p_path text,
  p_path_key text,
  p_kind supasync.entry_kind,
  p_text_sha text,
  p_blob_id uuid,
  p_tombstone boolean,
  p_actor uuid,
  p_client uuid,
  p_op uuid,
  p_conflict_of uuid,
  p_conflict_op uuid,
  p_namespace boolean,
  p_parent_id uuid
)
returns supasync.revisions
language plpgsql
as $$
declare
  v_seq bigint;
  v_version integer;
  v_parent_seq bigint;
  v_rev supasync.revisions;
  v_exists boolean;
begin
  select true into v_exists from supasync.entries where vault_id = p_vault_id and entry_id = p_entry_id;
  if not coalesce(v_exists, false) then
    insert into supasync.entries (
      vault_id, entry_id, path, path_key, parent_id, kind, current_version, deleted, conflict_of, conflict_operation_id
    ) values (
      p_vault_id, p_entry_id, p_path, p_path_key, p_parent_id, p_kind, 0, false, p_conflict_of, p_conflict_op
    );
    v_parent_seq := null;
    v_version := 1;
  else
    select current_seq, current_version + 1
      into v_parent_seq, v_version
    from supasync.entries
    where vault_id = p_vault_id and entry_id = p_entry_id;
  end if;

  update supasync.vaults
    set head_seq = head_seq + 1,
        namespace_seq = namespace_seq + case when p_namespace then 1 else 0 end
    where id = p_vault_id
    returning head_seq into v_seq;

  insert into supasync.revisions (
    vault_id, seq, entry_id, version, parent_seq, path, path_key, kind,
    text_sha256, blob_id, tombstone, actor_id, client_id, operation_id,
    conflict_of, conflict_operation_id
  ) values (
    p_vault_id, v_seq, p_entry_id, v_version, v_parent_seq, p_path, p_path_key, p_kind,
    p_text_sha, p_blob_id, p_tombstone, p_actor, p_client, p_op,
    p_conflict_of, p_conflict_op
  ) returning * into v_rev;

  update supasync.entries
    set path = p_path,
        path_key = p_path_key,
        parent_id = p_parent_id,
        kind = p_kind,
        current_version = v_version,
        current_seq = v_seq,
        deleted = p_tombstone,
        conflict_of = p_conflict_of,
        conflict_operation_id = p_conflict_op
    where vault_id = p_vault_id and entry_id = p_entry_id;

  perform supasync.emit_wakeup(p_vault_id, v_seq);
  return v_rev;
end;
$$;

create or replace function supasync.parent_id_for_path(p_vault_id uuid, p_path text)
returns uuid
language plpgsql
as $$
declare
  v_parent_path text;
  v_parent uuid;
begin
  if position('/' in p_path) = 0 then
    return null;
  end if;
  v_parent_path := left(p_path, length(p_path) - length(split_part(p_path, '/', -1)) - 1);
  select entry_id into v_parent
  from supasync.entries
  where vault_id = p_vault_id
    and path = v_parent_path
    and kind = 'folder'
    and deleted = false;
  if v_parent is null then
    raise exception 'STALE_NAMESPACE' using errcode = 'P0001';
  end if;
  return v_parent;
end;
$$;

create or replace function supasync.lookup_receipt(
  p_vault_id uuid,
  p_client_id uuid,
  p_generation integer,
  p_operation_id uuid,
  p_digest text
)
returns jsonb
language plpgsql
as $$
declare
  v_row supasync.operation_receipts;
begin
  select * into v_row
  from supasync.operation_receipts
  where vault_id = p_vault_id
    and client_id = p_client_id
    and generation = p_generation
    and operation_id = p_operation_id;
  if found then
    if v_row.request_digest <> p_digest then
      return supasync.err('ID_REUSE', 'operation id was reused with a different payload');
    end if;
    return v_row.outcome;
  end if;
  return null;
end;
$$;

create or replace function supasync.store_receipt(
  p_vault_id uuid,
  p_client_id uuid,
  p_generation integer,
  p_operation_id uuid,
  p_digest text,
  p_outcome jsonb,
  p_seq bigint
)
returns jsonb
language plpgsql
as $$
begin
  insert into supasync.operation_receipts (
    vault_id, client_id, generation, operation_id, request_digest, outcome, created_seq
  ) values (
    p_vault_id, p_client_id, p_generation, p_operation_id, p_digest, p_outcome, p_seq
  );
  return p_outcome;
end;
$$;

create or replace function supasync.commit_op(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public, extensions
as $$
declare
  env jsonb := p_request -> 'envelope';
  v_vault supasync.vaults;
  v_entry supasync.entries;
  v_current supasync.revisions;
  v_rev supasync.revisions;
  v_client supasync.clients;
  v_receipt jsonb;
  v_digest text := p_request ->> 'request_digest';
  v_path_key text := coalesce(p_request ->> 'path_key', env -> 'payload' ->> 'path_key');
  v_type text := env ->> 'type';
  v_op uuid := (env ->> 'operation_id')::uuid;
  v_client_id uuid := (env ->> 'client_id')::uuid;
  v_gen integer := (env ->> 'client_generation')::integer;
  v_entry_id uuid := nullif(env ->> 'entry_id', '')::uuid;
  v_base bigint := nullif(env ->> 'base_revision_id', '')::bigint;
  v_path text := env -> 'payload' ->> 'path';
  v_kind text := coalesce(env -> 'payload' ->> 'kind', 'markdown');
  v_text text := env -> 'payload' ->> 'text';
  v_sha text;
  v_blob uuid := nullif(env -> 'payload' ->> 'blob_id', '')::uuid;
  v_to_path text := env -> 'payload' ->> 'to_path';
  v_from_seq bigint := nullif(env -> 'payload' ->> 'from_seq', '')::bigint;
  v_parent uuid;
  v_outcome jsonb;
  v_namespace boolean := false;
begin
  if env is null then
    return supasync.err('UNAVAILABLE', 'envelope is required');
  end if;
  if (env ->> 'protocol_version')::int <> 1 then
    return supasync.err('PROTOCOL_UPGRADE_REQUIRED', 'unsupported protocol version');
  end if;

  begin
    v_vault := supasync.lock_vault((env ->> 'vault_id')::uuid);
  exception when others then
    return supasync.err('NOT_FOUND', 'vault not found');
  end;

  if v_vault.server_epoch <> (env ->> 'server_epoch')::uuid then
    return supasync.err('EPOCH_MISMATCH', 'client epoch does not match the server', jsonb_build_object('serverEpoch', v_vault.server_epoch));
  end if;

  begin
    perform supasync.require_member(v_vault, p_actor, 'editor');
    v_client := supasync.require_client(v_vault, p_actor, v_client_id, v_gen);
  exception when others then
    if sqlerrm = 'CLIENT_GENERATION_EXPIRED' then
      return supasync.err('CLIENT_GENERATION_EXPIRED', 'client generation is no longer active');
    end if;
    return supasync.err('PERMISSION_DENIED', 'actor cannot mutate this vault');
  end;

  v_receipt := supasync.lookup_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest);
  if v_receipt is not null then
    return v_receipt;
  end if;

  if v_type in ('update', 'delete', 'rename', 'convert_kind', 'resolve_conflict', 'restore_revision') then
    select * into v_entry from supasync.entries where vault_id = v_vault.id and entry_id = v_entry_id;
    if not found then
      return supasync.err('NOT_FOUND', 'entry not found');
    end if;
    select * into v_current from supasync.revisions where vault_id = v_vault.id and seq = v_entry.current_seq;
    if v_base is null or v_current.seq <> v_base then
      v_outcome := supasync.err('BASE_CONFLICT', 'entry changed since the declared base revision', jsonb_build_object('current', supasync.revision_json(v_current)));
      return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_vault.head_seq);
    end if;
  end if;

  if v_type = 'create' then
    if v_path is null or v_path_key is null or v_entry_id is null then
      return supasync.err('INVALID_PATH', 'create requires entry id, path, and path key');
    end if;
    if exists (select 1 from supasync.entries where vault_id = v_vault.id and path_key = v_path_key and deleted = false) then
      select r.* into v_current
      from supasync.entries e
      join supasync.revisions r on r.vault_id = e.vault_id and r.seq = e.current_seq
      where e.vault_id = v_vault.id and e.path_key = v_path_key and e.deleted = false;
      v_outcome := supasync.err('PATH_COLLISION', 'a live entry already uses this portable path', jsonb_build_object('current', supasync.revision_json(v_current)));
      return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_vault.head_seq);
    end if;
    begin
      v_parent := supasync.parent_id_for_path(v_vault.id, v_path);
    exception when others then
      return supasync.err('STALE_NAMESPACE', 'parent folder is missing');
    end;
    if v_kind = 'markdown' then
      begin
        v_sha := supasync.ensure_text_body(v_vault.id, v_text, p_request ->> 'text_sha256', octet_length(convert_to(v_text, 'UTF8')));
      exception when others then
        return supasync.err(sqlerrm, 'markdown body was rejected');
      end;
    elsif v_kind = 'blob' then
      begin
        perform supasync.require_ready_blob(v_vault.id, v_blob);
      exception when others then
        return supasync.err('BLOB_NOT_READY', 'blob is not ready');
      end;
    elsif v_kind <> 'folder' then
      return supasync.err('UNAVAILABLE', 'unknown entry kind');
    end if;
    v_rev := supasync.append_entry_revision(
      v_vault.id, v_entry_id, v_path, v_path_key, v_kind::supasync.entry_kind,
      v_sha, v_blob, false, p_actor, v_client_id, v_op,
      nullif(env -> 'payload' ->> 'conflict_of', '')::uuid,
      nullif(env -> 'payload' ->> 'conflict_operation_id', '')::uuid,
      true, v_parent
    );
    v_outcome := supasync.ok(jsonb_build_object('outcome', 'accepted', 'operationId', v_op, 'revision', supasync.revision_json(v_rev)));
    return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_rev.seq);
  end if;

  if v_type = 'update' then
    v_path := coalesce(v_path, v_entry.path);
    v_path_key := coalesce(v_path_key, v_entry.path_key);
    v_kind := v_entry.kind::text;
    if v_path_key <> v_entry.path_key then
      return supasync.err('UNAVAILABLE', 'use rename to change paths');
    end if;
    if v_entry.kind = 'markdown' then
      v_sha := supasync.ensure_text_body(v_vault.id, v_text, p_request ->> 'text_sha256', octet_length(convert_to(v_text, 'UTF8')));
      if v_sha = v_current.text_sha256 and v_path = v_entry.path then
        v_outcome := supasync.ok(jsonb_build_object('outcome', 'noop', 'operationId', v_op, 'revision', supasync.revision_json(v_current)));
        return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_current.seq);
      end if;
    elsif v_entry.kind = 'blob' then
      perform supasync.require_ready_blob(v_vault.id, v_blob);
      if v_blob = v_current.blob_id then
        v_outcome := supasync.ok(jsonb_build_object('outcome', 'noop', 'operationId', v_op, 'revision', supasync.revision_json(v_current)));
        return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_current.seq);
      end if;
    else
      return supasync.err('UNAVAILABLE', 'folders are updated via namespace operations');
    end if;
    v_rev := supasync.append_entry_revision(
      v_vault.id, v_entry_id, v_path, v_path_key, v_entry.kind,
      v_sha, v_blob, false, p_actor, v_client_id, v_op,
      v_entry.conflict_of, v_entry.conflict_operation_id, false, v_entry.parent_id
    );
    v_outcome := supasync.ok(jsonb_build_object('outcome', 'accepted', 'operationId', v_op, 'revision', supasync.revision_json(v_rev)));
    return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_rev.seq);
  end if;

  if v_type = 'delete' then
    if v_entry.deleted then
      v_outcome := supasync.ok(jsonb_build_object('outcome', 'noop', 'operationId', v_op, 'revision', supasync.revision_json(v_current)));
      return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_current.seq);
    end if;
    v_rev := supasync.append_entry_revision(
      v_vault.id, v_entry_id, v_entry.path, v_entry.path_key, v_entry.kind,
      null, null, true, p_actor, v_client_id, v_op,
      v_entry.conflict_of, v_entry.conflict_operation_id, true, v_entry.parent_id
    );
    v_outcome := supasync.ok(jsonb_build_object('outcome', 'accepted', 'operationId', v_op, 'revision', supasync.revision_json(v_rev)));
    return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_rev.seq);
  end if;

  if v_type = 'rename' then
    v_path := v_to_path;
    v_path_key := coalesce(v_path_key, v_to_path);
    if exists (select 1 from supasync.entries where vault_id = v_vault.id and path_key = v_path_key and deleted = false and entry_id <> v_entry_id) then
      v_outcome := supasync.err('PATH_COLLISION', 'rename destination is already in use');
      return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_vault.head_seq);
    end if;
    v_parent := supasync.parent_id_for_path(v_vault.id, v_path);
    v_namespace := v_path_key <> v_entry.path_key or v_path <> v_entry.path;
    if not v_namespace then
      v_outcome := supasync.ok(jsonb_build_object('outcome', 'noop', 'operationId', v_op, 'revision', supasync.revision_json(v_current)));
      return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_current.seq);
    end if;
    v_rev := supasync.append_entry_revision(
      v_vault.id, v_entry_id, v_path, v_path_key, v_entry.kind,
      v_current.text_sha256, v_current.blob_id, false, p_actor, v_client_id, v_op,
      v_entry.conflict_of, v_entry.conflict_operation_id, true, v_parent
    );
    v_outcome := supasync.ok(jsonb_build_object('outcome', 'accepted', 'operationId', v_op, 'revision', supasync.revision_json(v_rev)));
    return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_rev.seq);
  end if;

  if v_type = 'convert_kind' then
    v_path := coalesce(v_to_path, v_path);
    if v_kind = 'markdown' then
      v_sha := supasync.ensure_text_body(v_vault.id, v_text, p_request ->> 'text_sha256', octet_length(convert_to(v_text, 'UTF8')));
      v_blob := null;
    elsif v_kind = 'blob' then
      perform supasync.require_ready_blob(v_vault.id, v_blob);
      v_sha := null;
    else
      return supasync.err('UNSUPPORTED_CONVERSION', 'unsupported kind conversion');
    end if;
    v_parent := supasync.parent_id_for_path(v_vault.id, v_path);
    v_rev := supasync.append_entry_revision(
      v_vault.id, v_entry_id, v_path, v_path_key, v_kind::supasync.entry_kind,
      v_sha, v_blob, false, p_actor, v_client_id, v_op,
      v_entry.conflict_of, v_entry.conflict_operation_id, true, v_parent
    );
    v_outcome := supasync.ok(jsonb_build_object('outcome', 'accepted', 'operationId', v_op, 'revision', supasync.revision_json(v_rev)));
    return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_rev.seq);
  end if;

  if v_type = 'create_conflict_copy' then
    env := jsonb_set(env, '{type}', '"create"');
    p_request := jsonb_set(p_request, '{envelope}', env);
    return supasync.commit_op(p_actor, p_request);
  end if;

  if v_type = 'restore_revision' then
    select * into v_rev from supasync.revisions where vault_id = v_vault.id and seq = v_from_seq and entry_id = v_entry_id;
    if not found then
      return supasync.err('NOT_FOUND', 'revision not found');
    end if;
    v_rev := supasync.append_entry_revision(
      v_vault.id, v_entry_id, v_entry.path, v_entry.path_key, v_rev.kind,
      v_rev.text_sha256, v_rev.blob_id, false, p_actor, v_client_id, v_op,
      v_entry.conflict_of, v_entry.conflict_operation_id, false, v_entry.parent_id
    );
    v_outcome := supasync.ok(jsonb_build_object('outcome', 'accepted', 'operationId', v_op, 'revision', supasync.revision_json(v_rev)));
    return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_rev.seq);
  end if;

  if v_type = 'resolve_conflict' then
    if v_entry.kind = 'markdown' then
      v_sha := supasync.ensure_text_body(v_vault.id, v_text, p_request ->> 'text_sha256', octet_length(convert_to(v_text, 'UTF8')));
    end if;
    v_rev := supasync.append_entry_revision(
      v_vault.id, v_entry_id, v_entry.path, v_entry.path_key, v_entry.kind,
      v_sha, v_blob, false, p_actor, v_client_id, v_op,
      null, null, false, v_entry.parent_id
    );
    v_outcome := supasync.ok(jsonb_build_object('outcome', 'accepted', 'operationId', v_op, 'revision', supasync.revision_json(v_rev)));
    return supasync.store_receipt(v_vault.id, v_client_id, v_gen, v_op, v_digest, v_outcome, v_rev.seq);
  end if;

  return supasync.err('UNAVAILABLE', 'unknown mutation type', jsonb_build_object('type', v_type));
end;
$$;

create or replace function supasync.list_vaults(p_actor uuid, p_request jsonb)
returns jsonb
language sql
security invoker
set search_path = supasync, public
as $$
  select supasync.ok(jsonb_build_object(
    'vaults', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id,
        'name', v.name,
        'role', m.role,
        'protocolVersion', v.protocol_version,
        'serverEpoch', v.server_epoch,
        'headSeq', v.head_seq::text,
        'namespaceSeq', v.namespace_seq::text,
        'replayFloor', v.replay_floor::text,
        'defaultStorageBackendId', v.default_storage_backend_id,
        'retentionDays', v.retention_days,
        'minVersionsPerEntry', v.min_versions_per_entry,
        'maxBlobBytes', v.max_blob_bytes,
        'maxTextBytes', v.max_text_bytes
      ) order by v.created_at)
      from supasync.vaults v
      join supasync.vault_members m on m.vault_id = v.id
      where m.user_id = p_actor and m.status = 'enabled'
    ), '[]'::jsonb)
  ));
$$;

create or replace function supasync.create_vault(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault_id uuid := gen_random_uuid();
  v_backend_id uuid := gen_random_uuid();
  v_name text := coalesce(p_request ->> 'name', 'Vault');
begin
  insert into supasync.vaults (id, name, owner_id)
  values (v_vault_id, v_name, p_actor);
  insert into supasync.vault_members (vault_id, user_id, role, status)
  values (v_vault_id, p_actor, 'owner', 'enabled');
  insert into supasync.storage_backends (
    id, vault_id, provider, bucket, display_label, secret_ref, is_default
  ) values (
    v_backend_id, v_vault_id, 'supabase_storage', 'supasync-blobs', 'Supabase Storage', 'supabase_storage', true
  );
  update supasync.vaults set default_storage_backend_id = v_backend_id where id = v_vault_id;
  return (
    select supasync.ok(jsonb_build_object('vault', jsonb_build_object(
      'id', v.id,
      'name', v.name,
      'role', 'owner',
      'protocolVersion', v.protocol_version,
      'serverEpoch', v.server_epoch,
      'headSeq', v.head_seq::text,
      'namespaceSeq', v.namespace_seq::text,
      'replayFloor', v.replay_floor::text,
      'defaultStorageBackendId', v.default_storage_backend_id,
      'retentionDays', v.retention_days,
      'minVersionsPerEntry', v.min_versions_per_entry,
      'maxBlobBytes', v.max_blob_bytes,
      'maxTextBytes', v.max_text_bytes
    )))
    from supasync.vaults v where v.id = v_vault_id
  );
end;
$$;

create or replace function supasync.register_client(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_client supasync.clients;
  v_client_id uuid := (p_request ->> 'client_id')::uuid;
  v_reset boolean := coalesce((p_request ->> 'reset_generation')::boolean, false);
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'reader');
  select * into v_client from supasync.clients where vault_id = v_vault.id and client_id = v_client_id for update;
  if not found then
    insert into supasync.clients (vault_id, client_id, user_id, label, platform, generation)
    values (
      v_vault.id, v_client_id, p_actor,
      coalesce(p_request ->> 'label', 'device'),
      coalesce(p_request ->> 'platform', 'unknown'),
      1
    ) returning * into v_client;
  else
    if v_client.user_id <> p_actor then
      return supasync.err('PERMISSION_DENIED', 'client belongs to another user');
    end if;
    if v_reset then
      update supasync.clients
        set generation = generation + 1,
            label = coalesce(p_request ->> 'label', label),
            platform = coalesce(p_request ->> 'platform', platform),
            last_seen = now(),
            bootstrap_state = 'reset'
        where vault_id = v_vault.id and client_id = v_client_id
        returning * into v_client;
    else
      update supasync.clients
        set label = coalesce(p_request ->> 'label', label),
            platform = coalesce(p_request ->> 'platform', platform),
            last_seen = now()
        where vault_id = v_vault.id and client_id = v_client_id
        returning * into v_client;
    end if;
  end if;
  return supasync.ok(jsonb_build_object(
    'vaultId', v_client.vault_id,
    'clientId', v_client.client_id,
    'generation', v_client.generation,
    'label', v_client.label,
    'platform', v_client.platform,
    'appliedCursor', v_client.applied_cursor::text,
    'bootstrapState', v_client.bootstrap_state
  ));
end;
$$;

create or replace function supasync.capabilities(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'reader');
  return supasync.ok(jsonb_build_object(
    'protocolVersion', v_vault.protocol_version,
    'compatibleProtocolVersions', jsonb_build_array(1),
    'pathCanonVersion', 'pathcanon-1',
    'serverEpoch', v_vault.server_epoch,
    'vaultId', v_vault.id,
    'headSeq', v_vault.head_seq::text,
    'namespaceSeq', v_vault.namespace_seq::text,
    'replayFloor', v_vault.replay_floor::text,
    'retentionDays', v_vault.retention_days,
    'minVersionsPerEntry', v_vault.min_versions_per_entry,
    'maxBlobBytes', v_vault.max_blob_bytes,
    'maxTextBytes', v_vault.max_text_bytes,
    'pullPageSize', 100,
    'storageBackends', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id,
        'provider', b.provider,
        'label', b.display_label,
        'bucket', b.bucket,
        'region', b.region,
        'endpoint', b.endpoint,
        'isDefault', b.is_default
      ))
      from supasync.storage_backends b
      where b.vault_id = v_vault.id
    ), '[]'::jsonb)
  ));
end;
$$;

create or replace function supasync.pull_changes(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_after bigint := coalesce(nullif(p_request ->> 'after_seq', '')::bigint, 0);
  v_ceiling bigint := nullif(p_request ->> 'ceiling', '')::bigint;
  v_limit integer := least(coalesce((p_request ->> 'limit')::int, 100), 100);
  v_rows jsonb;
  v_next bigint;
  v_count integer;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'reader');
  if v_ceiling is null then
    v_ceiling := v_vault.head_seq;
  end if;
  if v_after < v_vault.replay_floor then
    return supasync.err('CURSOR_EXPIRED', 'replay cursor is below the retention floor', jsonb_build_object('replayFloor', v_vault.replay_floor::text));
  end if;
  select coalesce(jsonb_agg(supasync.revision_json(r) order by r.seq), '[]'::jsonb), count(*), coalesce(max(r.seq), v_after)
    into v_rows, v_count, v_next
  from (
    select *
    from supasync.revisions
    where vault_id = v_vault.id
      and seq > v_after
      and seq <= v_ceiling
    order by seq
    limit v_limit
  ) r;
  return supasync.ok(jsonb_build_object(
    'afterSeq', v_after::text,
    'ceiling', v_ceiling::text,
    'nextCursor', v_next::text,
    'exhausted', v_next >= v_ceiling or v_count = 0,
    'replayFloor', v_vault.replay_floor::text,
    'revisions', v_rows
  ));
end;
$$;

create or replace function supasync.begin_snapshot(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_snap uuid := gen_random_uuid();
  v_count integer;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'reader');
  perform supasync.require_client(
    v_vault, p_actor, (p_request ->> 'client_id')::uuid, (p_request ->> 'client_generation')::int
  );
  insert into supasync.snapshots (snapshot_id, vault_id, client_id, user_id, server_epoch, head_seq, expires_at, state, item_count)
  values (
    v_snap, v_vault.id, (p_request ->> 'client_id')::uuid, p_actor, v_vault.server_epoch, v_vault.head_seq,
    now() + interval '24 hours', 'active', 0
  );
  insert into supasync.snapshot_items (snapshot_id, entry_id, seq)
  select v_snap, e.entry_id, e.current_seq
  from supasync.entries e
  where e.vault_id = v_vault.id and e.deleted = false and e.current_seq is not null;
  get diagnostics v_count = row_count;
  update supasync.snapshots set item_count = v_count where snapshot_id = v_snap;
  return supasync.ok(jsonb_build_object(
    'snapshotId', v_snap,
    'headSeq', v_vault.head_seq::text,
    'serverEpoch', v_vault.server_epoch,
    'expiresAt', (now() + interval '24 hours'),
    'itemCount', v_count
  ));
end;
$$;

create or replace function supasync.list_snapshot(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_snap supasync.snapshots;
  v_after uuid := nullif(p_request ->> 'after_entry_id', '')::uuid;
  v_limit integer := least(coalesce((p_request ->> 'limit')::int, 100), 100);
  v_rows jsonb;
  v_last uuid;
begin
  select * into v_snap from supasync.snapshots where snapshot_id = (p_request ->> 'snapshot_id')::uuid;
  if not found or v_snap.user_id <> p_actor then
    return supasync.err('NOT_FOUND', 'snapshot not found');
  end if;
  if v_snap.expires_at < now() or v_snap.state <> 'active' then
    return supasync.err('CURSOR_EXPIRED', 'snapshot expired');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('entryId', i.entry_id, 'revision', supasync.revision_json(r)) order by i.entry_id), '[]'::jsonb),
         max(i.entry_id)
    into v_rows, v_last
  from (
    select *
    from supasync.snapshot_items
    where snapshot_id = v_snap.snapshot_id
      and (v_after is null or entry_id > v_after)
    order by entry_id
    limit v_limit
  ) i
  join supasync.revisions r on r.vault_id = v_snap.vault_id and r.seq = i.seq;
  return supasync.ok(jsonb_build_object(
    'items', v_rows,
    'nextCursor', v_last,
    'exhausted', coalesce(v_last is null, true) or (
      not exists (
        select 1 from supasync.snapshot_items s
        where s.snapshot_id = v_snap.snapshot_id and s.entry_id > v_last
      )
    )
  ));
end;
$$;

create or replace function supasync.get_revisions(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_ids bigint[];
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'reader');
  select array_agg((value)::bigint) into v_ids from jsonb_array_elements_text(p_request -> 'seqs');
  return supasync.ok(jsonb_build_object(
    'revisions', coalesce((
      select jsonb_agg(supasync.revision_json(r) order by r.seq)
      from supasync.revisions r
      where r.vault_id = v_vault.id and r.seq = any (v_ids)
    ), '[]'::jsonb)
  ));
end;
$$;

create or replace function supasync.get_bodies(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_hashes text[];
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'reader');
  select array_agg(value) into v_hashes from jsonb_array_elements_text(coalesce(p_request -> 'sha256s', '[]'::jsonb));
  return supasync.ok(jsonb_build_object(
    'bodies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sha256', b.sha256,
        'text', b.body,
        'byteLength', b.byte_length
      ))
      from supasync.text_bodies b
      where b.vault_id = v_vault.id and b.sha256 = any (coalesce(v_hashes, array[]::text[]))
    ), '[]'::jsonb)
  ));
end;
$$;

create or replace function supasync.ack_applied(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_cursor bigint := (p_request ->> 'applied_seq')::bigint;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'reader');
  perform supasync.require_client(
    v_vault, p_actor, (p_request ->> 'client_id')::uuid, (p_request ->> 'client_generation')::int
  );
  if v_cursor is null or v_cursor > v_vault.head_seq then
    return supasync.err('UNAVAILABLE', 'applied cursor is ahead of the server head');
  end if;
  update supasync.clients
    set applied_cursor = greatest(applied_cursor, v_cursor)
    where vault_id = v_vault.id and client_id = (p_request ->> 'client_id')::uuid;
  return supasync.ok(jsonb_build_object('appliedSeq', v_cursor::text));
end;
$$;

create or replace function supasync.add_member(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'owner');
  insert into supasync.vault_members (vault_id, user_id, role, status)
  values (
    v_vault.id,
    (p_request ->> 'user_id')::uuid,
    coalesce(p_request ->> 'role', 'editor')::supasync.member_role,
    'enabled'
  )
  on conflict (vault_id, user_id) do update
    set role = excluded.role, status = 'enabled';
  return supasync.ok(jsonb_build_object('ok', true));
end;
$$;

create or replace function supasync.rename_tree(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_folder supasync.entries;
  v_expected bigint := (p_request ->> 'expected_namespace_seq')::bigint;
  v_to_path text := p_request ->> 'to_path';
  v_to_key text := p_request ->> 'path_key';
  v_child record;
  v_new_path text;
  v_new_key text;
  v_count integer := 0;
  v_rev supasync.revisions;
  v_op uuid := (p_request ->> 'operation_id')::uuid;
  v_client uuid := (p_request ->> 'client_id')::uuid;
  v_gen integer := (p_request ->> 'client_generation')::int;
  v_digest text := p_request ->> 'request_digest';
  v_receipt jsonb;
  v_parent uuid;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'editor');
  perform supasync.require_client(v_vault, p_actor, v_client, v_gen);
  v_receipt := supasync.lookup_receipt(v_vault.id, v_client, v_gen, v_op, v_digest);
  if v_receipt is not null then
    return v_receipt;
  end if;
  if v_expected is distinct from v_vault.namespace_seq then
    v_receipt := supasync.err('STALE_NAMESPACE', 'namespace changed since the client snapshot', jsonb_build_object('namespaceSeq', v_vault.namespace_seq::text));
    return supasync.store_receipt(v_vault.id, v_client, v_gen, v_op, v_digest, v_receipt, v_vault.head_seq);
  end if;
  select * into v_folder from supasync.entries where vault_id = v_vault.id and entry_id = (p_request ->> 'folder_id')::uuid;
  if not found or v_folder.kind <> 'folder' or v_folder.deleted then
    return supasync.err('NOT_FOUND', 'folder not found');
  end if;
  if v_to_key = v_folder.path_key or v_to_key like v_folder.path_key || '/%' then
    return supasync.err('STALE_NAMESPACE', 'cannot move a folder into itself');
  end if;
  if (select count(*) from supasync.entries e where e.vault_id = v_vault.id and e.deleted = false and (e.entry_id = v_folder.entry_id or e.path like v_folder.path || '/%')) > 500 then
    return supasync.err('LIMIT_EXCEEDED', 'folder rename exceeds the negotiated size limit');
  end if;

  -- Stage path keys so uniqueness is preserved during the swap.
  update supasync.entries e
    set path_key = e.entry_id::text || ':staging:' || e.path_key
  where e.vault_id = v_vault.id
    and e.deleted = false
    and (e.entry_id = v_folder.entry_id or e.path = v_folder.path or e.path like v_folder.path || '/%');

  for v_child in
    select e.*, r.text_sha256, r.blob_id
    from supasync.entries e
    join supasync.revisions r on r.vault_id = e.vault_id and r.seq = e.current_seq
    where e.vault_id = v_vault.id
      and e.path_key like e.entry_id::text || ':staging:%'
      and (e.entry_id = v_folder.entry_id or split_part(e.path_key, ':staging:', 2) = v_folder.path_key or split_part(e.path_key, ':staging:', 2) like v_folder.path_key || '/%')
    order by length(e.path)
  loop
    if v_child.entry_id = v_folder.entry_id then
      v_new_path := v_to_path;
      v_new_key := v_to_key;
    else
      v_new_path := v_to_path || substr(v_child.path, length(v_folder.path) + 1);
      v_new_key := v_to_key || substr(split_part(v_child.path_key, ':staging:', 2), length(v_folder.path_key) + 1);
    end if;
    if exists (select 1 from supasync.entries x where x.vault_id = v_vault.id and x.deleted = false and x.path_key = v_new_key and x.entry_id <> v_child.entry_id) then
      return supasync.err('PATH_COLLISION', 'rename destination collides with existing paths');
    end if;
    if v_child.entry_id = v_folder.entry_id then
      v_parent := supasync.parent_id_for_path(v_vault.id, v_new_path);
    else
      v_parent := v_child.parent_id;
    end if;
    v_rev := supasync.append_entry_revision(
      v_vault.id, v_child.entry_id, v_new_path, v_new_key, v_child.kind,
      v_child.text_sha256, v_child.blob_id, false, p_actor, v_client, v_op,
      v_child.conflict_of, v_child.conflict_operation_id, true, v_parent
    );
    v_count := v_count + 1;
  end loop;

  v_receipt := supasync.ok(jsonb_build_object('outcome', 'accepted', 'operationId', v_op, 'changed', v_count, 'revision', supasync.revision_json(v_rev)));
  return supasync.store_receipt(v_vault.id, v_client, v_gen, v_op, v_digest, v_receipt, v_rev.seq);
end;
$$;

create or replace function supasync.delete_tree(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_folder supasync.entries;
  v_child supasync.entries;
  v_expected jsonb := coalesce(p_request -> 'expected_children', '[]'::jsonb);
  v_op uuid := (p_request ->> 'operation_id')::uuid;
  v_client uuid := (p_request ->> 'client_id')::uuid;
  v_gen integer := (p_request ->> 'client_generation')::int;
  v_digest text := p_request ->> 'request_digest';
  v_receipt jsonb;
  v_rev supasync.revisions;
  v_exp_ver integer;
  v_count integer := 0;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'editor');
  perform supasync.require_client(v_vault, p_actor, v_client, v_gen);
  v_receipt := supasync.lookup_receipt(v_vault.id, v_client, v_gen, v_op, v_digest);
  if v_receipt is not null then
    return v_receipt;
  end if;
  select * into v_folder from supasync.entries where vault_id = v_vault.id and entry_id = (p_request ->> 'folder_id')::uuid;
  if not found then
    return supasync.err('NOT_FOUND', 'folder not found');
  end if;
  for v_child in
    select * from supasync.entries e
    where e.vault_id = v_vault.id
      and e.deleted = false
      and (e.entry_id = v_folder.entry_id or e.path = v_folder.path or e.path like v_folder.path || '/%')
  loop
    select (value ->> 'version')::int into v_exp_ver
    from jsonb_array_elements(v_expected) value
    where (value ->> 'entry_id')::uuid = v_child.entry_id;
    if v_exp_ver is null or v_exp_ver <> v_child.current_version then
      v_receipt := supasync.err('STALE_NAMESPACE', 'folder tree changed since confirmation', jsonb_build_object('entryId', v_child.entry_id));
      return supasync.store_receipt(v_vault.id, v_client, v_gen, v_op, v_digest, v_receipt, v_vault.head_seq);
    end if;
  end loop;
  for v_child in
    select * from supasync.entries e
    where e.vault_id = v_vault.id
      and e.deleted = false
      and (e.entry_id = v_folder.entry_id or e.path like v_folder.path || '/%' or e.path = v_folder.path)
    order by length(e.path) desc
  loop
    v_rev := supasync.append_entry_revision(
      v_vault.id, v_child.entry_id, v_child.path, v_child.path_key, v_child.kind,
      null, null, true, p_actor, v_client, v_op, v_child.conflict_of, v_child.conflict_operation_id, true, v_child.parent_id
    );
    v_count := v_count + 1;
  end loop;
  v_receipt := supasync.ok(jsonb_build_object('outcome', 'accepted', 'operationId', v_op, 'changed', v_count));
  return supasync.store_receipt(v_vault.id, v_client, v_gen, v_op, v_digest, v_receipt, v_vault.head_seq);
end;
$$;

create or replace function supasync.list_history(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'reader');
  return supasync.ok(jsonb_build_object(
    'revisions', coalesce((
      select jsonb_agg(supasync.revision_json(r) order by r.version desc)
      from supasync.revisions r
      where r.vault_id = v_vault.id and r.entry_id = (p_request ->> 'entry_id')::uuid
    ), '[]'::jsonb)
  ));
end;
$$;

create or replace function supasync.begin_blob_upload(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_backend supasync.storage_backends;
  v_blob_id uuid := gen_random_uuid();
  v_len bigint := (p_request ->> 'expected_length')::bigint;
  v_sha text := p_request ->> 'expected_sha256';
  v_key text;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'editor');
  if v_len is null or v_len < 0 or v_len > v_vault.max_blob_bytes then
    return supasync.err('LIMIT_EXCEEDED', 'attachment exceeds the vault size limit', jsonb_build_object('maxBlobBytes', v_vault.max_blob_bytes));
  end if;
  select * into v_backend from supasync.storage_backends
  where vault_id = v_vault.id and id = coalesce(nullif(p_request ->> 'backend_id', '')::uuid, v_vault.default_storage_backend_id);
  if not found then
    return supasync.err('NOT_FOUND', 'storage backend is not configured');
  end if;
  v_key := 'staging/' || v_vault.id::text || '/' || v_blob_id::text || '/' || replace(gen_random_uuid()::text, '-', '');
  insert into supasync.blobs (
    vault_id, blob_id, expected_sha256, expected_length, mime_hint, state, staging_key, expiry
  ) values (
    v_vault.id, v_blob_id, v_sha, v_len, p_request ->> 'mime_hint', 'reserved', v_key, now() + interval '30 minutes'
  );
  return supasync.ok(jsonb_build_object(
    'blobId', v_blob_id,
    'stagingKey', v_key,
    'backendId', v_backend.id,
    'provider', v_backend.provider,
    'bucket', v_backend.bucket,
    'secretRef', v_backend.secret_ref,
    'endpoint', v_backend.endpoint,
    'region', v_backend.region
  ));
end;
$$;

create or replace function supasync.claim_blob_finalization(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_blob supasync.blobs;
  v_lease uuid := gen_random_uuid();
  v_backend supasync.storage_backends;
  v_final_key text;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'editor');
  select * into v_blob from supasync.blobs
  where vault_id = v_vault.id and blob_id = (p_request ->> 'blob_id')::uuid
  for update;
  if not found then
    return supasync.err('NOT_FOUND', 'blob reservation not found');
  end if;
  if v_blob.state = 'ready' then
    return supasync.ok(jsonb_build_object('alreadyReady', true, 'blobId', v_blob.blob_id, 'verifiedSha256', v_blob.verified_sha256));
  end if;
  if v_blob.finalization_lease is not null and v_blob.finalization_expires > now() then
    return supasync.err('UNAVAILABLE', 'another finalizer holds the lease');
  end if;
  v_final_key := 'final/' || v_vault.id::text || '/' || v_blob.blob_id::text || '/' || replace(v_lease::text, '-', '');
  update supasync.blobs
    set state = 'finalizing',
        finalization_lease = v_lease,
        finalization_expires = now() + interval '120 seconds'
    where vault_id = v_vault.id and blob_id = v_blob.blob_id;
  select * into v_backend from supasync.storage_backends where vault_id = v_vault.id and id = v_vault.default_storage_backend_id;
  return supasync.ok(jsonb_build_object(
    'blobId', v_blob.blob_id,
    'lease', v_lease,
    'stagingKey', v_blob.staging_key,
    'finalKey', v_final_key,
    'expectedSha256', v_blob.expected_sha256,
    'expectedLength', v_blob.expected_length,
    'backendId', v_backend.id,
    'provider', v_backend.provider,
    'bucket', v_backend.bucket,
    'secretRef', v_backend.secret_ref,
    'endpoint', v_backend.endpoint,
    'region', v_backend.region
  ));
end;
$$;

create or replace function supasync.complete_blob_finalization(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_blob supasync.blobs;
  v_lease uuid := (p_request ->> 'lease')::uuid;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'editor');
  select * into v_blob from supasync.blobs
  where vault_id = v_vault.id and blob_id = (p_request ->> 'blob_id')::uuid
  for update;
  if not found then
    return supasync.err('NOT_FOUND', 'blob not found');
  end if;
  if v_blob.state = 'ready' and v_blob.verified_sha256 = p_request ->> 'verified_sha256' then
    return supasync.ok(jsonb_build_object('blobId', v_blob.blob_id, 'state', 'ready'));
  end if;
  if v_blob.finalization_lease is distinct from v_lease or v_blob.state <> 'finalizing' then
    return supasync.err('UNAVAILABLE', 'stale finalizer; the object was not published');
  end if;
  if (p_request ->> 'verified_sha256') <> v_blob.expected_sha256
     or (p_request ->> 'verified_length')::bigint <> v_blob.expected_length then
    update supasync.blobs set state = 'failed' where vault_id = v_vault.id and blob_id = v_blob.blob_id;
    return supasync.err('HASH_MISMATCH', 'sealed object does not match the reserved digest');
  end if;
  update supasync.blobs
    set state = 'ready',
        verified_sha256 = p_request ->> 'verified_sha256',
        verified_length = (p_request ->> 'verified_length')::bigint
    where vault_id = v_vault.id and blob_id = v_blob.blob_id and finalization_lease = v_lease;
  if not found then
    return supasync.err('UNAVAILABLE', 'stale finalizer; the object was not published');
  end if;
  insert into supasync.blob_locations (
    vault_id, blob_id, backend_id, object_key, verified_sha256, verified_length, state
  ) values (
    v_vault.id, v_blob.blob_id, v_vault.default_storage_backend_id,
    p_request ->> 'final_key', p_request ->> 'verified_sha256',
    (p_request ->> 'verified_length')::bigint, 'sealed'
  );
  return supasync.ok(jsonb_build_object('blobId', v_blob.blob_id, 'state', 'ready'));
end;
$$;

create or replace function supasync.get_blob_download(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_loc supasync.blob_locations;
  v_backend supasync.storage_backends;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'reader');
  select * into v_loc
  from supasync.blob_locations
  where vault_id = v_vault.id
    and blob_id = (p_request ->> 'blob_id')::uuid
    and state = 'sealed'
  order by case when backend_id = v_vault.default_storage_backend_id then 0 else 1 end
  limit 1;
  if not found then
    return supasync.err('BLOB_NOT_READY', 'no verified blob location is available');
  end if;
  select * into v_backend from supasync.storage_backends where id = v_loc.backend_id;
  return supasync.ok(jsonb_build_object(
    'blobId', v_loc.blob_id,
    'objectKey', v_loc.object_key,
    'backendId', v_backend.id,
    'provider', v_backend.provider,
    'bucket', v_backend.bucket,
    'secretRef', v_backend.secret_ref,
    'endpoint', v_backend.endpoint,
    'region', v_backend.region,
    'verifiedSha256', v_loc.verified_sha256,
    'verifiedLength', v_loc.verified_length
  ));
end;
$$;

create or replace function supasync.start_storage_migration(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_id uuid := gen_random_uuid();
  v_total integer;
begin
  v_vault := supasync.lock_vault((p_request ->> 'vault_id')::uuid);
  perform supasync.require_member(v_vault, p_actor, 'owner');
  select count(*) into v_total from supasync.blobs where vault_id = v_vault.id and state = 'ready';
  insert into supasync.storage_migrations (id, vault_id, source_backend_id, target_backend_id, total_count)
  values (
    v_id, v_vault.id,
    (p_request ->> 'source_backend_id')::uuid,
    (p_request ->> 'target_backend_id')::uuid,
    v_total
  );
  update supasync.vaults set default_storage_backend_id = (p_request ->> 'target_backend_id')::uuid where id = v_vault.id;
  return supasync.ok(jsonb_build_object('migrationId', v_id, 'totalCount', v_total, 'state', 'running'));
end;
$$;

create or replace function supasync.migration_status(p_actor uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_row supasync.storage_migrations;
begin
  select * into v_row from supasync.storage_migrations where id = (p_request ->> 'migration_id')::uuid;
  if not found then
    return supasync.err('NOT_FOUND', 'migration not found');
  end if;
  perform supasync.require_member(supasync.lock_vault(v_row.vault_id), p_actor, 'reader');
  return supasync.ok(jsonb_build_object(
    'migrationId', v_row.id,
    'state', v_row.state,
    'copiedCount', v_row.copied_count,
    'totalCount', v_row.total_count,
    'lastError', v_row.last_error
  ));
end;
$$;

create or replace function supasync.gc_pass(p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
declare
  v_vault supasync.vaults;
  v_floor bigint;
  v_deleted integer := 0;
  v_n integer;
begin
  for v_vault in select * from supasync.vaults for update
  loop
    select coalesce(min(applied_cursor), v_vault.head_seq) into v_floor
    from supasync.clients where vault_id = v_vault.id and enabled;
    -- Keep current heads, snapshot pins, and a conservative replay window.
    v_floor := least(coalesce(v_floor, 0), v_vault.head_seq);
    if exists (select 1 from supasync.snapshots s where s.vault_id = v_vault.id and s.state = 'active' and s.expires_at > now()) then
      select least(v_floor, min(s.head_seq)) into v_floor
      from supasync.snapshots s
      where s.vault_id = v_vault.id and s.state = 'active' and s.expires_at > now();
    end if;
    update supasync.vaults
      set replay_floor = greatest(replay_floor, v_floor)
      where id = v_vault.id;
    delete from supasync.blobs b
    where b.vault_id = v_vault.id
      and b.state in ('reserved', 'failed')
      and b.expiry < now()
      and not exists (select 1 from supasync.revisions r where r.vault_id = b.vault_id and r.blob_id = b.blob_id);
    get diagnostics v_n = row_count;
    v_deleted := v_deleted + v_n;
  end loop;
  return supasync.ok(jsonb_build_object('expiredReservations', v_deleted));
end;
$$;

create or replace function public.supasync_rpc(p_op text, p_actor_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = supasync, public
as $$
begin
  if p_actor_id is null and p_op <> 'gc_pass' then
    return supasync.err('AUTH_REQUIRED', 'a verified user is required');
  end if;
  return case p_op
    when 'capabilities' then supasync.capabilities(p_actor_id, p_request)
    when 'list_vaults' then supasync.list_vaults(p_actor_id, p_request)
    when 'create_vault' then supasync.create_vault(p_actor_id, p_request)
    when 'register_client' then supasync.register_client(p_actor_id, p_request)
    when 'begin_snapshot' then supasync.begin_snapshot(p_actor_id, p_request)
    when 'list_snapshot' then supasync.list_snapshot(p_actor_id, p_request)
    when 'get_revisions' then supasync.get_revisions(p_actor_id, p_request)
    when 'get_bodies' then supasync.get_bodies(p_actor_id, p_request)
    when 'pull_changes' then supasync.pull_changes(p_actor_id, p_request)
    when 'commit' then supasync.commit_op(p_actor_id, p_request)
    when 'rename_tree' then supasync.rename_tree(p_actor_id, p_request)
    when 'delete_tree' then supasync.delete_tree(p_actor_id, p_request)
    when 'ack_applied' then supasync.ack_applied(p_actor_id, p_request)
    when 'begin_blob_upload' then supasync.begin_blob_upload(p_actor_id, p_request)
    when 'claim_blob_finalization' then supasync.claim_blob_finalization(p_actor_id, p_request)
    when 'complete_blob_finalization' then supasync.complete_blob_finalization(p_actor_id, p_request)
    when 'get_blob_download' then supasync.get_blob_download(p_actor_id, p_request)
    when 'list_history' then supasync.list_history(p_actor_id, p_request)
    when 'restore_revision' then supasync.commit_op(p_actor_id, p_request)
    when 'create_conflict_copy' then supasync.commit_op(p_actor_id, p_request)
    when 'resolve_conflict' then supasync.commit_op(p_actor_id, p_request)
    when 'start_storage_migration' then supasync.start_storage_migration(p_actor_id, p_request)
    when 'migration_status' then supasync.migration_status(p_actor_id, p_request)
    when 'add_member' then supasync.add_member(p_actor_id, p_request)
    when 'gc_pass' then supasync.gc_pass(p_request)
    else supasync.err('UNAVAILABLE', 'unknown operation', jsonb_build_object('operation', p_op))
  end;
end;
$$;

revoke all on function public.supasync_rpc(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.supasync_rpc(text, uuid, jsonb) to service_role;

drop view if exists public.supasync_notes;
create view public.supasync_notes
with (security_invoker = true) as
select
  e.vault_id,
  e.entry_id,
  e.path,
  e.current_seq::text as revision_id,
  b.body as markdown
from supasync.entries e
join supasync.revisions r on r.vault_id = e.vault_id and r.seq = e.current_seq
join supasync.text_bodies b on b.vault_id = r.vault_id and b.sha256 = r.text_sha256
where e.kind = 'markdown' and e.deleted = false;

grant select on public.supasync_notes to authenticated, service_role;
