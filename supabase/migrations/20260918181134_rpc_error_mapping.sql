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
exception
  when others then
    if sqlerrm in (
      'PERMISSION_DENIED', 'NOT_FOUND', 'CLIENT_GENERATION_EXPIRED', 'EPOCH_MISMATCH',
      'BLOB_NOT_READY', 'HASH_MISMATCH', 'INVALID_TEXT', 'INVALID_PATH', 'STALE_NAMESPACE',
      'CURSOR_EXPIRED', 'LIMIT_EXCEEDED'
    ) then
      return supasync.err(sqlerrm, sqlerrm);
    end if;
    raise;
end;
$$;

revoke all on function public.supasync_rpc(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.supasync_rpc(text, uuid, jsonb) to service_role;
