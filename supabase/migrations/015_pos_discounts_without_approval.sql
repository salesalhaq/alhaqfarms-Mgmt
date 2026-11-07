begin;

do $migration$
declare
  v_definition text;
  v_start integer;
  v_end integer;
  v_checkout_start constant text := '  if v_staff.role = ''cashier'' and v_bill_discount > least(';
  v_checkout_end constant text := '  if coalesce(p_payload->>''loyaltyPointsRedeemed'', ''0'')';
  v_held_start constant text := '    if v_staff.role = ''cashier'' and v_discount > least(';
  v_held_end constant text := '    if coalesce(p_payload->>''loyaltyPointsRedeemed'', ''0'')';
begin
  select pg_get_functiondef('public.staff_complete_pos_sale(jsonb)'::regprocedure)
  into v_definition;
  v_start := strpos(v_definition, v_checkout_start);
  if v_start > 0 then
    v_end := strpos(v_definition, v_checkout_end);
    if v_end <= v_start then
      raise exception 'Could not locate the end of the POS checkout discount approval gate.';
    end if;
    v_definition := substr(v_definition, 1, v_start - 1) || substr(v_definition, v_end);
    execute v_definition;
  elsif strpos(v_definition, 'if v_bill_discount > v_subtotal then') = 0 then
    raise exception 'POS checkout function is missing its discount subtotal validation.';
  end if;

  select pg_get_functiondef('public.staff_manage_pos_held_sale(text, jsonb)'::regprocedure)
  into v_definition;
  v_start := strpos(v_definition, v_held_start);
  if v_start > 0 then
    v_end := strpos(v_definition, v_held_end);
    if v_end <= v_start then
      raise exception 'Could not locate the end of the held-sale discount approval gate.';
    end if;
    v_definition := substr(v_definition, 1, v_start - 1) || substr(v_definition, v_end);
    execute v_definition;
  elsif strpos(v_definition, 'if v_discount > v_subtotal then') = 0 then
    raise exception 'Held-sale function is missing its discount subtotal validation.';
  end if;
end;
$migration$;

commit;
