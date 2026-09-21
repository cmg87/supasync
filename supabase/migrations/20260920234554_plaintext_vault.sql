-- Protocol 3: one trusted installation. All application writes are journaled.
create schema if not exists supasync;
create schema supasync_private;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
revoke all on schema supasync, supasync_private from public, anon;
do $$ begin
 if not exists(select from pg_roles where rolname='supasync_hermes') then
  create role supasync_hermes nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
 end if;
end $$;

create table supasync.settings (
 id boolean primary key default true check(id),
 protocol_version int not null default 3 check(protocol_version=3),
 epoch uuid not null default gen_random_uuid(),
 admin_uid uuid references auth.users(id),
 head bigint not null default 0
);
insert into supasync.settings(id) values(true);
create table supasync.vaults (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 200),
 created_at timestamptz not null default now()
);
create table supasync.blobs (
 id uuid primary key, vault_id uuid not null references supasync.vaults,
 storage_key text not null unique, sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 byte_length bigint not null check(byte_length between 0 and 26214400), ready boolean not null default false,
 created_at timestamptz not null default now(), unique(vault_id,id)
);
create table supasync_private.transfers (
 blob_id uuid primary key references supasync.blobs, token_hash text not null,
 expires_at timestamptz not null default now()+interval '30 minutes'
);
create table supasync.files (
 id uuid primary key, vault_id uuid not null references supasync.vaults,
 path text not null, path_key text not null,
 kind text not null check(kind in ('text','binary','folder')),
 content text, blob_id uuid, storage_key text, content_hash text,
 revision bigint not null default 0, seq bigint not null default 0,
 deleted boolean not null default false,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(vault_id,blob_id) references supasync.blobs(vault_id,id),
 check((kind='text' and content is not null and blob_id is null) or
       (kind='binary' and content is null and blob_id is not null) or
       (kind='folder' and content is null and blob_id is null))
);
create unique index files_live_path on supasync.files(vault_id,path_key) where not deleted;
create index files_search on supasync.files using gin(to_tsvector('simple',coalesce(content,''))) where not deleted and kind='text';
create table supasync.revisions (
 seq bigint primary key, vault_id uuid not null references supasync.vaults,
 file_id uuid not null, revision bigint not null, operation text not null,
 operation_id uuid not null, state jsonb not null, created_at timestamptz not null default now(),
 unique(file_id,revision)
);
create index revisions_vault_seq on supasync.revisions(vault_id,seq);
create index revisions_file_seq on supasync.revisions(vault_id,file_id,seq desc);
create index revisions_body_hash on supasync.revisions(vault_id,(state->>'textSha256')) where state->>'kind'='markdown';
create table supasync.mutation_receipts (
 operation_id uuid primary key, vault_id uuid not null references supasync.vaults,
 digest text not null, result jsonb not null, created_at timestamptz not null default now()
);
create view supasync.changes with (security_invoker=true) as
 select seq,vault_id,file_id,revision,operation,created_at from supasync.revisions;

create function supasync_private.authorized() returns boolean
language sql stable security definer set search_path='' as $$
 select session_user='supasync_hermes' or current_setting('role',true)='supasync_hermes'
 or (auth.uid() is not null and auth.uid()=(select admin_uid from supasync.settings where id))
$$;
create function supasync_private.require_admin() returns void
language plpgsql security definer set search_path='' as $$
begin
 if not supasync_private.authorized() then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
end $$;
create function supasync_private.path_key(p text) returns text
language plpgsql immutable set search_path='' as $$
declare c text; n text; result text[]:=array[]::text[];
begin
 if p is null or p='' or p like '/%' or position(chr(92) in p)>0 or p ~ '[[:cntrl:]:*?"<>|]' or octet_length(p)>1024 then raise exception 'INVALID_PATH'; end if;
 foreach c in array string_to_array(rtrim(p,'/'),'/') loop
  n:=normalize(c,NFC);
  if n in ('','.','..') or right(n,1) in (' ','.') or octet_length(n)>255
   or lower(split_part(n,'.',1)) ~ '^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)$' then raise exception 'INVALID_PATH'; end if;
  result:=array_append(result,replace(replace(lower(replace(n,'İ',U&'i\0307')),'ß','ss'),'ς','σ'));
 end loop;
 return array_to_string(result,'/');
end $$;
create function supasync_private.record(f supasync.files, req jsonb) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('vaultId',f.vault_id,'entryId',f.id,'path',f.path,'pathKey',f.path_key,
 'kind',case f.kind when 'text' then 'markdown' when 'binary' then 'blob' else 'folder' end,
 'seq',f.seq::text,'revision',f.revision::text,'version',f.revision,'parentSeq',null,
 'textSha256',f.content_hash,'blobId',f.blob_id,'tombstone',f.deleted,
 'operationId',req->>'operationId','clientId',coalesce(req->>'clientId','sql'),
 'serverTime',f.updated_at,'conflictOf',req->'payload'->>'conflict_of',
 'conflictOperationId',req->'payload'->>'conflict_operation_id','content',f.content)
$$;
create function supasync_private.propose(old supasync.files, req jsonb) returns supasync.files
language plpgsql set search_path='' as $$
declare f supasync.files:=old; p jsonb:=req->'payload'; op text:=req->>'type';
begin
 if old.id is null then
  f.id:=(req->>'entryId')::uuid; f.vault_id:=(req->>'vaultId')::uuid;
  f.kind:=case p->>'kind' when 'markdown' then 'text' when 'blob' then 'binary' else p->>'kind' end;
  f.kind:=coalesce(f.kind,'text'); f.deleted:=false; f.revision:=0; f.seq:=0;
  f.created_at:=now();
 end if;
 if p ? 'path' then f.path:=normalize(rtrim(p->>'path','/'),NFC); end if;
 if p ? 'text' then f.content:=p->>'text'; f.kind:='text'; f.blob_id:=null; end if;
 if p ? 'blob_id' then f.blob_id:=(p->>'blob_id')::uuid; f.kind:='binary'; f.content:=null; end if;
 if op='delete' then f.deleted:=true; end if;
 if op='restore_revision' then f.deleted:=false; end if;
 f.path_key:=supasync_private.path_key(f.path);
 return f;
end $$;

-- Must run before the executor locks any file rows. The lock lasts through commit.
create function supasync_private.write_lock() returns trigger language plpgsql set search_path='' as $$
begin perform pg_advisory_xact_lock(1937076321,3); return null; end $$;
create trigger files_write_lock before insert or update or delete on supasync.files
for each statement execute function supasync_private.write_lock();

create function supasync.prepare_mutation(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f supasync.files; r supasync.mutation_receipts; d text; result jsonb; v uuid; op text;
begin
 perform supasync_private.require_admin();
 perform pg_advisory_xact_lock(1937076321,3);
 perform set_config('supasync.request','',true);
 if p_request->>'protocolVersion' is distinct from '3' then raise exception 'PROTOCOL_UPGRADE_REQUIRED'; end if;
 if (p_request->>'serverEpoch')::uuid is distinct from (select epoch from supasync.settings where id) then raise exception 'EPOCH_MISMATCH'; end if;
 if p_request->>'operationId' is null or p_request->>'entryId' is null or p_request->>'vaultId' is null or jsonb_typeof(p_request->'payload') is distinct from 'object' then raise exception 'INVALID_REQUEST'; end if;
 v:=(p_request->>'vaultId')::uuid; op:=p_request->>'type';
 if op is null or op not in ('create','update','rename','delete','restore_revision') then raise exception 'UNSUPPORTED_OPERATION'; end if;
 d:=encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex');
 select * into r from supasync.mutation_receipts where operation_id=(p_request->>'operationId')::uuid;
 if found then
  if r.digest<>d then raise exception 'ID_REUSE'; end if;
  return r.result;
 end if;
 select * into f from supasync.files where id=(p_request->>'entryId')::uuid;
 if f.id is not null and f.vault_id<>v then raise exception 'INVALID_REQUEST'; end if;
 if (op='create' and f.id is not null) or (op<>'create' and (f.id is null or f.revision is distinct from (p_request->>'baseRevisionId')::bigint)) then
  result:=jsonb_build_object('outcome','conflict','operationId',p_request->>'operationId','message','BASE_CONFLICT',
    'current',case when f.id is null then null else supasync_private.record(f,p_request) end);
  insert into supasync.mutation_receipts(operation_id,vault_id,digest,result) values((p_request->>'operationId')::uuid,v,d,result);
  return result;
 end if;
 if f.deleted and op not in ('restore_revision','delete') then raise exception 'ENTRY_DELETED'; end if;
 perform set_config('supasync.request',p_request::text,true);
 return jsonb_build_object('outcome','ready');
end $$;

create function supasync_private.guard_file() returns trigger
language plpgsql security definer set search_path='' as $$
declare req jsonb; expected supasync.files; oldfile supasync.files; b supasync.blobs;
begin
 perform supasync_private.require_admin();
 if tg_op='DELETE' then raise exception 'USE_TOMBSTONE'; end if;
 req:=nullif(current_setting('supasync.request',true),'')::jsonb;
 if req is null or new.id is distinct from (req->>'entryId')::uuid or new.vault_id is distinct from (req->>'vaultId')::uuid then raise exception 'MUTATION_CONTEXT_REQUIRED'; end if;
 if supasync.prepare_mutation(req)->>'outcome'<>'ready' then raise exception 'MUTATION_NOT_READY'; end if;
 if tg_op='UPDATE' then oldfile:=old; end if;
 if tg_op='UPDATE' and old.revision is distinct from (req->>'baseRevisionId')::bigint then raise exception 'BASE_CONFLICT'; end if;
 if (tg_op='INSERT')<>(req->>'type'='create') then raise exception 'INVALID_REQUEST'; end if;
 expected:=supasync_private.propose(oldfile,req);
 if oldfile.kind='folder' and (expected.path<>oldfile.path or expected.deleted) and exists(select from supasync.files where vault_id=oldfile.vault_id and not deleted and starts_with(path,oldfile.path||'/')) then raise exception 'USE_TREE_MUTATION'; end if;
 if (new.path,new.kind,new.content,new.blob_id,new.deleted) is distinct from
    (expected.path,expected.kind,expected.content,expected.blob_id,expected.deleted) then raise exception 'MUTATION_MISMATCH'; end if;
 new:=expected;
 if new.kind='text' then
  if octet_length(new.content)>2097152 then raise exception 'LIMIT_EXCEEDED'; end if;
  new.content_hash:=encode(extensions.digest(convert_to(new.content,'UTF8'),'sha256'),'hex'); new.storage_key:=null;
 elsif new.kind='binary' then
  select * into b from supasync.blobs where id=new.blob_id and vault_id=new.vault_id and ready;
  if not found then raise exception 'BLOB_NOT_READY'; end if;
  new.content_hash:=b.sha256; new.storage_key:=b.storage_key;
 else new.content_hash:=null; new.storage_key:=null;
 end if;
 if exists(select from supasync.files x where x.vault_id=new.vault_id and not x.deleted and x.id<>new.id
   and (x.path_key=new.path_key or (starts_with(new.path_key,x.path_key||'/') and x.kind<>'folder')
   or (starts_with(x.path_key,new.path_key||'/') and new.kind<>'folder'))) then raise exception 'PATH_COLLISION'; end if;
 new.revision:=coalesce(oldfile.revision,0)+1;
 update supasync.settings set head=head+1 where id returning head into new.seq;
 new.updated_at:=now();
 return new;
end $$;
create trigger files_guard before insert or update or delete on supasync.files for each row execute function supasync_private.guard_file();
create function supasync_private.journal_file() returns trigger
language plpgsql security definer set search_path='' as $$
declare req jsonb:=current_setting('supasync.request')::jsonb; rec jsonb; result jsonb;
begin
 rec:=supasync_private.record(new,req);
 insert into supasync.revisions(seq,vault_id,file_id,revision,operation,operation_id,state)
 values(new.seq,new.vault_id,new.id,new.revision,req->>'type',(req->>'operationId')::uuid,rec);
 result:=jsonb_build_object('outcome','accepted','operationId',req->>'operationId','revision',rec);
 insert into supasync.mutation_receipts(operation_id,vault_id,digest,result)
 values((req->>'operationId')::uuid,new.vault_id,encode(extensions.digest(convert_to(req::text,'UTF8'),'sha256'),'hex'),result);
 perform set_config('supasync.request','',true);
 return null;
end $$;
create trigger files_journal after insert or update on supasync.files for each row execute function supasync_private.journal_file();

create function supasync.mutate(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; oldfile supasync.files; f supasync.files; child supasync.files; tree jsonb; childreq jsonb; oldpath text;
begin
 result:=supasync.prepare_mutation(p_request);
 if result->>'outcome'<>'ready' then return result; end if;
 select * into oldfile from supasync.files where id=(p_request->>'entryId')::uuid;
 f:=supasync_private.propose(oldfile,p_request);
 if oldfile.kind='folder' and p_request->>'type' in ('rename','delete') then
  select coalesce(jsonb_object_agg(id::text,revision::text),'{}') into tree from supasync.files
   where vault_id=oldfile.vault_id and not deleted and (id=oldfile.id or starts_with(path,oldfile.path||'/'));
  if tree is distinct from p_request->'payload'->'treeBase' then
   result:=jsonb_build_object('outcome','conflict','operationId',p_request->>'operationId','message','TREE_CONFLICT','current',supasync_private.record(oldfile,p_request));
   insert into supasync.mutation_receipts(operation_id,vault_id,digest,result) values((p_request->>'operationId')::uuid,oldfile.vault_id,encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex'),result);
   perform set_config('supasync.request','',true); return result;
  end if;
  if p_request->>'type'='rename' and starts_with(f.path,oldfile.path||'/') then raise exception 'INVALID_PATH'; end if;
  -- Children first: deletion never removes a parent with live children; immutable IDs survive moves.
  for child in select * from supasync.files where vault_id=oldfile.vault_id and not deleted and starts_with(path,oldfile.path||'/') order by length(path) desc loop
   childreq:=p_request||jsonb_build_object('operationId',md5((p_request->>'operationId')||child.id::text)::uuid,'entryId',child.id,'baseRevisionId',child.revision::text,
    'payload',case when p_request->>'type'='rename' then jsonb_build_object('path',f.path||substr(child.path,length(oldfile.path)+1)) else '{}'::jsonb end);
   -- Descendant folders have already had their children handled by this loop.
   if child.kind='folder' then
    childreq:=jsonb_set(childreq,'{payload,treeBase}',coalesce((select jsonb_object_agg(id::text,revision::text) from supasync.files where vault_id=child.vault_id and not deleted and (id=child.id or starts_with(path,child.path||'/'))),'{}'));
   end if;
   result:=supasync.mutate(childreq);
   if result->>'outcome'<>'accepted' then raise exception 'TREE_CONFLICT'; end if;
  end loop;
  perform set_config('supasync.request',p_request::text,true);
 end if;
 begin
  if oldfile.id is null then insert into supasync.files select f.*;
  else update supasync.files set path=f.path,kind=f.kind,content=f.content,blob_id=f.blob_id,deleted=f.deleted where id=f.id; end if;
 exception when unique_violation then raise exception 'PATH_COLLISION'; end;
 select r.result into result from supasync.mutation_receipts r where operation_id=(p_request->>'operationId')::uuid;
 return result;
exception when raise_exception then
 if sqlerrm<>'PATH_COLLISION' then raise; end if;
 -- The exception rolls back the complete tree mutation, not just the final row.
 select * into oldfile from supasync.files where vault_id=(p_request->>'vaultId')::uuid and path_key=supasync_private.path_key(p_request->'payload'->>'path') and not deleted;
 result:=jsonb_build_object('outcome','conflict','operationId',p_request->>'operationId','message','PATH_COLLISION','current',case when oldfile.id is null then null else supasync_private.record(oldfile,p_request) end);
 insert into supasync.mutation_receipts(operation_id,vault_id,digest,result) values((p_request->>'operationId')::uuid,(p_request->>'vaultId')::uuid,encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex'),result);
 return result;
end $$;

create function supasync.capabilities(p_vault_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s supasync.settings;
begin perform supasync_private.require_admin(); select * into s from supasync.settings where id;
 return jsonb_build_object('protocolVersion',3,'serverEpoch',s.epoch,'headSeq',s.head::text,'namespaceSeq',s.head::text,'replayFloor','0'); end $$;
create function supasync.list_vaults() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform supasync_private.require_admin(); return jsonb_build_object('vaults',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by created_at,id) from supasync.vaults),'[]')); end $$;
create function supasync.create_vault(p_id uuid,p_name text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v supasync.vaults;
begin perform supasync_private.require_admin(); insert into supasync.vaults(id,name) values(p_id,p_name) on conflict do nothing;
 select * into v from supasync.vaults where id=p_id; if v.name<>p_name then raise exception 'ID_REUSE'; end if;
 return jsonb_build_object('vault',jsonb_build_object('id',v.id,'name',v.name)); end $$;
create function supasync.pull_changes(p_vault_id uuid,p_after text,p_ceiling text default null,p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare ceiling bigint; rows jsonb; nextseq bigint; more boolean;
begin
 perform supasync_private.require_admin();
 select coalesce(p_ceiling::bigint,head) into ceiling from supasync.settings where id;
 if p_after::bigint<0 or ceiling<p_after::bigint or ceiling>(select head from supasync.settings where id) then raise exception 'INVALID_CURSOR'; end if;
 select coalesce(jsonb_agg(state order by seq),'[]'),coalesce(max(seq),p_after::bigint) into rows,nextseq
 from (select state,seq from supasync.revisions where vault_id=p_vault_id and seq>p_after::bigint and seq<=ceiling order by seq limit greatest(1,least(p_limit,100))) q;
 select exists(select from supasync.revisions where vault_id=p_vault_id and seq>nextseq and seq<=ceiling) into more;
 return jsonb_build_object('revisions',rows,'afterSeq',p_after,'ceiling',ceiling::text,'nextCursor',(case when more then nextseq else ceiling end)::text,'exhausted',not more,'replayFloor','0');
end $$;
create function supasync.snapshot(p_vault_id uuid,p_ceiling text,p_after uuid default null,p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; lastid uuid; more boolean;
begin
 perform supasync_private.require_admin();
 if p_ceiling::bigint<0 or p_ceiling::bigint>(select head from supasync.settings where id) then raise exception 'INVALID_CURSOR'; end if;
 with latest as (select distinct on(file_id) file_id,state from supasync.revisions where vault_id=p_vault_id and seq<=p_ceiling::bigint order by file_id,seq desc),
 page as (select * from latest where not (state->>'tombstone')::boolean and (p_after is null or file_id>p_after) order by file_id limit greatest(1,least(p_limit,100)))
 select coalesce(jsonb_agg(jsonb_build_object('entryId',file_id,'revision',state) order by file_id),'[]'),(array_agg(file_id order by file_id desc))[1] into rows,lastid from page;
 with latest as (select distinct on(file_id) file_id,state from supasync.revisions where vault_id=p_vault_id and seq<=p_ceiling::bigint order by file_id,seq desc)
 select exists(select from latest where file_id>lastid and not (state->>'tombstone')::boolean) into more;
 return jsonb_build_object('items',rows,'nextCursor',lastid,'exhausted',not more);
end $$;
create function supasync.get_bodies(p_vault_id uuid,p_hashes text[]) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform supasync_private.require_admin(); return jsonb_build_object('bodies',coalesce((select jsonb_agg(jsonb_build_object('sha256',sha,'text',content,'byteLength',octet_length(content))) from
 (select distinct on(state->>'textSha256') state->>'textSha256' sha,state->>'content' content from supasync.revisions where vault_id=p_vault_id and state->>'kind'='markdown' and state->>'textSha256'=any(p_hashes)) q),'[]')); end $$;
create function supasync.history(p_vault_id uuid,p_file_id uuid,p_after text default '0',p_limit int default 100) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform supasync_private.require_admin(); return coalesce((select jsonb_agg(state order by seq) from (select seq,state from supasync.revisions where vault_id=p_vault_id and file_id=p_file_id and seq>p_after::bigint order by seq limit greatest(1,least(p_limit,100))) q),'[]'); end $$;
create function supasync.search(p_vault_id uuid,p_query text,p_limit int default 50) returns setof supasync.files language plpgsql stable security definer set search_path='' as $$
begin perform supasync_private.require_admin(); return query select * from supasync.files where vault_id=p_vault_id and not deleted and kind='text' and to_tsvector('simple',content) @@ plainto_tsquery('simple',p_query) order by path limit greatest(1,least(p_limit,100)); end $$;

create function supasync.reserve_blob(p_id uuid,p_vault_id uuid,p_sha256 text,p_length bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b supasync.blobs; token text:=encode(extensions.gen_random_bytes(32),'hex');
begin
 perform supasync_private.require_admin();
 insert into supasync.blobs(id,vault_id,storage_key,sha256,byte_length) values(p_id,p_vault_id,p_vault_id::text||'/'||p_id::text,p_sha256,p_length) on conflict do nothing;
 select * into b from supasync.blobs where id=p_id;
 if b.vault_id<>p_vault_id or b.sha256<>p_sha256 or b.byte_length<>p_length then raise exception 'ID_REUSE'; end if;
 insert into supasync_private.transfers(blob_id,token_hash) values(p_id,encode(extensions.digest(token,'sha256'),'hex'))
 on conflict(blob_id) do update set token_hash=excluded.token_hash,expires_at=now()+interval '30 minutes';
 return to_jsonb(b)||jsonb_build_object('token',token);
end $$;
-- Only the binary Edge Function's server credential can call these two helpers.
create function public.supasync_transfer(p_id uuid,p_token text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not exists(select from supasync_private.transfers where blob_id=p_id and expires_at>now() and token_hash=encode(extensions.digest(p_token,'sha256'),'hex')) then raise exception 'PERMISSION_DENIED'; end if;
 return (select to_jsonb(b) from supasync.blobs b where id=p_id);
end $$;
create function public.supasync_ready_blob(p_id uuid,p_sha256 text,p_length bigint) returns void language plpgsql security definer set search_path='' as $$
begin update supasync.blobs set ready=true where id=p_id and sha256=p_sha256 and byte_length=p_length; if not found then raise exception 'HASH_MISMATCH'; end if; end $$;
revoke all on function public.supasync_transfer(uuid,text),public.supasync_ready_blob(uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.supasync_transfer(uuid,text),public.supasync_ready_blob(uuid,text,bigint) to service_role;

do $$ declare t text; begin
 for t in select tablename from pg_tables where schemaname='supasync' loop
  execute format('alter table supasync.%I enable row level security',t);
  execute format('create policy admin_read on supasync.%I for select to authenticated,supasync_hermes using ((select supasync_private.authorized()))',t);
 end loop;
end $$;
create policy guarded_insert on supasync.files for insert to supasync_hermes with check((select supasync_private.authorized()));
create policy guarded_update on supasync.files for update to supasync_hermes using((select supasync_private.authorized())) with check((select supasync_private.authorized()));
grant usage on schema supasync,supasync_private to authenticated,supasync_hermes;
revoke all on all functions in schema supasync_private,supasync from public,anon;
grant execute on function supasync_private.authorized() to authenticated,supasync_hermes;
grant execute on function supasync_private.path_key(text) to supasync_hermes;
grant select on supasync.vaults,supasync.files,supasync.revisions,supasync.changes,supasync.blobs,supasync.mutation_receipts to authenticated,supasync_hermes;
grant insert(id,vault_id,path,path_key,kind,content,blob_id,deleted),update(path,kind,content,blob_id,deleted) on supasync.files to supasync_hermes;
grant execute on all functions in schema supasync to authenticated,supasync_hermes;
alter default privileges in schema supasync revoke execute on functions from public;
alter default privileges in schema supasync_private revoke execute on functions from public;
insert into storage.buckets(id,name,public,file_size_limit) values('supasync-blobs','supasync-blobs',false,26214400) on conflict(id) do nothing;
create policy supasync_binary_read on storage.objects for select to authenticated using(bucket_id='supasync-blobs' and (select supasync_private.authorized()));
notify pgrst,'reload schema';
