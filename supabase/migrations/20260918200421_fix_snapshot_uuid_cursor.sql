set check_function_bodies = off;

CREATE OR REPLACE FUNCTION supasync.list_snapshot(p_actor uuid, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'supasync', 'public'
AS $function$
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
         (array_agg(i.entry_id order by i.entry_id desc))[1]
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
$function$
;


