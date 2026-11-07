begin;

create or replace function public.staff_manage_return(
  p_action text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.cloud_staff;
  v_branch_id uuid;
  v_sale public.pos_sales;
  v_return public.returns;
  v_sale_item public.pos_sale_items;
  v_return_item jsonb;
  v_requested jsonb;
  v_items jsonb;
  v_lookup text;
  v_sale_id uuid;
  v_return_id uuid;
  v_client_return_id text;
  v_return_number text;
  v_quantity bigint;
  v_already_returned bigint;
  v_returnable bigint;
  v_line_refund bigint;
  v_refund_total bigint := 0;
  v_restock_total bigint := 0;
  v_condition text;
  v_reason text;
  v_notes text;
  v_now timestamptz := now();
  v_method text;
  v_reference text;
  v_rejection_reason text;
  v_branch_name text;
  v_invoice record;
  v_account_balance bigint;
  v_sale_credit bigint;
  v_already_credited bigint;
  v_credited bigint := 0;
  v_shift_id uuid;
  v_sold_quantity bigint;
  v_returned_quantity bigint;
  v_match_count integer;
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid return action.';
  end if;

  if v_staff.branch_id is not null then
    v_branch_id := v_staff.branch_id;
  elsif coalesce(p_payload->>'branchId', '') <> '' then
    begin
      v_branch_id := (p_payload->>'branchId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid branch.';
    end;
    if not public.has_branch_access(v_branch_id) then
      raise exception 'You cannot access that branch.';
    end if;
  end if;

  if p_action = 'lookup' then
    v_lookup := upper(btrim(coalesce(p_payload->>'receiptNumber', '')));
    if v_lookup = '' or length(v_lookup) > 60 then
      raise exception 'Enter a valid receipt number.';
    end if;
    select sale.* into v_sale
    from public.pos_sales sale
    where upper(sale.receipt_number) = v_lookup
      and sale.deleted_at is null
      and (v_branch_id is null or sale.branch_id = v_branch_id)
    limit 1;
    if not found and v_lookup ~ '^[0-9A-F]{6}$' then
      select count(*) into v_match_count
      from public.pos_sales sale
      where upper(right(sale.receipt_number, 6)) = v_lookup
        and sale.deleted_at is null
        and (v_branch_id is null or sale.branch_id = v_branch_id);
      if v_match_count > 1 then
        raise exception 'More than one sale matches this receipt suffix. Enter the full receipt number.';
      end if;
      if v_match_count = 1 then
        select sale.* into v_sale
        from public.pos_sales sale
        where upper(right(sale.receipt_number, 6)) = v_lookup
          and sale.deleted_at is null
          and (v_branch_id is null or sale.branch_id = v_branch_id)
        limit 1;
      end if;
    end if;
    if v_sale.id is null then raise exception 'Sale not found at this branch.'; end if;
    if not public.has_branch_access(v_sale.branch_id) then
      raise exception 'You cannot access that branch.';
    end if;
    if v_sale.status = 'void' then raise exception 'A voided sale cannot be returned.'; end if;
    if v_sale.status = 'refunded' then raise exception 'This sale has already been fully refunded.'; end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'sale_item_id', item.id,
      'product_id', item.product_id,
      'product_name', item.product_name,
      'unit_code', item.unit_code,
      'sold_milli', item.quantity_milli,
      'unit_price_paisa', item.unit_price_paisa,
      'returned_milli', coalesce(returned.quantity_milli, 0),
      'returnable_milli', greatest(0, item.quantity_milli - coalesce(returned.quantity_milli, 0))
    ) order by item.line_number), '[]'::jsonb)
    into v_items
    from public.pos_sale_items item
    left join lateral (
      select sum(return_item.quantity_milli)::bigint as quantity_milli
      from public.return_items return_item
      join public.returns return_record on return_record.id = return_item.return_id
      where return_item.sale_item_id = item.id
        and return_item.deleted_at is null
        and return_record.deleted_at is null
        and return_record.status in ('pending', 'approved', 'completed')
    ) returned on true
    where item.sale_id = v_sale.id and item.deleted_at is null;

    select branch.name into v_branch_name
    from public.branches branch
    where branch.id = v_sale.branch_id;
    return jsonb_build_object(
      'sale', jsonb_build_object(
        'id', v_sale.id,
        'receipt_number', v_sale.receipt_number,
        'branch_id', v_sale.branch_id,
        'branch_name', v_branch_name,
        'status', v_sale.status,
        'total_paisa', v_sale.total_paisa,
        'paid_paisa', v_sale.paid_paisa,
        'customer_name', v_sale.customer_name
      ),
      'items', v_items
    );
  elsif p_action = 'create' then
    v_client_return_id := nullif(btrim(p_payload->>'clientReturnId'), '');
    if v_client_return_id is null or length(v_client_return_id) > 100 then
      raise exception 'A valid return id is required.';
    end if;
    perform pg_advisory_xact_lock(hashtext(v_client_return_id));
    select * into v_return
    from public.returns
    where client_return_id = v_client_return_id and deleted_at is null
    limit 1;
    if found then
      return jsonb_build_object(
        'returnId', v_return.id,
        'returnNumber', v_return.return_number,
        'status', v_return.status,
        'refundTotalPaisa', v_return.refund_total_paisa
      );
    end if;

    if coalesce(p_payload->>'saleId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Choose a valid sale.';
    end if;
    v_sale_id := (p_payload->>'saleId')::uuid;
    select sale.* into v_sale
    from public.pos_sales sale
    where sale.id = v_sale_id
      and sale.deleted_at is null
      and (v_branch_id is null or sale.branch_id = v_branch_id)
    for update;
    if not found then raise exception 'Sale not found at this branch.'; end if;
    v_branch_id := v_sale.branch_id;
    if not public.has_branch_access(v_branch_id) then
      raise exception 'You cannot access that branch.';
    end if;
    if v_sale.status = 'void' then raise exception 'A voided sale cannot be returned.'; end if;
    if v_sale.status = 'refunded' then raise exception 'This sale has already been fully refunded.'; end if;
    v_requested := p_payload->'items';
    if coalesce(jsonb_typeof(v_requested), '') <> 'array' then
      raise exception 'Return items must be a list.';
    end if;
    if jsonb_array_length(v_requested) < 1 or jsonb_array_length(v_requested) > 100 then
      raise exception 'Select between 1 and 100 sale lines to return.';
    end if;
    v_reason := nullif(left(btrim(coalesce(p_payload->>'reason', '')), 300), '');
    if v_reason is null then raise exception 'Enter a return reason.'; end if;
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 1000), '');

    for v_return_item in select value from jsonb_array_elements(v_requested)
    loop
      if coalesce(v_return_item->>'saleItemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(v_return_item->>'quantityMilli', '') !~ '^[1-9]\d{0,14}$' then
        raise exception 'A return line or quantity is invalid.';
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_requested) other(value)
        where other.value->>'saleItemId' = v_return_item->>'saleItemId'
        group by other.value->>'saleItemId'
        having count(*) > 1
      ) then
        raise exception 'The same sale line cannot be returned twice in one request.';
      end if;
      v_quantity := (v_return_item->>'quantityMilli')::bigint;
      v_condition := coalesce(v_return_item->>'condition', 'new');
      if v_condition not in ('new', 'used', 'damaged', 'expired') then
        raise exception 'Choose a valid item condition.';
      end if;
      select item.* into v_sale_item
      from public.pos_sale_items item
      where item.id = (v_return_item->>'saleItemId')::uuid
        and item.sale_id = v_sale.id
        and item.deleted_at is null
      for update;
      if not found then raise exception 'A return line does not belong to this sale.'; end if;
      select coalesce(sum(return_item.quantity_milli), 0)::bigint
      into v_already_returned
      from public.return_items return_item
      join public.returns return_record on return_record.id = return_item.return_id
      where return_item.sale_item_id = v_sale_item.id
        and return_item.deleted_at is null
        and return_record.deleted_at is null
        and return_record.status in ('pending', 'approved', 'completed');
      v_returnable := v_sale_item.quantity_milli - v_already_returned;
      if v_quantity > v_returnable then
        raise exception 'The requested quantity is no longer returnable.';
      end if;
      if v_sale_item.quantity_milli < 1 or v_sale_item.line_total_paisa < 0 then
        raise exception 'The sale line has an invalid refundable amount.';
      end if;
      v_line_refund := floor(
        v_sale_item.line_total_paisa::numeric * (v_already_returned + v_quantity)::numeric
        / v_sale_item.quantity_milli + 0.5
      )::bigint - floor(
        v_sale_item.line_total_paisa::numeric * v_already_returned::numeric
        / v_sale_item.quantity_milli + 0.5
      )::bigint;
      if v_refund_total > 9000000000000000 - v_line_refund then
        raise exception 'The return refund exceeds the supported amount.';
      end if;
      v_refund_total := v_refund_total + v_line_refund;
      if v_condition in ('new', 'used') then
        v_restock_total := v_restock_total + v_quantity;
      end if;
    end loop;
    if v_refund_total <= 0 then raise exception 'The return has no refundable value.'; end if;

    v_return_id := gen_random_uuid();
    v_return_number := 'RET-' || to_char(v_now at time zone 'UTC', 'YYMMDDHH24MISS')
      || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    insert into public.returns (
      id, client_return_id, return_number, branch_id, sale_id, shift_id, status,
      reason, notes, refund_total_paisa, restock_total_milli, created_by,
      created_at, updated_at, server_updated_at
    ) values (
      v_return_id, v_client_return_id, v_return_number, v_sale.branch_id, v_sale.id,
      v_sale.shift_id, 'pending', v_reason, v_notes, v_refund_total, v_restock_total,
      v_staff.local_staff_id, v_now, v_now, v_now
    );
    for v_return_item in select value from jsonb_array_elements(v_requested)
    loop
      v_quantity := (v_return_item->>'quantityMilli')::bigint;
      v_condition := coalesce(v_return_item->>'condition', 'new');
      select item.* into v_sale_item
      from public.pos_sale_items item
      where item.id = (v_return_item->>'saleItemId')::uuid and item.sale_id = v_sale.id;
      select coalesce(sum(return_item.quantity_milli), 0)::bigint
      into v_already_returned
      from public.return_items return_item
      join public.returns return_record on return_record.id = return_item.return_id
      where return_item.sale_item_id = v_sale_item.id
        and return_item.deleted_at is null
        and return_record.deleted_at is null
        and return_record.status in ('pending', 'approved', 'completed');
      v_line_refund := floor(
        v_sale_item.line_total_paisa::numeric * (v_already_returned + v_quantity)::numeric
        / v_sale_item.quantity_milli + 0.5
      )::bigint - floor(
        v_sale_item.line_total_paisa::numeric * v_already_returned::numeric
        / v_sale_item.quantity_milli + 0.5
      )::bigint;
      insert into public.return_items (
        id, return_id, sale_item_id, product_id, product_name, unit_code,
        quantity_milli, unit_price_paisa, line_refund_paisa, condition, restock,
        created_at, server_updated_at
      ) values (
        gen_random_uuid(), v_return_id, v_sale_item.id, v_sale_item.product_id,
        v_sale_item.product_name, v_sale_item.unit_code, v_quantity,
        v_sale_item.unit_price_paisa, v_line_refund, v_condition,
        v_condition in ('new', 'used'), v_now, v_now
      );
    end loop;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_sale.branch_id, 'return.created',
      'return', v_return_id, jsonb_build_object(
        'returnNumber', v_return_number,
        'saleId', v_sale.id,
        'receiptNumber', v_sale.receipt_number,
        'refundTotalPaisa', v_refund_total,
        'lineCount', jsonb_array_length(v_requested),
        'reason', v_reason
      ), v_now
    );
    return jsonb_build_object(
      'returnId', v_return_id,
      'returnNumber', v_return_number,
      'status', 'pending',
      'refundTotalPaisa', v_refund_total
    );
  elsif p_action in ('approve', 'reject', 'cancel', 'complete') then
    if coalesce(p_payload->>'returnId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Choose a valid return.';
    end if;
    v_return_id := (p_payload->>'returnId')::uuid;
    select * into v_return
    from public.returns
    where id = v_return_id and deleted_at is null
    for update;
    if not found then raise exception 'Return not found.'; end if;
    if v_branch_id is not null and v_return.branch_id <> v_branch_id then
      raise exception 'This return belongs to another branch.';
    end if;
    if not public.has_branch_access(v_return.branch_id) then
      raise exception 'You cannot access that branch.';
    end if;

    if p_action = 'approve' then
      if v_staff.role not in ('manager', 'admin') then
        raise exception 'Manager or administrator access is required.';
      end if;
      if v_return.status <> 'pending' then raise exception 'Only a pending return can be approved.'; end if;
      update public.returns
      set status = 'approved', approved_by = v_staff.local_staff_id, approved_at = v_now,
          updated_at = v_now, server_updated_at = v_now
      where id = v_return.id;
    elsif p_action = 'reject' then
      if v_staff.role not in ('manager', 'admin') then
        raise exception 'Manager or administrator access is required.';
      end if;
      if v_return.status not in ('pending', 'approved') then
        raise exception 'Only a pending or approved return can be rejected.';
      end if;
      v_rejection_reason := nullif(left(btrim(coalesce(p_payload->>'reason', '')), 300), '');
      if v_rejection_reason is null then raise exception 'Enter a rejection reason.'; end if;
      update public.returns
      set status = 'rejected', rejected_by = v_staff.local_staff_id, rejected_at = v_now,
          rejection_reason = v_rejection_reason, updated_at = v_now, server_updated_at = v_now
      where id = v_return.id;
    elsif p_action = 'cancel' then
      if v_return.status <> 'pending' then raise exception 'Only a pending return can be cancelled.'; end if;
      if v_return.created_by <> v_staff.local_staff_id and v_staff.role not in ('manager', 'admin') then
        raise exception 'Only the staff member who raised this return can cancel it.';
      end if;
      update public.returns
      set status = 'cancelled', updated_at = v_now, server_updated_at = v_now
      where id = v_return.id;
    else
      if v_return.created_by <> v_staff.local_staff_id then
        raise exception 'Only the staff member who raised this return can complete the refund.';
      end if;
      if v_return.status = 'completed' then
        return jsonb_build_object('returnId', v_return.id, 'status', 'completed');
      end if;
      if v_return.status <> 'approved' then raise exception 'Approve the return before completing it.'; end if;
      if v_return.refund_total_paisa <= 0 then raise exception 'The return has no refundable value.'; end if;
      v_method := coalesce(p_payload->>'refundMethod', 'cash');
      if v_method not in ('cash', 'card', 'jazzcash', 'easypaisa', 'bank_transfer', 'store_credit', 'replacement') then
        raise exception 'Choose a valid refund method.';
      end if;
      v_reference := nullif(left(btrim(coalesce(p_payload->>'reference', '')), 100), '');
      select * into v_sale from public.pos_sales where id = v_return.sale_id for update;
      if not found then raise exception 'The linked sale receipt could not be loaded.'; end if;

      if v_sale.customer_account_id is not null then
        perform 1 from public.customer_accounts
        where id = v_sale.customer_account_id
        for update;
        select invoice.id, invoice.account_id
        into v_invoice
        from public.customer_invoices invoice
        where invoice.pos_sale_id = v_sale.id
        order by invoice.created_at
        limit 1
        for update;
        if found then
          select (
            coalesce((select sum(invoice.amount_paisa)
              from public.customer_invoices invoice
              where invoice.account_id = v_invoice.account_id), 0)
            - coalesce((select sum(payment.amount_paisa)
              from public.customer_payments payment
              where payment.account_id = v_invoice.account_id), 0)
          )::bigint into v_account_balance;
          select coalesce(sum(payment.amount_paisa), 0)::bigint
          into v_sale_credit
          from public.pos_sale_payments payment
          where payment.sale_id = v_sale.id
            and payment.method = 'credit'
            and payment.deleted_at is null;
          select coalesce(sum(refund.credited_paisa), 0)::bigint
          into v_already_credited
          from public.return_refunds refund
          join public.returns return_record on return_record.id = refund.return_id
          where return_record.sale_id = v_sale.id
            and return_record.status = 'completed'
            and refund.deleted_at is null;
          v_credited := greatest(0, least(
            v_return.refund_total_paisa,
            v_sale_credit - v_already_credited,
            v_account_balance
          ));
          if v_credited > 0 then
            insert into public.customer_payments (
              id, account_id, branch_id, invoice_id, method, amount_paisa, reference,
              notes, paid_by, paid_at, created_at
            ) values (
              gen_random_uuid(), v_invoice.account_id, v_return.branch_id, v_invoice.id,
              'credit', v_credited, v_return.return_number,
              'Credit note for return ' || v_return.return_number,
              v_staff.local_staff_id, v_now, v_now
            );
          end if;
        end if;
      end if;

      select shift.id into v_shift_id
      from public.pos_shifts shift
      where shift.cashier_id = v_staff.local_staff_id
        and shift.branch_id = v_return.branch_id
        and shift.status = 'open'
        and shift.deleted_at is null
      order by shift.opened_at desc
      limit 1
      for update;

      insert into public.return_refunds (
        id, return_id, method, amount_paisa, status, reference, processed_by,
        processed_at, shift_id, credited_paisa, created_at, server_updated_at
      ) values (
        gen_random_uuid(), v_return.id, v_method, v_return.refund_total_paisa,
        'processed', v_reference, v_staff.local_staff_id, v_now,
        v_shift_id, v_credited, v_now, v_now
      );

      insert into public.stock_movements (
        id, idempotency_key, branch_id, product_id, movement_type,
        quantity_delta_milli, unit_cost_paisa, reference_type, reference_id,
        created_by, notes, occurred_at, created_at, server_updated_at
      )
      select gen_random_uuid(),
        'return:' || v_return.id::text || ':' || item.id::text,
        v_return.branch_id, item.product_id, 'return', item.quantity_milli,
        null, 'pos_return', v_return.id::text, v_staff.local_staff_id,
        'Return ' || v_return.return_number, v_now, v_now, v_now
      from public.return_items item
      where item.return_id = v_return.id
        and item.restock
        and item.product_id is not null
        and item.deleted_at is null;

      update public.returns
      set status = 'completed', completed_by = v_staff.local_staff_id,
          completed_at = v_now, updated_at = v_now, server_updated_at = v_now
      where id = v_return.id;

      select coalesce(sum(item.quantity_milli), 0)::bigint
      into v_sold_quantity
      from public.pos_sale_items item
      where item.sale_id = v_sale.id and item.deleted_at is null;
      select coalesce(sum(item.quantity_milli), 0)::bigint
      into v_returned_quantity
      from public.return_items item
      join public.returns return_record on return_record.id = item.return_id
      where return_record.sale_id = v_sale.id
        and return_record.status = 'completed'
        and item.deleted_at is null
        and return_record.deleted_at is null;
      update public.pos_sales
      set status = case when v_sold_quantity > 0 and v_returned_quantity >= v_sold_quantity
        then 'refunded' else 'partially_refunded' end,
        updated_at = v_now, server_updated_at = v_now
      where id = v_sale.id and status <> 'void';
    end if;

    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_return.branch_id,
      'return.' || case p_action when 'approve' then 'approved' when 'reject' then 'rejected'
        when 'cancel' then 'cancelled' else 'completed' end,
      'return', v_return.id, jsonb_build_object(
        'returnNumber', v_return.return_number,
        'refundTotalPaisa', v_return.refund_total_paisa,
        'action', p_action
      ), v_now
    );
    return jsonb_build_object('returnId', v_return.id, 'status',
      case p_action when 'approve' then 'approved' when 'reject' then 'rejected'
        when 'cancel' then 'cancelled' else 'completed' end);
  end if;

  raise exception 'Unsupported return action.';
end;
$$;

revoke all on function public.staff_manage_return(text, jsonb) from public, anon, authenticated;
grant execute on function public.staff_manage_return(text, jsonb) to authenticated;

commit;
