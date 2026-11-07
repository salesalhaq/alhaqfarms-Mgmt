begin;

do $migration$
declare
  v_definition text;
  v_old constant text := $old$upper(encode(gen_random_bytes(3), 'hex'))$old$;
  v_new constant text := $new$upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))$new$;
begin
  select pg_get_functiondef('public.staff_manage_return(text, jsonb)'::regprocedure)
  into v_definition;

  if strpos(v_definition, v_old) > 0 then
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  elsif strpos(v_definition, v_new) = 0 then
    raise exception 'Could not verify or update the return-number generator.';
  end if;
end;
$migration$;

commit;
