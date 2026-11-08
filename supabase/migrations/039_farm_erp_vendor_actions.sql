begin;

create or replace function public.manage_web_vendor(p_action text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_actor_branch_id uuid;
  v_branch_id uuid;
  v_supplier_id uuid;
  v_receipt_id uuid;
  v_return_id uuid;
  v_payment_id uuid;
  v_item_id uuid;
  v_product_id uuid;
  v_order_id uuid;
  v_idempotency_key text;
  v_name text;
  v_active boolean;
  v_method text;
  v_reference text;
  v_notes text;
  v_amount bigint;
  v_due numeric;
  v_paid numeric;
  v_returned numeric;
  v_total numeric := 0;
  v_credit numeric := 0;
  v_quantity bigint;
  v_unit_cost bigint;
  v_credit_quantity bigint;
  v_stock numeric;
  v_requested numeric;
  v_order_item_found boolean;
  v_line jsonb;
  v_item record;
  v_receipt record;
  v_supplier record;
  v_clean_lines jsonb := '[]'::jsonb;
  v_requested_product_ids uuid[] := array[]::uuid[];
  v_reason text;
  v_disposition text;
  v_now timestamptz := now();
  v_action_name text;
begin
  if not public.is_admin_role() then
    raise exception 'Vendor actions are restricted to administrators.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid vendor action.';
  end if;
  select staff.local_staff_id,staff.branch_id into v_actor_id,v_actor_branch_id
  from public.cloud_staff staff
  where staff.user_id = auth.uid() and staff.is_active;
  if v_actor_id is null then
    raise exception 'Your staff profile is not linked for vendor actions.';
  end if;

  if p_action in ('save', 'set-active') then
    if p_action = 'save' then
      v_name := nullif(btrim(p_payload->>'name'),'');
      if v_name is null or length(v_name) > 200 then
        raise exception 'Enter a vendor name of up to 200 characters.';
      end if;
      if nullif(p_payload->>'id','') is not null then
        begin
          v_supplier_id := (p_payload->>'id')::uuid;
        exception when invalid_text_representation then
          raise exception 'Choose a valid vendor.';
        end;
        select * into v_supplier
        from public.suppliers
        where id = v_supplier_id and deleted_at is null
        for update;
        if not found then raise exception 'Vendor not found.'; end if;
        update public.suppliers
        set name = v_name,
            contact_name = nullif(left(btrim(coalesce(p_payload->>'contactName','')),200),''),
            phone = nullif(left(btrim(coalesce(p_payload->>'phone','')),50),''),
            email = nullif(left(btrim(coalesce(p_payload->>'email','')),254),''),
            address = nullif(left(btrim(coalesce(p_payload->>'address','')),1000),''),
            notes = nullif(left(btrim(coalesce(p_payload->>'notes','')),1000),''),
            updated_at = v_now, server_updated_at = v_now
        where id = v_supplier_id;
        v_action_name := 'supplier.updated';
      else
        v_supplier_id := gen_random_uuid();
        insert into public.suppliers(
          id,name,contact_name,phone,email,address,notes,created_by,created_at,updated_at,server_updated_at
        ) values(
          v_supplier_id,v_name,
          nullif(left(btrim(coalesce(p_payload->>'contactName','')),200),''),
          nullif(left(btrim(coalesce(p_payload->>'phone','')),50),''),
          nullif(left(btrim(coalesce(p_payload->>'email','')),254),''),
          nullif(left(btrim(coalesce(p_payload->>'address','')),1000),''),
          nullif(left(btrim(coalesce(p_payload->>'notes','')),1000),''),
          v_actor_id,v_now,v_now,v_now
        );
        v_action_name := 'supplier.created';
      end if;
      insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
      values(
        gen_random_uuid(),v_actor_id,v_actor_branch_id,v_action_name,'supplier',v_supplier_id::text,
        jsonb_build_object('name',v_name),v_now,v_now
      );
      return jsonb_build_object('id',v_supplier_id,'name',v_name);
    end if;

    begin
      v_supplier_id := (p_payload->>'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid vendor.';
    end;
    if coalesce(jsonb_typeof(p_payload->'active'),'') <> 'boolean' then
      raise exception 'Choose whether the vendor should be active.';
    end if;
    v_active := (p_payload->>'active')::boolean;
    select * into v_supplier
    from public.suppliers
    where id = v_supplier_id and deleted_at is null
    for update;
    if not found then raise exception 'Vendor not found.'; end if;
    update public.suppliers
    set is_active = v_active, updated_at = v_now, server_updated_at = v_now
    where id = v_supplier_id;
    insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
    values(
      gen_random_uuid(),v_actor_id,v_actor_branch_id,
      case when v_active then 'supplier.activated' else 'supplier.deactivated' end,
      'supplier',v_supplier_id::text,jsonb_build_object('name',v_supplier.name),v_now,v_now
    );
    return jsonb_build_object('id',v_supplier_id,'active',v_active);
  elsif p_action = 'payment' then
    begin
      v_receipt_id := (p_payload->>'receiptId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid purchase receipt.';
    end;
    if coalesce(p_payload->>'amountPaisa','') !~ '^\d{1,15}$' then
      raise exception 'Enter a valid payment amount.';
    end if;
    v_amount := (p_payload->>'amountPaisa')::bigint;
    if v_amount < 1 then raise exception 'Payment amount must be greater than zero.'; end if;
    v_method := coalesce(p_payload->>'method','');
    if v_method not in ('cash','bank_transfer','card','jazzcash','easypaisa','other') then
      raise exception 'Choose a supported supplier payment method.';
    end if;
    v_reference := nullif(left(btrim(coalesce(p_payload->>'reference','')),100),'');
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes','')),500),'');
    select * into v_receipt
    from public.purchase_receipts
    where id = v_receipt_id and deleted_at is null
    for update;
    if not found or not public.has_branch_access(v_receipt.branch_id) then
      raise exception 'Purchase receipt not found at your branch.';
    end if;
    v_branch_id := v_receipt.branch_id;
    select coalesce(sum(payment.amount_paisa),0)
    into v_paid from public.supplier_payments payment
    where payment.receipt_id = v_receipt_id and payment.deleted_at is null;
    select coalesce(sum(return_record.total_paisa),0)
    into v_returned from public.supplier_returns return_record
    where return_record.receipt_id = v_receipt_id and return_record.disposition = 'credit'
      and return_record.deleted_at is null;
    v_due := v_receipt.subtotal_paisa-v_paid-v_returned;
    if v_due <= 0 then raise exception 'This invoice has no outstanding balance after supplier returns.'; end if;
    if v_amount > v_due then raise exception 'Payment cannot exceed the outstanding balance of % paisa.',v_due; end if;
    v_payment_id := gen_random_uuid();
    insert into public.supplier_payments(
      id,branch_id,receipt_id,method,amount_paisa,reference,notes,paid_by,paid_at,created_at,server_updated_at
    ) values(v_payment_id,v_branch_id,v_receipt_id,v_method,v_amount,v_reference,v_notes,v_actor_id,v_now,v_now,v_now);
    insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
    values(
      gen_random_uuid(),v_actor_id,v_branch_id,'supplier_payment.recorded','supplier_payment',v_payment_id::text,
      jsonb_build_object('receiptId',v_receipt_id,'method',v_method,'amountPaisa',v_amount,
        'reference',v_reference,'notes',v_notes),v_now,v_now
    );
    return jsonb_build_object('id',v_payment_id,'receiptId',v_receipt_id,
      'paidPaisa',v_paid+v_amount,'duePaisa',v_due-v_amount);
  elsif p_action = 'return' then
    v_idempotency_key := nullif(left(btrim(coalesce(p_payload->>'clientReturnId','')),100),'');
    if v_idempotency_key is null then raise exception 'A return request key is required.'; end if;
    v_disposition := coalesce(p_payload->>'disposition','credit');
    if v_disposition not in ('credit','replacement') then raise exception 'Choose supplier credit or replacement.'; end if;
    v_reason := coalesce(p_payload->>'reason','');
    if v_reason not in ('damaged','quality','expired','incorrect_item','other') then
      raise exception 'Choose a supported supplier return reason.';
    end if;
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes','')),500),'');
    if coalesce(jsonb_typeof(p_payload->'items'),'') <> 'array' then
      raise exception 'Supplier return items must be a list.';
    end if;
    if jsonb_array_length(p_payload->'items') < 1 or jsonb_array_length(p_payload->'items') > 200 then
      raise exception 'A supplier return must include between 1 and 200 products.';
    end if;
    begin
      v_receipt_id := (p_payload->>'receiptId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid purchase receipt.';
    end;

    perform pg_advisory_xact_lock(hashtext('supplier-return:'||v_idempotency_key));
    select * into v_supplier
    from public.supplier_returns
    where client_return_id = v_idempotency_key and deleted_at is null;
    if found then
      if not public.has_branch_access(v_supplier.branch_id) then
        raise exception 'This return request key has already been used.';
      end if;
      return jsonb_build_object('duplicate',true,'id',v_supplier.id,'totalPaisa',v_supplier.total_paisa);
    end if;

    select * into v_receipt
    from public.purchase_receipts receipt
    where receipt.id = v_receipt_id and receipt.deleted_at is null
    for update;
    if not found or not public.has_branch_access(v_receipt.branch_id) then
      raise exception 'Purchase receipt not found at your branch.';
    end if;
    v_branch_id := v_receipt.branch_id;
    v_order_id := v_receipt.purchase_order_id;
    if v_order_id is not null and not exists (
      select 1 from public.purchase_orders purchase_order
      where purchase_order.id = v_order_id and purchase_order.deleted_at is null
    ) then
      v_order_id := null;
    end if;
    if v_disposition = 'replacement' and v_order_id is null then
      raise exception 'Only a purchase order delivery can be returned for replacement.';
    end if;

    for v_line in select value from jsonb_array_elements(p_payload->'items') as lines(value)
    loop
      if jsonb_typeof(v_line) <> 'object' then raise exception 'Each return line must be an object.'; end if;
      begin
        v_item_id := (v_line->>'receiptItemId')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid received product.';
      end;
      if v_clean_lines @> jsonb_build_array(jsonb_build_object('receiptItemId',v_item_id)) then
        raise exception 'Each received product can only be returned once per request.';
      end if;
      if coalesce(v_line->>'quantityMilli','') !~ '^\d{1,15}$' then
        raise exception 'Enter a valid return quantity.';
      end if;
      v_quantity := (v_line->>'quantityMilli')::bigint;
      if v_quantity < 1 then raise exception 'Return quantity must be greater than zero.'; end if;
      select item.id,item.product_id,item.product_name,item.unit_code,item.quantity_milli,
        item.unit_cost_paisa,item.replacement_quantity_milli
      into v_item
      from public.purchase_receipt_items item
      where item.id = v_item_id and item.receipt_id = v_receipt_id and item.deleted_at is null
      for update;
      if not found then raise exception 'A returned product was not part of this purchase receipt.'; end if;
      select coalesce(sum(return_item.quantity_milli),0)
      into v_stock
      from public.supplier_return_items return_item
      join public.supplier_returns return_record on return_record.id = return_item.return_id
      where return_item.receipt_item_id = v_item_id
        and return_record.branch_id = v_branch_id and return_record.deleted_at is null;
      if v_quantity > v_item.quantity_milli-v_stock then
        raise exception '% exceeds the quantity remaining from this receipt.',v_item.product_name;
      end if;
      v_requested_product_ids := array_append(v_requested_product_ids,v_item.product_id);
      select coalesce(sum(return_item.quantity_milli),0)
      into v_stock
      from public.supplier_return_items return_item
      join public.supplier_returns return_record on return_record.id = return_item.return_id
      where return_item.receipt_item_id = v_item_id and return_record.disposition = 'credit'
        and return_record.deleted_at is null;
      v_credit_quantity := least(v_quantity,greatest(0,
        v_item.quantity_milli-v_item.replacement_quantity_milli-v_stock));
      v_unit_cost := v_item.unit_cost_paisa;
      v_total := v_total+round(v_unit_cost::numeric*v_quantity/1000);
      v_credit := v_credit+round(v_unit_cost::numeric*v_credit_quantity/1000);
      if v_total > 9223372036854775807 or v_credit > 9223372036854775807 then
        raise exception 'Supplier return total is too large.';
      end if;
      v_clean_lines := v_clean_lines || jsonb_build_array(jsonb_build_object(
        'receiptItemId',v_item.id,'productId',v_item.product_id,'productName',v_item.product_name,
        'unitCode',v_item.unit_code,'quantityMilli',v_quantity,'unitCostPaisa',v_unit_cost,
        'lineTotalPaisa',round(v_unit_cost::numeric*v_quantity/1000),
        'creditLineTotalPaisa',round(v_unit_cost::numeric*v_credit_quantity/1000)
      ));
    end loop;

    for v_product_id in
      select distinct item from unnest(v_requested_product_ids) as ids(item) order by item
    loop
      perform pg_advisory_xact_lock(hashtext(v_branch_id::text||':'||v_product_id::text));
      select coalesce(sum(movement.quantity_delta_milli),0) into v_stock
      from public.stock_movements movement
      where movement.branch_id = v_branch_id and movement.product_id = v_product_id and movement.deleted_at is null;
      select coalesce(sum((line->>'quantityMilli')::bigint),0) into v_requested
      from jsonb_array_elements(v_clean_lines) as lines(line)
      where (line->>'productId')::uuid = v_product_id;
      if v_requested > v_stock then
        raise exception 'Insufficient branch stock to return %.',(
          select line->>'productName' from jsonb_array_elements(v_clean_lines) as lines(line)
          where (line->>'productId')::uuid = v_product_id limit 1
        );
      end if;
    end loop;

    if v_order_id is not null then
      perform 1 from public.purchase_orders where id = v_order_id for update;
    end if;
    if v_disposition = 'replacement' then
      for v_product_id in
        select distinct item from unnest(v_requested_product_ids) as ids(item) order by item
      loop
        select item.received_quantity_milli into v_stock
        from public.purchase_order_items item
        where item.order_id = v_order_id and item.product_id = v_product_id and item.deleted_at is null
        for update;
        v_order_item_found := found;
        select coalesce(sum((line->>'quantityMilli')::bigint),0) into v_requested
        from jsonb_array_elements(v_clean_lines) as lines(line)
        where (line->>'productId')::uuid = v_product_id;
        if not v_order_item_found or v_requested > v_stock then
          raise exception 'A returned product cannot reopen more quantity than the purchase order received.';
        end if;
      end loop;
    end if;

    v_return_id := gen_random_uuid();
    v_amount := case when v_disposition = 'credit' then v_credit::bigint else 0 end;
    insert into public.supplier_returns(
      id,client_return_id,branch_id,supplier_id,receipt_id,reason,disposition,notes,total_paisa,
      returned_by,returned_at,created_at,server_updated_at
    ) values(
      v_return_id,v_idempotency_key,v_branch_id,v_receipt.supplier_id,v_receipt_id,
      v_reason,v_disposition,v_notes,v_amount,v_actor_id,v_now,v_now,v_now
    );
    for v_line in select value from jsonb_array_elements(v_clean_lines) as lines(value)
    loop
      insert into public.supplier_return_items(
        id,return_id,receipt_item_id,product_id,product_name,unit_code,quantity_milli,
        unit_cost_paisa,line_total_paisa,server_updated_at
      ) values(
        gen_random_uuid(),v_return_id,(v_line->>'receiptItemId')::uuid,(v_line->>'productId')::uuid,
        v_line->>'productName',v_line->>'unitCode',(v_line->>'quantityMilli')::bigint,
        (v_line->>'unitCostPaisa')::bigint,(v_line->>'lineTotalPaisa')::bigint,v_now
      );
    end loop;
    for v_product_id in
      select distinct item from unnest(v_requested_product_ids) as ids(item) order by item
    loop
      select coalesce(sum((line->>'quantityMilli')::bigint),0) into v_requested
      from jsonb_array_elements(v_clean_lines) as lines(line)
      where (line->>'productId')::uuid = v_product_id;
      select (line->>'unitCostPaisa')::bigint into v_unit_cost
      from jsonb_array_elements(v_clean_lines) as lines(line)
      where (line->>'productId')::uuid = v_product_id limit 1;
      insert into public.stock_movements(
        id,idempotency_key,branch_id,product_id,movement_type,quantity_delta_milli,unit_cost_paisa,
        reference_type,reference_id,created_by,notes,occurred_at,created_at,server_updated_at
      ) values(
        gen_random_uuid(),'supplier_return:'||v_return_id::text||':'||v_product_id::text,
        v_branch_id,v_product_id,'adjustment',-v_requested::bigint,v_unit_cost,
        'supplier_return',v_return_id::text,v_actor_id,
        'Supplier return ('||v_reason||'): '||coalesce(v_notes,'No additional notes'),v_now,v_now,v_now
      );
      if v_disposition = 'replacement' then
        update public.purchase_order_items
        set received_quantity_milli = received_quantity_milli-v_requested::bigint,server_updated_at = v_now
        where order_id = v_order_id and product_id = v_product_id and deleted_at is null;
      end if;
    end loop;
    if v_disposition = 'replacement' then
      update public.purchase_orders
      set status = case when exists(
        select 1 from public.purchase_order_items item
        where item.order_id = v_order_id and item.deleted_at is null
          and item.received_quantity_milli < item.ordered_quantity_milli
      ) then 'partially_received' else 'received' end,
      updated_at = v_now,server_updated_at = v_now
      where id = v_order_id;
    end if;
    insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
    values(
      gen_random_uuid(),v_actor_id,v_branch_id,'supplier.return_recorded','supplier_return',v_return_id::text,
      jsonb_build_object('receiptId',v_receipt_id,'clientReturnId',v_idempotency_key,
        'reason',v_reason,'disposition',v_disposition,'totalPaisa',v_amount,
        'itemCount',jsonb_array_length(v_clean_lines),'notes',v_notes),v_now,v_now
    );
    return jsonb_build_object('duplicate',false,'id',v_return_id,'totalPaisa',v_amount,
      'itemCount',jsonb_array_length(v_clean_lines));
  else
    raise exception 'Choose a supported vendor action.';
  end if;
end;
$$;

revoke all on function public.manage_web_vendor(text,jsonb) from public;
grant execute on function public.manage_web_vendor(text,jsonb) to authenticated;

commit;
