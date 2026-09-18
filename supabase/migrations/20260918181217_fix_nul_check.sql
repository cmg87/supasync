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
