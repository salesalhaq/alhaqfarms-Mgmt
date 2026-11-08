begin;

create or replace function public.staff_manage_purchasing(
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
  v_now timestamptz := now();
  v_allowed boolean;
  v_permission_key text;
  v_module_key text;
  v_idempotency_key text;
  v_order_id uuid;
  v_order public.purchase_orders;
  v_receipt_id uuid;
  v_expected_at date;
  v_receipt public.purchase_receipts;
  v_supplier_id uuid;
  v_product_id uuid;
  v_product public.products;
  v_item jsonb;
  v_item_count integer;
  v_seen_count integer;
  v_unique_count integer;
  v_quantity bigint;
  v_unit_cost bigint;
  v_line_total bigint;
  v_subtotal bigint := 0;
  v_existing public.purchase_receipts;
  v_prior_audit public.audit_log;
  v_order_item public.purchase_order_items;
  v_remaining bigint;
  v_replacement bigint;
  v_returned_replacement bigint;
  v_replacement_received bigint;
  v_payable bigint;
  v_receipt_item public.purchase_receipt_items;
  v_return_id uuid;
  v_return public.supplier_returns;
  v_return_item_id uuid;
  v_returned bigint;
  v_reserved bigint;
  v_stock bigint;
  v_prior_credited bigint;
  v_creditable bigint;
  v_credit_total bigint := 0;
  v_payment_amount bigint;
  v_paid bigint;
  v_credit bigint;
  v_due bigint;
  v_method text;
  v_reference text;
  v_notes text;
  v_reason text;
  v_disposition text;
  v_invoice text;
  v_order_status text;
  v_order_number text;
  v_changed integer;
  v_item_count_out integer;
  v_total bigint;
  v_movement_id uuid;
  v_detail jsonb;
  v_saved_lines integer;
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() or v_staff.local_staff_id is null then
    raise exception 'Sign in with an active staff account.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid purchasing action.';
  end if;
  if p_action is null or p_action not in (
    'create_order', 'receive_order', 'cancel_order', 'supplier_payment', 'supplier_return'
  ) then
    raise exception 'Choose a supported purchasing action.';
  end if;

  begin
    v_branch_id := (p_payload->>'branchId')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid branch.';
  end;
  if v_branch_id is null
     or not public.has_branch_access(v_branch_id)
     or (v_staff.branch_id is not null and v_staff.branch_id <> v_branch_id) then
    raise exception 'You cannot access that branch.' using errcode = '42501';
  end if;
  v_idempotency_key := nullif(btrim(p_payload->>'idempotencyKey'), '');
  if v_idempotency_key is null or length(v_idempotency_key) > 100 then
    raise exception 'This action is missing a valid request key.';
  end if;

  if v_staff.role <> 'admin' then
    if v_staff.role <> 'manager' or v_staff.branch_id is null then
      raise exception 'Purchasing records are available to managers and admins only.' using errcode = '42501';
    end if;
    if v_branch_id is null or v_branch_id <> v_staff.branch_id or not public.has_branch_access(v_branch_id) then
      raise exception 'You cannot access that branch.' using errcode = '42501';
    end if;
    v_module_key := case
      when p_action = 'supplier_payment' or p_action = 'supplier_return' then 'module:vendors:view'
      when p_action = 'receive_order' then 'module:receive_stock:view'
      else 'module:purchasing:view'
    end;
    select permission.is_allowed into v_allowed
    from public.branch_module_permissions permission
    where permission.branch_id = v_branch_id
      and permission.role = v_staff.role
      and permission.permission_key = v_module_key
      and permission.deleted_at is null
    order by permission.updated_at desc, permission.id desc
    limit 1;
    if not coalesce(v_allowed, true) then
      raise exception 'Your role cannot access this purchasing workflow.' using errcode = '42501';
    end if;
    v_permission_key := case p_action
      when 'create_order' then 'action:create_purchase_order'
      when 'receive_order' then 'action:receive_purchase_order'
      when 'cancel_order' then 'module:purchasing:manage'
      else 'action:manage_vendors'
    end;
    select permission.is_allowed into v_allowed
    from public.branch_module_permissions permission
    where permission.branch_id = v_branch_id
      and permission.role = v_staff.role
      and permission.permission_key = v_permission_key
      and permission.deleted_at is null
    order by permission.updated_at desc, permission.id desc
    limit 1;
    if not coalesce(v_allowed, true) then
      raise exception 'Your role does not allow this purchasing action.' using errcode = '42501';
    end if;
  end if;

  if not exists (
    select 1 from public.branches
    where id = v_branch_id and is_active and deleted_at is null
  ) then
    raise exception 'Choose an active branch.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'purchasing:' || v_staff.user_id::text || ':' || p_action || ':' || v_idempotency_key,
    0
  ));

  if p_action = 'create_order' then
    select * into v_prior_audit from public.audit_log
    where actor_id = v_staff.local_staff_id and branch_id = v_branch_id
      and action = 'purchase_order.placed'
      and details_json->>'idempotencyKey' = v_idempotency_key
      and deleted_at is null
    limit 1;
    if found then
      select * into v_order from public.purchase_orders where id = v_prior_audit.entity_id::uuid;
      return jsonb_build_object(
        'id', v_order.id, 'orderNumber', v_order.order_number,
        'orderedTotalPaisa', v_order.ordered_total_paisa, 'duplicate', true
      );
    end if;
    begin
      v_supplier_id := (p_payload->>'supplierId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose an active supplier.';
    end;
    if not exists (
      select 1 from public.suppliers
      where id = v_supplier_id and is_active and deleted_at is null
    ) then
      raise exception 'Choose an active supplier.';
    end if;
    if jsonb_typeof(p_payload->'items') is distinct from 'array' then
      raise exception 'A purchase order must contain products.';
    end if;
    select count(*) into v_item_count from jsonb_array_elements(p_payload->'items');
    if v_item_count < 1 or v_item_count > 200 then
      raise exception 'A purchase order must contain between 1 and 200 products.';
    end if;
    for v_item in select value from jsonb_array_elements(p_payload->'items') loop
      if jsonb_typeof(v_item) <> 'object'
         or coalesce(v_item->>'productId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or coalesce(v_item->>'quantityMilli', '') !~ '^[0-9]+$'
         or coalesce(v_item->>'unitCostPaisa', '') !~ '^[0-9]+$' then
        raise exception 'Enter a valid product, quantity, and unit cost for every order line.';
      end if;
    end loop;
    select count(*), count(distinct (item.value->>'productId')::uuid)
    into v_seen_count, v_unique_count
    from jsonb_array_elements(p_payload->'items') item(value);
    if v_seen_count <> v_unique_count then
      raise exception 'Each product can only appear once per purchase order.';
    end if;

    v_expected_at := null;
    if nullif(p_payload->>'expectedAt', '') is not null then
      if (p_payload->>'expectedAt') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Expected delivery date must be a valid calendar date.';
      end if;
      begin
        v_expected_at := (p_payload->>'expectedAt')::date;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception 'Expected delivery date must be a valid calendar date.';
      end;
    end if;

    for v_product_id in
      select product.id
      from public.products product
      where product.id in (
        select (item.value->>'productId')::uuid
        from jsonb_array_elements(p_payload->'items') item(value)
      )
        and product.deleted_at is null
        and product.is_active
      order by product.id
      for update
    loop
      v_saved_lines := coalesce(v_saved_lines, 0) + 1;
    end loop;
    if v_saved_lines <> v_item_count then
      raise exception 'A purchase order product is inactive or was not found.';
    end if;

    v_order_id := gen_random_uuid();
    v_order_number := 'PO-' || to_char(v_now, 'YYMMDD-HH24MISS') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    insert into public.purchase_orders (
      id, branch_id, supplier_id, order_number, status, expected_at, notes,
      ordered_total_paisa, created_by, ordered_at, updated_at, server_updated_at
    ) values (
      v_order_id, v_branch_id, v_supplier_id, v_order_number, 'ordered',
      v_expected_at, v_notes, 0,
      v_staff.local_staff_id, v_now, v_now, v_now
    );

    for v_item in select value from jsonb_array_elements(p_payload->'items') loop
      v_product_id := (v_item->>'productId')::uuid;
      v_quantity := (v_item->>'quantityMilli')::bigint;
      v_unit_cost := (v_item->>'unitCostPaisa')::bigint;
      if v_quantity < 1 then raise exception 'Purchase quantities must be positive.'; end if;
      if v_quantity > 9007199254740991 or v_unit_cost > 9007199254740991 then
        raise exception 'Purchase order line total is too large.';
      end if;
      select * into v_product from public.products where id = v_product_id and deleted_at is null;
      v_line_total := floor((v_unit_cost::numeric * v_quantity + 500) / 1000)::bigint;
      if v_line_total > 9007199254740991 or v_subtotal + v_line_total > 9007199254740991 then
        raise exception 'Purchase order total is too large.';
      end if;
      v_subtotal := v_subtotal + v_line_total;
      insert into public.purchase_order_items (
        id, order_id, product_id, product_name, unit_code, ordered_quantity_milli,
        received_quantity_milli, unit_cost_paisa, line_total_paisa, server_updated_at
      ) values (
        gen_random_uuid(), v_order_id, v_product_id, v_product.name, v_product.unit_code,
        v_quantity, 0, v_unit_cost, v_line_total, v_now
      );
    end loop;
    update public.purchase_orders
    set ordered_total_paisa = v_subtotal, updated_at = v_now, server_updated_at = v_now
    where id = v_order_id;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'purchase_order.placed',
      'purchase_order', v_order_id::text,
      jsonb_build_object(
        'orderNumber', v_order_number, 'supplierId', v_supplier_id,
        'orderedTotalPaisa', v_subtotal, 'itemCount', v_item_count, 'notes', v_notes,
        'idempotencyKey', v_idempotency_key
      ),
      v_now, v_now
    );
    return jsonb_build_object(
      'id', v_order_id, 'orderNumber', v_order_number,
      'orderedTotalPaisa', v_subtotal, 'itemCount', v_item_count
    );
  end if;

  if p_action = 'cancel_order' then
    begin
      v_order_id := (p_payload->>'orderId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid purchase order.';
    end;
    v_reason := nullif(btrim(p_payload->>'reason'), '');
    if v_reason is null or length(v_reason) > 500 then
      raise exception 'Enter a cancellation reason of 500 characters or fewer.';
    end if;
    select * into v_order from public.purchase_orders
    where id = v_order_id and branch_id = v_branch_id and deleted_at is null
    for update;
    if not found then raise exception 'Purchase order not found at your branch.'; end if;
    select * into v_prior_audit from public.audit_log
    where actor_id = v_staff.local_staff_id and branch_id = v_branch_id
      and action = 'purchase_order.cancelled' and entity_id = v_order_id::text
      and details_json->>'idempotencyKey' = v_idempotency_key and deleted_at is null
    limit 1;
    if found then return jsonb_build_object('id', v_order_id, 'status', 'cancelled', 'duplicate', true); end if;
    if v_order.status not in ('ordered', 'partially_received') then
      raise exception 'Only an open purchase order can be cancelled.';
    end if;
    update public.purchase_orders
    set status = 'cancelled', updated_at = v_now, server_updated_at = v_now
    where id = v_order_id;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'purchase_order.cancelled',
      'purchase_order', v_order_id::text,
      jsonb_build_object('reason', v_reason, 'previousStatus', v_order.status, 'idempotencyKey', v_idempotency_key),
      v_now, v_now
    );
    return jsonb_build_object('id', v_order_id, 'status', 'cancelled');
  end if;

  if p_action = 'receive_order' then
    begin
      v_order_id := (p_payload->>'orderId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid purchase order.';
    end;
    select * into v_order from public.purchase_orders
    where id = v_order_id and branch_id = v_branch_id and deleted_at is null
    for update;
    if not found then raise exception 'Purchase order not found at your branch.'; end if;
    if v_order.status not in ('ordered', 'partially_received') then
      raise exception 'This purchase order is not open for receiving.';
    end if;

    select * into v_existing from public.purchase_receipts
    where client_receipt_id = v_idempotency_key and deleted_at is null
    limit 1;
    if found then
      if v_existing.purchase_order_id <> v_order_id or v_existing.branch_id <> v_branch_id then
        raise exception 'This receipt request key is already linked to another purchase order.';
      end if;
      return jsonb_build_object(
        'duplicate', true, 'id', v_existing.id, 'subtotalPaisa', v_existing.subtotal_paisa
      );
    end if;
    if jsonb_typeof(p_payload->'items') is distinct from 'array' then
      raise exception 'A purchase order receipt must contain products.';
    end if;
    select count(*) into v_item_count from jsonb_array_elements(p_payload->'items');
    if v_item_count < 1 or v_item_count > 200 then
      raise exception 'A purchase order receipt must contain between 1 and 200 products.';
    end if;
    for v_item in select value from jsonb_array_elements(p_payload->'items') loop
      if jsonb_typeof(v_item) <> 'object'
         or coalesce(v_item->>'productId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or coalesce(v_item->>'quantityMilli', '') !~ '^[0-9]+$' then
        raise exception 'Enter valid received quantities for every order line.';
      end if;
    end loop;
    select count(*), count(distinct (item.value->>'productId')::uuid)
    into v_seen_count, v_unique_count
    from jsonb_array_elements(p_payload->'items') item(value);
    if v_seen_count <> v_unique_count then
      raise exception 'Each product can only appear once per receipt.';
    end if;

    for v_product_id in
      select product.id
      from public.products product
      where product.id in (
        select (item.value->>'productId')::uuid
        from jsonb_array_elements(p_payload->'items') item(value)
      )
      order by product.id
      for update
    loop
      v_saved_lines := coalesce(v_saved_lines, 0) + 1;
    end loop;
    if v_saved_lines <> v_item_count then
      raise exception 'A received product is no longer available.';
    end if;

    v_receipt_id := gen_random_uuid();
    v_invoice := nullif(left(btrim(coalesce(p_payload->>'supplierInvoiceNumber', '')), 100), '');
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    insert into public.purchase_receipts (
      id, branch_id, supplier_id, supplier_invoice_number, subtotal_paisa, notes,
      received_by, received_at, purchase_order_id, client_receipt_id, created_at, server_updated_at
    ) values (
      v_receipt_id, v_branch_id, v_order.supplier_id, v_invoice, 0, v_notes,
      v_staff.local_staff_id, v_now, v_order_id, v_idempotency_key, v_now, v_now
    );
    for v_item in select value from jsonb_array_elements(p_payload->'items') loop
      v_product_id := (v_item->>'productId')::uuid;
      v_quantity := (v_item->>'quantityMilli')::bigint;
      if v_quantity < 1 or v_quantity > 9007199254740991 then
        raise exception 'Received quantities must be positive and within the supported range.';
      end if;
      select * into v_order_item from public.purchase_order_items
      where order_id = v_order_id and product_id = v_product_id and deleted_at is null
      for update;
      if not found then raise exception 'A received product is not part of this purchase order.'; end if;
      v_remaining := v_order_item.ordered_quantity_milli - v_order_item.received_quantity_milli;
      if v_quantity > v_remaining then
        raise exception '% can receive only % milli-units more.', v_order_item.product_name, v_remaining;
      end if;
      select * into v_product from public.products where id = v_product_id and deleted_at is null;
      select coalesce(sum(return_item.quantity_milli), 0)::bigint into v_returned_replacement
      from public.supplier_return_items return_item
      join public.supplier_returns return_record on return_record.id = return_item.return_id
      join public.purchase_receipts original_receipt on original_receipt.id = return_record.receipt_id
      where original_receipt.purchase_order_id = v_order_id
        and return_item.product_id = v_product_id
        and return_record.disposition = 'replacement'
        and return_record.branch_id = v_branch_id
        and return_record.deleted_at is null
        and return_item.deleted_at is null;
      select coalesce(sum(receipt_item.replacement_quantity_milli), 0)::bigint into v_replacement_received
      from public.purchase_receipt_items receipt_item
      join public.purchase_receipts replacement_receipt on replacement_receipt.id = receipt_item.receipt_id
      where replacement_receipt.purchase_order_id = v_order_id
        and receipt_item.product_id = v_product_id
        and receipt_item.replacement_quantity_milli > 0
        and replacement_receipt.deleted_at is null
        and receipt_item.deleted_at is null;
      v_replacement := least(v_quantity, greatest(0, v_returned_replacement - v_replacement_received));
      v_payable := v_quantity - v_replacement;
      v_line_total := floor((v_order_item.unit_cost_paisa::numeric * v_payable + 500) / 1000)::bigint;
      if v_line_total > 9007199254740991 or v_subtotal + v_line_total > 9007199254740991 then
        raise exception 'Purchase receipt total is too large.';
      end if;
      v_subtotal := v_subtotal + v_line_total;
      insert into public.purchase_receipt_items (
        id, receipt_id, product_id, product_name, unit_code, quantity_milli,
        unit_cost_paisa, line_total_paisa, replacement_quantity_milli, server_updated_at
      ) values (
        gen_random_uuid(), v_receipt_id, v_product_id, v_order_item.product_name, v_order_item.unit_code,
        v_quantity, v_order_item.unit_cost_paisa, v_line_total, v_replacement, v_now
      );
      v_movement_id := gen_random_uuid();
      insert into public.stock_movements (
        id, idempotency_key, branch_id, product_id, movement_type, quantity_delta_milli,
        unit_cost_paisa, reference_type, reference_id, created_by, notes, occurred_at, created_at, server_updated_at
      ) values (
        v_movement_id, 'purchase:' || v_receipt_id::text || ':' || v_product_id::text,
        v_branch_id, v_product_id, 'purchase_receipt', v_quantity, v_order_item.unit_cost_paisa,
        'purchase_receipt', v_receipt_id::text, v_staff.local_staff_id,
        coalesce(v_notes, 'Received against ' || v_order_id::text), v_now, v_now, v_now
      );
      update public.purchase_order_items
      set received_quantity_milli = received_quantity_milli + v_quantity,
          server_updated_at = v_now
      where id = v_order_item.id;
      update public.products
      set cost_price_paisa = v_order_item.unit_cost_paisa, updated_at = v_now, server_updated_at = v_now
      where id = v_product_id;
    end loop;

    update public.purchase_receipts
    set subtotal_paisa = v_subtotal, server_updated_at = v_now
    where id = v_receipt_id;
    select count(*) into v_saved_lines
    from public.purchase_order_items
    where order_id = v_order_id and received_quantity_milli < ordered_quantity_milli and deleted_at is null;
    v_order_status := case when v_saved_lines > 0 then 'partially_received' else 'received' end;
    update public.purchase_orders
    set status = v_order_status, updated_at = v_now, server_updated_at = v_now
    where id = v_order_id;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'purchase_order.receipt_recorded',
      'purchase_order', v_order_id::text,
      jsonb_build_object(
        'receiptId', v_receipt_id, 'clientReceiptId', v_idempotency_key,
        'supplierInvoiceNumber', v_invoice, 'subtotalPaisa', v_subtotal,
        'itemCount', v_item_count, 'status', v_order_status
      ),
      v_now, v_now
    );
    return jsonb_build_object(
      'duplicate', false, 'id', v_receipt_id, 'subtotalPaisa', v_subtotal,
      'itemCount', v_item_count, 'status', v_order_status
    );
  end if;

  begin
    v_receipt_id := (p_payload->>'receiptId')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid purchase receipt.';
  end;
  select * into v_receipt from public.purchase_receipts
  where id = v_receipt_id and branch_id = v_branch_id and deleted_at is null
  for update;
  if not found then raise exception 'Purchase receipt not found at your branch.'; end if;

  if p_action = 'supplier_payment' then
    select * into v_prior_audit from public.audit_log
    where actor_id = v_staff.local_staff_id and branch_id = v_branch_id
      and action = 'supplier_payment.recorded'
      and details_json->>'idempotencyKey' = v_idempotency_key
      and details_json->>'receiptId' = v_receipt.id::text
      and deleted_at is null
    limit 1;
    if found then
      select (v_prior_audit.details_json->>'amountPaisa')::bigint into v_payment_amount;
      select coalesce(sum(payment.amount_paisa), 0)::bigint into v_paid
      from public.supplier_payments payment
      where payment.receipt_id = v_receipt.id and payment.branch_id = v_branch_id and payment.deleted_at is null;
      select coalesce(sum(return_record.total_paisa), 0)::bigint into v_credit
      from public.supplier_returns return_record
      where return_record.receipt_id = v_receipt.id and return_record.branch_id = v_branch_id
        and return_record.disposition = 'credit' and return_record.deleted_at is null;
      return jsonb_build_object(
        'id', v_prior_audit.entity_id::uuid, 'paidPaisa', v_paid,
        'duePaisa', v_receipt.subtotal_paisa - v_paid - v_credit, 'duplicate', true
      );
    end if;
    v_method := p_payload->>'method';
    if v_method is null or v_method not in ('cash', 'bank_transfer', 'card', 'jazzcash', 'easypaisa', 'other') then
      raise exception 'Choose a supported supplier payment method.';
    end if;
    if coalesce(p_payload->>'amountPaisa', '') !~ '^[0-9]+$' then
      raise exception 'Enter a valid payment amount.';
    end if;
    v_payment_amount := (p_payload->>'amountPaisa')::bigint;
    if v_payment_amount < 1 then raise exception 'Payment amount must be greater than zero.'; end if;
    select coalesce(sum(payment.amount_paisa), 0)::bigint into v_paid
    from public.supplier_payments payment
    where payment.receipt_id = v_receipt_id and payment.branch_id = v_branch_id and payment.deleted_at is null;
    select coalesce(sum(return_record.total_paisa), 0)::bigint into v_credit
    from public.supplier_returns return_record
    where return_record.receipt_id = v_receipt_id
      and return_record.branch_id = v_branch_id
      and return_record.disposition = 'credit'
      and return_record.deleted_at is null;
    v_due := v_receipt.subtotal_paisa - v_paid - v_credit;
    if v_due <= 0 then raise exception 'This invoice has no outstanding balance after supplier returns.'; end if;
    if v_payment_amount > v_due then raise exception 'Payment cannot exceed the outstanding balance of % paisa.', v_due; end if;
    v_reference := nullif(left(btrim(coalesce(p_payload->>'reference', '')), 100), '');
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    v_receipt_id := gen_random_uuid();
    insert into public.supplier_payments (
      id, branch_id, receipt_id, method, amount_paisa, reference, notes, paid_by, paid_at, created_at, server_updated_at
    ) values (
      v_receipt_id, v_branch_id, (p_payload->>'receiptId')::uuid, v_method,
      v_payment_amount, v_reference, v_notes, v_staff.local_staff_id, v_now, v_now, v_now
    );
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'supplier_payment.recorded',
      'supplier_payment', v_receipt_id::text,
      jsonb_build_object(
        'receiptId', p_payload->>'receiptId', 'method', v_method,
        'amountPaisa', v_payment_amount, 'reference', v_reference, 'notes', v_notes,
        'idempotencyKey', v_idempotency_key
      ),
      v_now, v_now
    );
    return jsonb_build_object('id', v_receipt_id, 'paidPaisa', v_paid + v_payment_amount, 'duePaisa', v_due - v_payment_amount);
  end if;

  if p_action = 'supplier_return' then
    v_reason := p_payload->>'reason';
    v_disposition := coalesce(p_payload->>'disposition', 'credit');
    if v_disposition not in ('credit', 'replacement') then raise exception 'Choose supplier credit or replacement.'; end if;
    if v_reason is null or v_reason not in ('damaged', 'quality', 'expired', 'incorrect_item', 'other') then
      raise exception 'Choose a supported supplier return reason.';
    end if;
    if v_disposition = 'replacement' and v_receipt.purchase_order_id is null then
      raise exception 'Only a purchase order delivery can be returned for replacement.';
    end if;
    select * into v_return from public.supplier_returns
    where client_return_id = v_idempotency_key and deleted_at is null
    limit 1;
    if found then
      if v_return.receipt_id <> v_receipt.id or v_return.branch_id <> v_branch_id then
        raise exception 'This return request key is already used for another receipt.';
      end if;
      return jsonb_build_object('duplicate', true, 'id', v_return.id, 'totalPaisa', v_return.total_paisa);
    end if;
    if jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'A supplier return must include product quantities.'; end if;
    select count(*) into v_item_count from jsonb_array_elements(p_payload->'items');
    if v_item_count < 1 or v_item_count > 200 then
      raise exception 'A supplier return must include between 1 and 200 products.';
    end if;
    for v_item in select value from jsonb_array_elements(p_payload->'items') loop
      if jsonb_typeof(v_item) <> 'object'
         or coalesce(v_item->>'receiptItemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or coalesce(v_item->>'quantityMilli', '') !~ '^[0-9]+$' then
        raise exception 'Enter a valid product and return quantity for every line.';
      end if;
    end loop;
    select count(*), count(distinct (item.value->>'receiptItemId')::uuid)
    into v_seen_count, v_unique_count
    from jsonb_array_elements(p_payload->'items') item(value);
    if v_seen_count <> v_unique_count then raise exception 'Each received product can only be returned once per request.'; end if;

    for v_product_id in
      select product.id
      from public.products product
      where product.id in (
        select receipt_item.product_id
        from public.purchase_receipt_items receipt_item
        where receipt_item.receipt_id = v_receipt.id
          and receipt_item.deleted_at is null
          and receipt_item.id in (
            select (item.value->>'receiptItemId')::uuid
            from jsonb_array_elements(p_payload->'items') item(value)
          )
      )
      order by product.id
      for update
    loop
      null;
    end loop;

    v_return_id := gen_random_uuid();
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    v_credit_total := 0;
    insert into public.supplier_returns (
      id, client_return_id, branch_id, supplier_id, receipt_id, reason, disposition,
      notes, total_paisa, returned_by, returned_at, created_at, server_updated_at
    ) values (
      v_return_id, v_idempotency_key, v_branch_id, v_receipt.supplier_id, v_receipt.id,
      v_reason, v_disposition, v_notes, 0, v_staff.local_staff_id, v_now, v_now, v_now
    );
    for v_item in select value from jsonb_array_elements(p_payload->'items') loop
      v_return_item_id := (v_item->>'receiptItemId')::uuid;
      v_quantity := (v_item->>'quantityMilli')::bigint;
      if v_quantity < 1 or v_quantity > 9007199254740991 then
        raise exception 'Return quantities must be positive and within the supported range.';
      end if;
      select * into v_receipt_item from public.purchase_receipt_items
      where id = v_return_item_id and receipt_id = v_receipt.id and deleted_at is null
      for update;
      if not found then raise exception 'A returned product was not part of this purchase receipt.'; end if;
      select coalesce(sum(return_item.quantity_milli), 0)::bigint into v_returned
      from public.supplier_return_items return_item
      join public.supplier_returns return_record on return_record.id = return_item.return_id
      where return_item.receipt_item_id = v_return_item_id
        and return_record.branch_id = v_branch_id
        and return_record.deleted_at is null
        and return_item.deleted_at is null;
      if v_quantity > v_receipt_item.quantity_milli - v_returned then
        raise exception '% exceeds the quantity remaining from this receipt.', v_receipt_item.product_name;
      end if;

      select * into v_product from public.products
      where id = v_receipt_item.product_id and deleted_at is null for update;
      v_reserved := 0;
      select coalesce(sum((line.value->>'quantityMilli')::bigint), 0)::bigint into v_reserved
      from jsonb_array_elements(p_payload->'items') line(value)
      join public.purchase_receipt_items other_item
        on other_item.id = (line.value->>'receiptItemId')::uuid
      where other_item.product_id = v_product.id
        and other_item.id < v_return_item_id;
      select coalesce(sum(movement.quantity_delta_milli), 0)::bigint into v_stock
      from public.stock_movements movement
      where movement.product_id = v_product.id and movement.branch_id = v_branch_id and movement.deleted_at is null;
      if v_quantity + v_reserved > v_stock then
        raise exception 'Insufficient branch stock to return %.', v_receipt_item.product_name;
      end if;
      v_line_total := floor((v_receipt_item.unit_cost_paisa::numeric * v_quantity + 500) / 1000)::bigint;
      if v_line_total > 9007199254740991 then raise exception 'Supplier return line total is too large.'; end if;
      select coalesce(sum(return_item.quantity_milli), 0)::bigint into v_prior_credited
      from public.supplier_return_items return_item
      join public.supplier_returns return_record on return_record.id = return_item.return_id
      where return_item.receipt_item_id = v_return_item_id
        and return_record.disposition = 'credit'
        and return_record.deleted_at is null
        and return_item.deleted_at is null;
      v_creditable := least(v_quantity, greatest(
        0,
        v_receipt_item.quantity_milli - v_receipt_item.replacement_quantity_milli - v_prior_credited
      ));
      v_credit_total := v_credit_total + floor((v_receipt_item.unit_cost_paisa::numeric * v_creditable + 500) / 1000)::bigint;
      insert into public.supplier_return_items (
        id, return_id, receipt_item_id, product_id, product_name, unit_code,
        quantity_milli, unit_cost_paisa, line_total_paisa, server_updated_at
      ) values (
        gen_random_uuid(), v_return_id, v_return_item_id, v_receipt_item.product_id,
        v_receipt_item.product_name, v_receipt_item.unit_code, v_quantity,
        v_receipt_item.unit_cost_paisa, v_line_total, v_now
      );
      v_movement_id := gen_random_uuid();
      insert into public.stock_movements (
        id, idempotency_key, branch_id, product_id, movement_type, quantity_delta_milli,
        unit_cost_paisa, reference_type, reference_id, created_by, notes, occurred_at, created_at, server_updated_at
      ) values (
        v_movement_id, 'supplier-return:' || v_return_id::text || ':' || v_product.id::text,
        v_branch_id, v_product.id, 'adjustment', -v_quantity, v_receipt_item.unit_cost_paisa,
        'supplier_return', v_return_id::text, v_staff.local_staff_id,
        'Supplier return (' || v_reason || '): ' || coalesce(v_notes, 'No additional notes'),
        v_now, v_now, v_now
      );
      if v_disposition = 'replacement' then
        update public.purchase_order_items
        set received_quantity_milli = received_quantity_milli - v_quantity, server_updated_at = v_now
        where order_id = v_receipt.purchase_order_id
          and product_id = v_product.id
          and received_quantity_milli >= v_quantity
          and deleted_at is null;
        if not found then raise exception '% cannot reopen more quantity than the purchase order has received.', v_receipt_item.product_name; end if;
      end if;
    end loop;
    if v_disposition = 'credit' then v_total := v_credit_total; else v_total := 0; end if;
    update public.supplier_returns
    set total_paisa = v_total, server_updated_at = v_now
    where id = v_return_id;
    if v_disposition = 'replacement' then
      select count(*) into v_saved_lines
      from public.purchase_order_items
      where order_id = v_receipt.purchase_order_id
        and received_quantity_milli < ordered_quantity_milli
        and deleted_at is null;
      update public.purchase_orders
      set status = case when v_saved_lines > 0 then 'partially_received' else 'received' end,
          updated_at = v_now, server_updated_at = v_now
      where id = v_receipt.purchase_order_id;
    end if;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'supplier.return_recorded',
      'supplier_return', v_return_id::text,
      jsonb_build_object(
        'receiptId', v_receipt.id, 'clientReturnId', v_idempotency_key,
        'reason', v_reason, 'disposition', v_disposition, 'totalPaisa', v_total,
        'itemCount', v_item_count, 'notes', v_notes
      ),
      v_now, v_now
    );
    return jsonb_build_object(
      'duplicate', false, 'id', v_return_id, 'totalPaisa', v_total, 'itemCount', v_item_count
    );
  end if;

  raise exception 'Choose a supported purchasing action.';
end;
$$;

revoke all on function public.staff_manage_purchasing(text, jsonb) from public, anon;
grant execute on function public.staff_manage_purchasing(text, jsonb) to authenticated;

commit;
