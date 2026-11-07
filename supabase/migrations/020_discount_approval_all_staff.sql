begin;

do $migration$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  select pg_get_functiondef('public.staff_complete_pos_sale(jsonb)'::regprocedure)
  into v_definition;
  v_anchor := $anchor$if v_staff.role = 'cashier' and v_bill_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000)$anchor$;
  if strpos(v_definition, v_anchor) > 0 then
    v_definition := replace(v_definition, v_anchor, $replacement$if v_bill_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000)$replacement$);
  elsif strpos(v_definition, $already$if v_bill_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000)$already$) = 0 then
    raise exception 'Could not locate POS checkout discount validation for all-staff approval.';
  end if;
  execute v_definition;

  select pg_get_functiondef('public.staff_manage_pos_held_sale(text, jsonb)'::regprocedure)
  into v_definition;
  v_anchor := $anchor$if v_staff.role = 'cashier' and v_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000)$anchor$;
  if strpos(v_definition, v_anchor) > 0 then
    v_definition := replace(v_definition, v_anchor, $replacement$if v_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000)$replacement$);
  elsif strpos(v_definition, $already$if v_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000)$already$) = 0 then
    raise exception 'Could not locate held-sale discount validation for all-staff approval.';
  end if;
  execute v_definition;

  select pg_get_functiondef('public.staff_manage_pos_discount(text, jsonb)'::regprocedure)
  into v_definition;

  v_anchor := $anchor$if v_staff.role <> 'cashier' then
      raise exception 'Only cashiers need a manager discount approval request.';
    end if;$anchor$;
  if strpos(v_definition, v_anchor) > 0 then
    v_replacement := $replacement$if v_staff.role not in ('cashier', 'manager', 'admin') then
      raise exception 'Your role cannot request a POS discount approval.';
    end if;$replacement$;
    v_definition := replace(v_definition, v_anchor, v_replacement);
  elsif strpos(v_definition, 'Your role cannot request a POS discount approval.') = 0 then
    raise exception 'Could not locate POS discount request role validation.';
  end if;

  v_anchor := $anchor$'cashierName', coalesce(cashier.full_name, 'Cashier'),$anchor$;
  if strpos(v_definition, v_anchor) > 0 then
    v_definition := replace(v_definition, v_anchor, v_anchor || E'\n      ''canReview'', request.cashier_id is distinct from v_staff.local_staff_id,');
  elsif strpos(v_definition, '''canReview'', request.cashier_id is distinct from v_staff.local_staff_id,') = 0 then
    raise exception 'Could not locate POS discount request details for reviewer safeguards.';
  end if;

  v_anchor := $anchor$v_status := case when p_action = 'approve' then 'approved' else 'declined' end;$anchor$;
  if strpos(v_definition, 'Another staff member must approve your discount request.') = 0 then
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS discount approval review validation.';
    end if;
    v_replacement := $replacement$if p_action = 'approve' and exists (
      select 1 from public.pos_discount_approvals request
      where request.id = v_request_id
        and request.branch_id = v_branch_id
        and request.cashier_id = v_staff.local_staff_id
        and request.status = 'pending'
        and request.expires_at > v_now
    ) then
      raise exception 'Another staff member must approve your discount request.';
    end if;
    $replacement$ || v_anchor;
    v_definition := replace(v_definition, v_anchor, v_replacement);
  end if;

  execute v_definition;
end;
$migration$;

commit;
