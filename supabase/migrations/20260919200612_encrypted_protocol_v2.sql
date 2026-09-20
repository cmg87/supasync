-- Additive cutover: retain existing v1 data for explicit backup/export; never erase it silently.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
-- Existing v1 deployments retain their data, but their plaintext dispatcher is retired.
do $$ begin
 if to_regprocedure('public.supasync_rpc(text,uuid,jsonb)') is not null then
   execute 'revoke all on function public.supasync_rpc(text,uuid,jsonb) from public,anon,authenticated,service_role';
 end if;
end $$;
create schema if not exists supasync_v2;
revoke all on schema supasync_v2 from public, anon, authenticated;
grant usage on schema supasync_v2 to service_role;
create table supasync_v2.metadata (id boolean primary key default true check(id), schema_version integer not null);
insert into supasync_v2.metadata values(true,1);
create table supasync_v2.vaults (
 id uuid primary key, owner_id uuid not null references auth.users(id), label jsonb not null,
 recovery jsonb not null, epoch uuid not null default gen_random_uuid(), head bigint not null default 0,
 created_at timestamptz not null default now()
);
create table supasync_v2.members (
 vault_id uuid references supasync_v2.vaults on delete cascade, user_id uuid references auth.users,
 role text not null check(role in ('owner','editor','reader')), primary key(vault_id,user_id)
);
create table supasync_v2.clients (
 vault_id uuid references supasync_v2.vaults on delete cascade, id uuid, user_id uuid not null references auth.users,
 generation int not null default 1, revoked boolean not null default false, applied bigint not null default 0,
 public_key text, session_id uuid not null, primary key(vault_id,id)
);
create table supasync_v2.objects (
 vault_id uuid references supasync_v2.vaults on delete cascade, id uuid, actor_id uuid not null references auth.users,
 ciphertext_sha256 text not null check(ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
 ciphertext_length bigint not null check(ciphertext_length between 1 and 52428800),
 ready boolean not null default false, primary key(vault_id,id)
);
create table supasync_v2.entries (
 vault_id uuid references supasync_v2.vaults on delete cascade, id uuid, parent_id uuid,
 name_token text not null, kind text not null check(kind in ('markdown','blob','folder')),
 deleted boolean not null default false, seq bigint not null, version int not null, record jsonb not null,
 primary key(vault_id,id), foreign key(vault_id,parent_id) references supasync_v2.entries(vault_id,id)
);
create unique index live_sibling on supasync_v2.entries(vault_id,coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),name_token) where not deleted;
create table supasync_v2.revisions (
 vault_id uuid references supasync_v2.vaults on delete cascade, seq bigint, entry_id uuid not null, record jsonb not null,
 primary key(vault_id,seq)
);
create table supasync_v2.receipts (
 vault_id uuid references supasync_v2.vaults on delete cascade, operation_id uuid, digest text not null, result jsonb not null,
 primary key(vault_id,operation_id)
);
create table supasync_v2.snapshots (
 id uuid primary key default gen_random_uuid(), vault_id uuid references supasync_v2.vaults on delete cascade,
 actor_id uuid not null, head bigint not null, expires_at timestamptz not null default now()+interval '24 hours'
);
create table supasync_v2.snapshot_items (
 snapshot_id uuid references supasync_v2.snapshots on delete cascade, entry_id uuid, record jsonb not null,
 primary key(snapshot_id,entry_id)
);
create table supasync_v2.pairings (
 id uuid primary key, vault_id uuid references supasync_v2.vaults on delete cascade, actor_id uuid not null,
 client_id uuid not null, public_key text not null, envelope jsonb, consumed boolean not null default false,
 expires_at timestamptz not null default now()+interval '10 minutes'
);
do $$ declare t text; begin
 for t in select tablename from pg_tables where schemaname='supasync_v2' loop
 execute format('alter table supasync_v2.%I enable row level security',t);
 execute format('revoke all on supasync_v2.%I from public, anon, authenticated',t);
 execute format('grant all on supasync_v2.%I to service_role',t);
 end loop;
end $$;
create or replace function supasync_v2.valid_cipher(v jsonb) returns boolean language sql immutable as $$
 select coalesce(jsonb_typeof(v)='object' and v->>'cryptoVersion'='1' and v->>'keyVersion'='1'
 and v->>'algorithm'='xchacha20poly1305' and v->>'nonce' ~ '^[A-Za-z0-9_-]{32}$'
 and length(v->>'ciphertext') between 22 and 8192 and v->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
 and not exists(select 1 from jsonb_object_keys(v) k where k not in ('cryptoVersion','keyVersion','algorithm','nonce','ciphertext')),false)
$$;
create or replace function public.supasync_v2_rpc(p_op text,p_actor_id uuid,p_request jsonb,p_session_id uuid)
returns jsonb language plpgsql security invoker set search_path=supasync_v2,public,extensions as $$
declare
 v uuid; c uuid; eid uuid; opid uuid; oid uuid; sid uuid; parent uuid;
 vault supasync_v2.vaults; entry supasync_v2.entries; client supasync_v2.clients; obj supasync_v2.objects;
 receipt supasync_v2.receipts; snap supasync_v2.snapshots; pairing supasync_v2.pairings;
 env jsonb; payload jsonb; result jsonb; rec jsonb; rows jsonb; digest text; role text;
 after_seq bigint; ceiling bigint; lim int; last_seq bigint; mutation text; token text;
begin
 if p_actor_id is null or p_session_id is null then raise exception 'AUTH_REQUIRED'; end if;
 if p_op='list_vaults' then
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name','Encrypted vault','encryptedLabel',a.label,'recoveryEnvelope',a.recovery,
   'protocolVersion',2,'cryptoVersion',1,'keyVersion',1,'serverEpoch',a.epoch,'headSeq',a.head::text,'role',m.role) order by a.created_at),'[]') into rows
  from supasync_v2.vaults a join supasync_v2.members m on m.vault_id=a.id where m.user_id=p_actor_id and not exists(select 1 from supasync_v2.clients c where c.vault_id=a.id and c.session_id=p_session_id and c.revoked);
  return jsonb_build_object('vaults',rows);
 end if;
 if p_op='create_vault' then
  if not supasync_v2.valid_cipher(p_request->'encryptedLabel') or not supasync_v2.valid_cipher(p_request->'recoveryEnvelope') then raise exception 'INVALID_CIPHERTEXT'; end if;
  v:=(p_request->>'vaultId')::uuid;
  insert into supasync_v2.vaults(id,owner_id,label,recovery) values(v,p_actor_id,p_request->'encryptedLabel',p_request->'recoveryEnvelope') on conflict do nothing;
  select * into vault from supasync_v2.vaults where id=v;
  if vault.owner_id<>p_actor_id or vault.label<>p_request->'encryptedLabel' or vault.recovery<>p_request->'recoveryEnvelope' then raise exception 'ID_REUSE'; end if;
  insert into supasync_v2.members values(v,p_actor_id,'owner') on conflict do nothing;
  return jsonb_build_object('vault',jsonb_build_object('id',v,'name','Encrypted vault','encryptedLabel',vault.label,'recoveryEnvelope',vault.recovery,'protocolVersion',2,'serverEpoch',vault.epoch,'headSeq',vault.head::text,'role','owner'));
 end if;
 env:=case when p_op='commit' then p_request->'envelope' else p_request end;
 v:=(env->>'vaultId')::uuid;
 if p_op='list_snapshot' then select vault_id into v from supasync_v2.snapshots where id=(p_request->>'snapshotId')::uuid and actor_id=p_actor_id; end if;
 select m.role into role from supasync_v2.members m where m.vault_id=v and m.user_id=p_actor_id;
 if role is null then raise exception 'PERMISSION_DENIED'; end if;
 if exists(select 1 from supasync_v2.clients where vault_id=v and session_id=p_session_id and revoked) then raise exception 'CLIENT_REVOKED'; end if;
 select * into vault from supasync_v2.vaults where id=v for update;
 if p_op='capabilities' then return jsonb_build_object('protocolVersion',2,'cryptoVersion',1,'keyVersion',1,'serverEpoch',vault.epoch,'vaultId',v,'headSeq',vault.head::text,'namespaceSeq',vault.head::text,'replayFloor','0'); end if;
 if p_op='get_vault_keys' then return jsonb_build_object('recoveryEnvelope',vault.recovery,'encryptedLabel',vault.label); end if;
 if p_op='register_client' then
  c:=(p_request->>'clientId')::uuid;
  insert into supasync_v2.clients(vault_id,id,user_id,public_key,session_id) values(v,c,p_actor_id,p_request->>'publicKey',p_session_id) on conflict do nothing;
  select * into client from supasync_v2.clients where vault_id=v and id=c;
  if client.user_id<>p_actor_id or client.revoked then raise exception 'CLIENT_REVOKED'; end if;
  update supasync_v2.clients set session_id=p_session_id where vault_id=v and id=c;
  return jsonb_build_object('vaultId',v,'clientId',c,'generation',client.generation);
 end if;
 if p_op='list_devices' then
  select coalesce(jsonb_agg(jsonb_build_object('clientId',id,'revoked',revoked,'generation',generation,'publicKey',public_key)),'[]') into rows from supasync_v2.clients where vault_id=v;
  return jsonb_build_object('devices',rows);
 end if;
 if p_op='revoke_device' then
  if role<>'owner' then raise exception 'PERMISSION_DENIED'; end if;
  update supasync_v2.clients set revoked=true,generation=supasync_v2.clients.generation+1 where vault_id=v and id=(p_request->>'targetClientId')::uuid;
  return '{}'::jsonb;
 end if;
 c:=(p_request->>'clientId')::uuid;
 if p_op='commit' then c:=(env->>'clientId')::uuid; end if;
 select * into client from supasync_v2.clients where vault_id=v and id=c and user_id=p_actor_id and session_id=p_session_id and not revoked;
 if not found then raise exception 'CLIENT_REVOKED'; end if;
 if p_op='ack_applied' then
  after_seq:=(p_request->>'appliedSeq')::bigint;
  if after_seq>vault.head or after_seq<0 then raise exception 'INVALID_CURSOR'; end if;
  update supasync_v2.clients set applied=greatest(applied,after_seq) where vault_id=v and id=c;
  return '{}'::jsonb;
 end if;
 if p_op in ('pull_changes','get_tree','list_history') then
  after_seq:=coalesce((p_request->>'afterSeq')::bigint,0); ceiling:=coalesce((p_request->>'ceiling')::bigint,vault.head);
  lim:=greatest(1,least(coalesce((p_request->>'limit')::int,100),100));
  if after_seq<0 or ceiling>vault.head or ceiling<after_seq then raise exception 'INVALID_CURSOR'; end if;
  select coalesce(jsonb_agg(q.record order by q.seq),'[]'),coalesce(max(q.seq),after_seq) into rows,last_seq
  from (select r.* from supasync_v2.revisions r where vault_id=v and seq>after_seq and seq<=ceiling
    and (p_op<>'list_history' or entry_id=(p_request->>'entryId')::uuid) order by seq limit lim) q;
  return jsonb_build_object('revisions',rows,'afterSeq',after_seq::text,'ceiling',ceiling::text,'nextCursor',last_seq::text,'replayFloor','0',
    'exhausted',not exists(select 1 from supasync_v2.revisions where vault_id=v and seq>last_seq and seq<=ceiling and (p_op<>'list_history' or entry_id=(p_request->>'entryId')::uuid)));
 end if;
 if p_op='begin_snapshot' then
  insert into supasync_v2.snapshots(vault_id,actor_id,head) values(v,p_actor_id,vault.head) returning * into snap;
  insert into supasync_v2.snapshot_items select snap.id,id,record from supasync_v2.entries where vault_id=v and not deleted;
  return jsonb_build_object('snapshotId',snap.id,'headSeq',vault.head::text,'serverEpoch',vault.epoch,'expiresAt',snap.expires_at,'itemCount',(select count(*) from supasync_v2.snapshot_items where snapshot_id=snap.id));
 end if;
 if p_op='list_snapshot' then
  select * into snap from supasync_v2.snapshots where id=(p_request->>'snapshotId')::uuid and actor_id=p_actor_id;
  if not found or snap.expires_at<now() then raise exception 'CURSOR_EXPIRED'; end if;
  lim:=greatest(1,least(coalesce((p_request->>'limit')::int,100),100));
  select coalesce(jsonb_agg(jsonb_build_object('entryId',q.entry_id,'revision',q.record) order by q.entry_id),'[]'),(array_agg(q.entry_id order by q.entry_id desc))[1] into rows,eid
  from (select * from supasync_v2.snapshot_items where snapshot_id=snap.id and (p_request->>'afterEntryId' is null or entry_id>(p_request->>'afterEntryId')::uuid) order by entry_id limit lim) q;
  return jsonb_build_object('items',rows,'nextCursor',eid,'exhausted',not exists(select 1 from supasync_v2.snapshot_items where snapshot_id=snap.id and entry_id>eid));
 end if;
 if p_op='get_object' then
  oid:=(p_request->>'objectId')::uuid;
  select * into obj from supasync_v2.objects where vault_id=v and id=oid and ready;
  if not found then raise exception 'BLOB_NOT_READY'; end if;
  return jsonb_build_object('objectId',oid,'ciphertextSha256',obj.ciphertext_sha256,'ciphertextLength',obj.ciphertext_length,'objectKey',v::text||'/'||oid::text);
 end if;
 if role='reader' then raise exception 'PERMISSION_DENIED'; end if;
 if p_op='reserve_object' then
  oid:=(p_request->>'objectId')::uuid;
  insert into supasync_v2.objects(vault_id,id,actor_id,ciphertext_sha256,ciphertext_length) values(v,oid,p_actor_id,p_request->>'ciphertextSha256',(p_request->>'ciphertextLength')::bigint) on conflict do nothing;
  select * into obj from supasync_v2.objects where vault_id=v and id=oid;
  if obj.actor_id<>p_actor_id or obj.ciphertext_sha256<>p_request->>'ciphertextSha256' or obj.ciphertext_length<>(p_request->>'ciphertextLength')::bigint then raise exception 'ID_REUSE'; end if;
  return jsonb_build_object('objectId',oid,'ready',obj.ready,'objectKey',v::text||'/'||oid::text,'ciphertextSha256',obj.ciphertext_sha256,'ciphertextLength',obj.ciphertext_length);
 end if;
 if p_op='verify_object' then
  update supasync_v2.objects set ready=true where vault_id=v and id=(p_request->>'objectId')::uuid and actor_id=p_actor_id
   and ciphertext_sha256=p_request->>'ciphertextSha256' and ciphertext_length=(p_request->>'ciphertextLength')::bigint;
  if not found then raise exception 'HASH_MISMATCH'; end if; return '{}'::jsonb;
 end if;
 if p_op='pair_begin' then
  if p_request->>'publicKey' !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'INVALID_KEY'; end if;
  insert into supasync_v2.pairings(id,vault_id,actor_id,client_id,public_key) values((p_request->>'pairingId')::uuid,v,p_actor_id,c,p_request->>'publicKey');
  return jsonb_build_object('pairingId',p_request->>'pairingId');
 end if;
 if p_op in ('pair_get','pair_approve','pair_consume') then
  select * into pairing from supasync_v2.pairings where id=(p_request->>'pairingId')::uuid and vault_id=v for update;
  if not found or pairing.expires_at<now() or pairing.consumed then raise exception 'PAIRING_EXPIRED'; end if;
  if p_op='pair_approve' then
   if pairing.envelope is not null then raise exception 'ID_REUSE'; end if;
   if not supasync_v2.valid_cipher(p_request->'envelope'->'envelope') then raise exception 'INVALID_CIPHERTEXT'; end if;
   update supasync_v2.pairings set envelope=p_request->'envelope' where id=pairing.id;
  elsif p_op='pair_consume' then
   if pairing.client_id<>c or pairing.envelope is null then raise exception 'PERMISSION_DENIED'; end if;
   update supasync_v2.pairings set consumed=true where id=pairing.id;
  end if;
  return jsonb_build_object('publicKey',pairing.public_key,'clientId',pairing.client_id,'envelope',pairing.envelope);
 end if;
 if p_op<>'commit' then raise exception 'UNSUPPORTED_OPERATION'; end if;
 if env->>'protocolVersion'<>'2' or env->>'cryptoVersion'<>'1' then raise exception 'PROTOCOL_UPGRADE_REQUIRED'; end if;
 if (env->>'serverEpoch')::uuid<>vault.epoch then raise exception 'EPOCH_MISMATCH'; end if;
 if (env->>'clientGeneration')::int<>client.generation then raise exception 'CLIENT_GENERATION_EXPIRED'; end if;
 opid:=(env->>'operationId')::uuid; eid:=(env->>'entryId')::uuid; mutation:=env->>'type'; payload:=env->'payload';
 digest:=encode(extensions.digest(convert_to(env::text,'UTF8'),'sha256'),'hex');
 select * into receipt from supasync_v2.receipts where vault_id=v and operation_id=opid;
 if found then if receipt.digest<>digest then raise exception 'ID_REUSE'; end if; return receipt.result; end if;
 select * into entry from supasync_v2.entries where vault_id=v and id=eid;
 if mutation='create' and entry.id is not null then raise exception 'ID_REUSE'; end if;
 if mutation<>'create' and (entry.id is null or entry.seq<>coalesce((env->>'baseRevisionId')::bigint,-1)) then
  result:=jsonb_build_object('outcome','conflict','operationId',opid,'current',entry.record,'message','BASE_CONFLICT');
 else
  if mutation not in ('create','update','delete','rename','restore_revision') then raise exception 'UNSUPPORTED_OPERATION'; end if;
  if mutation='delete' then
   if payload<>'{}'::jsonb then raise exception 'INVALID_CIPHERTEXT'; end if;
   if exists(select 1 from supasync_v2.entries where vault_id=v and parent_id=eid and not deleted) then raise exception 'FOLDER_NOT_EMPTY'; end if;
   payload:=entry.record - array['vaultId','entryId','seq','parentSeq','version','tombstone','operationId','clientId','actorId','serverTime'];
  end if;
  if not supasync_v2.valid_cipher(payload->'encryptedName') or payload->>'nameToken' !~ '^[A-Za-z0-9_-]{43}$' or payload->>'keyVersion'<>'1'
   or payload->>'kind' not in ('markdown','blob','folder') or exists(select 1 from jsonb_object_keys(payload) k where k not in ('parentEntryId','encryptedName','nameToken','nameObjectId','kind','objectId','keyVersion')) then raise exception 'INVALID_CIPHERTEXT'; end if;
  parent:=(payload->>'parentEntryId')::uuid; oid:=(payload->>'objectId')::uuid;
  if parent is not null and not exists(select 1 from supasync_v2.entries where vault_id=v and id=parent and kind='folder' and not deleted) then raise exception 'INVALID_PARENT'; end if;
  if parent=eid or exists(with recursive ancestors as (select id,parent_id from supasync_v2.entries where vault_id=v and id=parent union all select e.id,e.parent_id from supasync_v2.entries e join ancestors a on e.id=a.parent_id where e.vault_id=v) select 1 from ancestors where id=eid) then raise exception 'INVALID_PARENT'; end if;
  if mutation<>'delete' and payload->>'kind'<>'folder' and not exists(select 1 from supasync_v2.objects where vault_id=v and id=oid and ready) then raise exception 'BLOB_NOT_READY'; end if;
  if mutation<>'delete' and exists(select 1 from supasync_v2.entries where vault_id=v and parent_id is not distinct from parent and name_token=payload->>'nameToken' and not deleted and id<>eid) then
   result:=jsonb_build_object('outcome','conflict','operationId',opid,'message','PATH_COLLISION');
  else
   vault.head:=vault.head+1;
   rec:=payload||jsonb_build_object('vaultId',v,'entryId',eid,'seq',vault.head::text,'parentSeq',entry.seq::text,'version',coalesce(entry.version,0)+1,
    'tombstone',mutation='delete','operationId',opid,'clientId',c,'actorId',p_actor_id,'serverTime',now());
   insert into supasync_v2.entries values(v,eid,parent,payload->>'nameToken',payload->>'kind',mutation='delete',vault.head,coalesce(entry.version,0)+1,rec)
    on conflict(vault_id,id) do update set parent_id=excluded.parent_id,name_token=excluded.name_token,kind=excluded.kind,deleted=excluded.deleted,seq=excluded.seq,version=excluded.version,record=excluded.record;
   insert into supasync_v2.revisions values(v,vault.head,eid,rec);
   update supasync_v2.vaults set head=vault.head where id=v;
   result:=jsonb_build_object('outcome','accepted','operationId',opid,'revision',rec);
  end if;
 end if;
 insert into supasync_v2.receipts values(v,opid,digest,result);
 return result;
end $$;
revoke all on function public.supasync_v2_rpc(text,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.supasync_v2_rpc(text,uuid,jsonb,uuid) to service_role;
revoke all on function supasync_v2.valid_cipher(jsonb) from public,anon,authenticated;
grant execute on function supasync_v2.valid_cipher(jsonb) to service_role;
insert into storage.buckets(id,name,public,file_size_limit) values('supasync-ciphertext','supasync-ciphertext',false,52428800) on conflict(id) do nothing;
