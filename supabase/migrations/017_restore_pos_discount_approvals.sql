begin;

do $migration$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  select pg_get_functiondef('public.staff_complete_pos_sale(jsonb)'::regprocedure)
  into v_definition;

  if strpos(v_definition, 'v_discount_approval_id uuid') = 0 then
    v_anchor := $anchor$  v_held public.pos_held_sales;$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS checkout declarations for discount approval.';
    end if;
    v_definition := replace(v_definition, v_anchor, v_anchor || E'\n  v_discount_approval_id uuid;\n  v_discount_approval record;\n  v_discount_fingerprint text;\n  v_normalized_items jsonb;\n  v_row_count bigint;');
  end if;

  if strpos(v_definition, 'Manager approval is missing, expired, or no longer matches this basket.') = 0 then
    v_anchor := $anchor$  if v_bill_discount > v_subtotal then raise exception 'Bill discount cannot exceed the sale subtotal.'; end if;$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS checkout discount validation for approval.';
    end if;
    v_replacement := $replacement$  if v_bill_discount > v_subtotal then raise exception 'Bill discount cannot exceed the sale subtotal.'; end if;
  if v_staff.role = 'cashier' and v_bill_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000) then
    begin
      v_discount_approval_id := (p_payload->>'discountApprovalId')::uuid;
    exception when invalid_text_representation then
      raise exception 'A manager or administrator must approve this bill discount.';
    end;
    if v_discount_approval_id is null or to_regclass('public.pos_discount_approvals') is null then
      raise exception 'A manager or administrator must approve this bill discount.';
    end if;
    select jsonb_agg(jsonb_build_object(
      'productId', lower(line.value->>'productId'),
      'quantityMilli', (line.value->>'quantityMilli')::bigint
    ) order by lower(line.value->>'productId'))
    into v_normalized_items
    from jsonb_array_elements(v_items) line(value);
    v_discount_fingerprint := md5(v_normalized_items::text || ':' || v_bill_discount::text);
    execute
      'select id, basket_fingerprint, status, expires_at
       from public.pos_discount_approvals
       where id = $1 and branch_id = $2 and cashier_id = $3
         and cashier_user_id = auth.uid()
       for update'
      into v_discount_approval
      using v_discount_approval_id, v_branch_id, v_staff.local_staff_id;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 or v_discount_approval.status <> 'approved'
      or v_discount_approval.expires_at <= v_now
      or v_discount_approval.basket_fingerprint <> v_discount_fingerprint then
      raise exception 'Manager approval is missing, expired, or no longer matches this basket.';
    end if;
  end if;$replacement$;
    v_definition := replace(v_definition, v_anchor, v_replacement);
  end if;

  if strpos(v_definition, 'Discount approval was already used.') = 0 then
    v_anchor := $anchor$  return jsonb_build_object(
    'duplicate', false,$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS checkout completion for discount approval use.';
    end if;
    v_replacement := $replacement$  if v_discount_approval_id is not null then
    execute
      'update public.pos_discount_approvals
       set status = ''used'', updated_at = $1, server_updated_at = $1
       where id = $2 and status = ''approved'''
      using v_now, v_discount_approval_id;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then raise exception 'Discount approval was already used.'; end if;
  end if;
  return jsonb_build_object(
    'duplicate', false,$replacement$;
    v_definition := replace(v_definition, v_anchor, v_replacement);
  end if;

  execute v_definition;

  select pg_get_functiondef('public.staff_manage_pos_held_sale(text, jsonb)'::regprocedure)
  into v_definition;
  if strpos(v_definition, 'must approve this discount before holding the sale.') = 0 then
    v_anchor := $anchor$    if v_discount > v_subtotal then raise exception 'Bill discount cannot exceed the sale subtotal.'; end if;$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate held-sale discount validation for approval.';
    end if;
    v_replacement := $replacement$    if v_discount > v_subtotal then raise exception 'Bill discount cannot exceed the sale subtotal.'; end if;
    if v_staff.role = 'cashier' and v_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000) then
      raise exception 'A manager or administrator must approve this discount before holding the sale.';
    end if;$replacement$;
    v_definition := replace(v_definition, v_anchor, v_replacement);
    execute v_definition;
  end if;
end;
$migration$;

commit;
