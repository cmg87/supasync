-- Keep protocol 3 paths writable on every Obsidian-supported filesystem.
create or replace function supasync_private.path_key(p text) returns text
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
