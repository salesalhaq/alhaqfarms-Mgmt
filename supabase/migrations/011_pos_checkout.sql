begin;

create unique index if not exists ux_pos_sales_client_sale_id
  on public."pos_sales" (client_sale_id)
  where deleted_at is null;

create or replace function public.staff_complete_pos_sale(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.cloud_staff;
  v_branch_id uuid;
  v_shift public.pos_shifts;
  v_now timestamptz := now();
  v_client_sale_id text;
  v_existing public.pos_sales;
  v_held_sale_id uuid;
  v_held public.pos_held_sales;
  v_customer public.customer_accounts;
  v_customer_account_id uuid;
  v_customer_balance bigint := 0;
  v_loyalty_points integer := 0;
  v_loyalty_balance bigint := 0;
  v_loyalty_discount bigint := 0;
  v_loyalty_earned integer := 0;
  v_sale_id uuid;
  v_invoice_id uuid;
  v_receipt_number text;
  v_prefix text;
  v_tax_mode text;
  v_items jsonb;
  v_payments jsonb;
  v_item jsonb;
  v_payment jsonb;
  v_product record;
  v_stock record;
  v_prepared jsonb := '[]'::jsonb;
  v_final_lines jsonb := '[]'::jsonb;
  v_quantity bigint;
  v_available bigint;
  v_unit_price bigint;
  v_line_subtotal bigint;
  v_line_cost bigint;
  v_subtotal bigint := 0;
  v_bill_discount bigint := 0;
  v_discount_remaining bigint := 0;
  v_subtotal_remaining bigint := 0;
  v_discount_for_line bigint;
  v_net bigint;
  v_tax_rate bigint;
  v_tax bigint;
  v_tax_total bigint := 0;
  v_cost_total bigint := 0;
  v_total bigint;
  v_payment_total bigint := 0;
  v_paid_total bigint := 0;
  v_credit_total bigint := 0;
  v_cash_change bigint := 0;
  v_amount bigint;
  v_tendered bigint;
  v_method text;
  v_reference text;
  v_index integer := 0;
  v_count integer;
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid sale.';
  end if;

  if v_staff.branch_id is not null then
    v_branch_id := v_staff.branch_id;
  else
    begin
      v_branch_id := (p_payload->>'branchId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid branch.';
    end;
  end if;
  if v_branch_id is null or not public.has_branch_access(v_branch_id) then
    raise exception 'You cannot access that branch.';
  end if;

  v_client_sale_id := nullif(btrim(p_payload->>'clientSaleId'), '');
  if v_client_sale_id is null or length(v_client_sale_id) > 100 then
    raise exception 'A valid sale id is required.';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_client_sale_id));
  select * into v_existing
  from public.pos_sales
  where client_sale_id = v_client_sale_id and deleted_at is null
  limit 1;
  if found then
    return jsonb_build_object(
      'duplicate', true,
      'id', v_existing.id,
      'receiptNumber', v_existing.receipt_number,
      'subtotalPaisa', v_existing.subtotal_paisa,
      'taxPaisa', v_existing.tax_paisa,
      'taxMode', v_existing.tax_mode,
      'totalPaisa', v_existing.total_paisa,
      'paidPaisa', v_existing.paid_paisa,
      'duePaisa', v_existing.due_paisa,
      'changePaisa', v_existing.change_paisa,
      'loyaltyEarned', v_existing.loyalty_earned,
      'loyaltyRedeemed', v_existing.loyalty_redeemed,
      'loyaltyDiscountPaisa', v_existing.loyalty_discount_paisa,
      'customerName', v_existing.customer_name
    );
  end if;

  v_items := p_payload->'items';
  v_payments := p_payload->'payments';
  if coalesce(jsonb_typeof(v_items), '') <> 'array' then
    raise exception 'The basket must contain between 1 and 200 product lines.';
  end if;
  if jsonb_array_length(v_items) < 1 or jsonb_array_length(v_items) > 200 then
    raise exception 'The basket must contain between 1 and 200 product lines.';
  end if;
  if coalesce(jsonb_typeof(v_payments), '') <> 'array' then
    raise exception 'Add between 1 and 10 payments.';
  end if;
  if jsonb_array_length(v_payments) < 1 or jsonb_array_length(v_payments) > 10 then
    raise exception 'Add between 1 and 10 payments.';
  end if;
  v_tax_mode := coalesce(p_payload->>'taxMode', 'inclusive');
  if v_tax_mode not in ('inclusive', 'exclusive') then
    raise exception 'Choose a supported tax mode.';
  end if;

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    if coalesce(v_item->>'productId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Choose a valid product.';
    end if;
    if coalesce(v_item->>'quantityMilli', '') !~ '^[1-9]\d{0,4}$' then
      raise exception 'Sale quantities must be positive and within the supported range.';
    end if;
  end loop;

  perform product.id
  from public.products product
  where product.id in (
    select (line.value->>'productId')::uuid
    from jsonb_array_elements(v_items) line(value)
    where coalesce(line.value->>'productId', '') ~* '^[0-9a-f-]{36}$'
  )
  order by product.id
  for update;

  for v_stock in
    select (line.value->>'productId')::uuid as product_id,
           sum((line.value->>'quantityMilli')::bigint) as quantity_milli
    from jsonb_array_elements(v_items) line(value)
    group by (line.value->>'productId')::uuid
  loop
    if v_stock.quantity_milli <= 0 then raise exception 'Sale quantities must be positive.'; end if;
    select coalesce(sum(movement.quantity_delta_milli), 0)::bigint
    into v_available
    from public.stock_movements movement
    where movement.product_id = v_stock.product_id
      and movement.branch_id = v_branch_id
      and movement.deleted_at is null;
    if v_available < v_stock.quantity_milli then
      raise exception 'Insufficient stock: % milli-units available.', v_available;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    begin
      v_quantity := (v_item->>'quantityMilli')::bigint;
      select product.id, product.name, product.sku, product.barcode, product.unit_code,
             product.price_paisa, product.on_sale, product.discounted_price_paisa,
             product.cost_price_paisa, coalesce(product.tax_rate_bps, 0) as tax_rate_bps,
             product.is_active, category.name as category_name
      into v_product
      from public.products product
      left join public.categories category
        on category.id = product.category_id and category.deleted_at is null
      where product.id = (v_item->>'productId')::uuid
        and product.deleted_at is null
      for update of product;
    exception when invalid_text_representation or no_data_found then
      raise exception 'A basket product is no longer available.';
    end;
    if v_product.id is null then raise exception 'A basket product is no longer available.'; end if;
    if v_quantity < 1 then raise exception 'Sale quantities must be positive.'; end if;
    if not v_product.is_active then raise exception 'A basket product is no longer active.'; end if;
    if upper(btrim(coalesce(v_product.category_name, ''))) like 'RAW%' then
      raise exception 'Products in categories starting with RAW cannot be sold at the POS.';
    end if;
    v_unit_price := case
      when v_product.on_sale and v_product.discounted_price_paisa is not null then v_product.discounted_price_paisa
      else v_product.price_paisa
    end;
    if v_unit_price < 0 or v_unit_price > 9000000000000000 then
      raise exception 'A product price is outside the supported range.';
    end if;
    if coalesce(v_product.cost_price_paisa, 0) < 0
      or coalesce(v_product.cost_price_paisa, 0) > 9000000000000000 then
      raise exception 'A product cost is outside the supported range.';
    end if;
    v_line_subtotal := floor((v_unit_price::numeric * v_quantity::numeric) / 1000 + 0.5)::bigint;
    if v_line_subtotal > 9000000000000000 or v_subtotal > 9000000000000000 - v_line_subtotal then
      raise exception 'Sale total exceeds the supported amount.';
    end if;
    v_subtotal := v_subtotal + v_line_subtotal;
    v_prepared := v_prepared || jsonb_build_array(jsonb_build_object(
      'productId', v_product.id,
      'productName', v_product.name,
      'sku', v_product.sku,
      'barcode', v_product.barcode,
      'unitCode', v_product.unit_code,
      'quantityMilli', v_quantity,
      'unitPricePaisa', v_unit_price,
      'unitCostPaisa', coalesce(v_product.cost_price_paisa, 0),
      'taxRateBps', greatest(0, least(v_product.tax_rate_bps, 10000)),
      'lineSubtotalPaisa', v_line_subtotal
    ));
  end loop;

  if coalesce(p_payload->>'billDiscountPaisa', '0') !~ '^\d{1,15}$' then
    raise exception 'Bill discount must be a non-negative whole number of paisa.';
  end if;
  v_bill_discount := (coalesce(p_payload->>'billDiscountPaisa', '0'))::bigint;
  if v_bill_discount > v_subtotal then raise exception 'Bill discount cannot exceed the sale subtotal.'; end if;
  if coalesce(p_payload->>'loyaltyPointsRedeemed', '0') !~ '^\d{1,9}$' then
    raise exception 'Loyalty points must be a non-negative whole number.';
  end if;
  v_loyalty_points := (coalesce(p_payload->>'loyaltyPointsRedeemed', '0'))::integer;
  begin
    v_customer_account_id := nullif(p_payload->>'customerAccountId', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid customer account.';
  end;
  if v_customer_account_id is not null then
    select * into v_customer
    from public.customer_accounts
    where id = v_customer_account_id
      and branch_id = v_branch_id
      and is_active
      and deleted_at is null
    for update;
    if not found then raise exception 'Customer account is not active at this branch.'; end if;
    execute 'select public.staff_pos_customer_loyalty_balance($1, $2)::bigint'
      into v_loyalty_balance
      using v_customer_account_id, v_branch_id;
    if v_loyalty_points > greatest(v_loyalty_balance, 0) then
      raise exception 'Customer does not have enough loyalty points.';
    end if;
  elsif v_loyalty_points > 0 then
    raise exception 'Select a customer account before redeeming loyalty points.';
  end if;
  v_loyalty_discount := v_loyalty_points::bigint * 100;
  if v_loyalty_discount > v_subtotal - v_bill_discount then
    raise exception 'Loyalty points cannot exceed the amount remaining after discounts.';
  end if;

  v_discount_remaining := v_bill_discount + v_loyalty_discount;
  v_subtotal_remaining := v_subtotal;
  select count(*) into v_count from jsonb_array_elements(v_prepared);
  for v_item in
    select value from jsonb_array_elements(v_prepared) with ordinality as lines(value, ordinal) order by ordinal
  loop
    v_index := v_index + 1;
    v_line_subtotal := (v_item->>'lineSubtotalPaisa')::bigint;
    v_discount_for_line := case
      when v_index = v_count then v_discount_remaining
      when v_subtotal_remaining = 0 then 0
      else floor(v_discount_remaining::numeric * v_line_subtotal::numeric / v_subtotal_remaining)::bigint
    end;
    v_discount_remaining := v_discount_remaining - v_discount_for_line;
    v_subtotal_remaining := v_subtotal_remaining - v_line_subtotal;
    v_net := v_line_subtotal - v_discount_for_line;
    v_tax_rate := (v_item->>'taxRateBps')::bigint;
    v_tax := case
      when v_tax_rate = 0 then 0
      when v_tax_mode = 'inclusive' then
        floor(v_net::numeric * v_tax_rate::numeric / (10000 + v_tax_rate)::numeric + 0.5)::bigint
      else
        floor(v_net::numeric * v_tax_rate::numeric / 10000 + 0.5)::bigint
    end;
    if v_tax > 9000000000000000 or v_tax_total > 9000000000000000 - v_tax then
      raise exception 'Sale tax exceeds the supported amount.';
    end if;
    v_tax_total := v_tax_total + v_tax;
    v_line_cost := floor(
      (v_item->>'unitCostPaisa')::numeric * (v_item->>'quantityMilli')::numeric / 1000 + 0.5
    )::bigint;
    if v_line_cost > 9000000000000000 or v_cost_total > 9000000000000000 - v_line_cost then
      raise exception 'Sale cost exceeds the supported amount.';
    end if;
    v_cost_total := v_cost_total + v_line_cost;
    v_final_lines := v_final_lines || jsonb_build_array(v_item || jsonb_build_object(
      'discountPaisa', v_discount_for_line,
      'taxPaisa', v_tax,
      'lineTotalPaisa', v_net
    ));
  end loop;
  v_total := v_subtotal - v_bill_discount - v_loyalty_discount
    + case when v_tax_mode = 'exclusive' then v_tax_total else 0 end;

  for v_payment in select value from jsonb_array_elements(v_payments)
  loop
    v_method := coalesce(v_payment->>'method', '');
    if v_method not in ('cash', 'card', 'jazzcash', 'easypaisa', 'other', 'credit') then
      raise exception 'Choose a supported payment method.';
    end if;
    if coalesce(v_payment->>'amountPaisa', '') !~ '^[1-9]\d{0,14}$' then
      raise exception 'Each payment must be a positive whole number of paisa.';
    end if;
    v_amount := (v_payment->>'amountPaisa')::bigint;
    v_reference := nullif(left(btrim(coalesce(v_payment->>'reference', '')), 100), '');
    if v_method in ('jazzcash', 'easypaisa') and v_reference is null then
      raise exception 'Enter the mobile payment transaction ID or sender number.';
    end if;
    if v_method = 'cash' then
      if coalesce(v_payment->>'tenderedPaisa', v_payment->>'amountPaisa', '') !~ '^\d{1,15}$' then
        raise exception 'Cash received must be a non-negative whole number of paisa.';
      end if;
      v_tendered := coalesce(v_payment->>'tenderedPaisa', v_payment->>'amountPaisa')::bigint;
      if v_tendered < v_amount then raise exception 'Cash received cannot be less than the cash payment amount.'; end if;
      v_cash_change := v_cash_change + v_tendered - v_amount;
    elsif v_method = 'credit' then
      if v_customer_account_id is null then
        raise exception 'Select a customer account before taking credit.';
      end if;
      v_tendered := null;
      if v_credit_total > 9000000000000000 - v_amount then
        raise exception 'Sale credit exceeds the supported amount.';
      end if;
      v_credit_total := v_credit_total + v_amount;
    else
      v_tendered := v_amount;
    end if;
    if v_method <> 'credit' then
      if v_paid_total > 9000000000000000 - v_amount then
        raise exception 'Paid total exceeds the supported amount.';
      end if;
      v_paid_total := v_paid_total + v_amount;
    end if;
    if v_payment_total > 9000000000000000 - v_amount then
      raise exception 'Payment total exceeds the supported amount.';
    end if;
    v_payment_total := v_payment_total + v_amount;
  end loop;
  if v_payment_total <> v_total then raise exception 'Payments must exactly equal the sale total.'; end if;
  if v_credit_total > 0 then
    if v_customer.credit_limit_paisa <= 0 then
      raise exception 'This customer account has no credit limit configured.';
    end if;
    select coalesce((select sum(invoice.amount_paisa)
      from public.customer_invoices invoice
      where invoice.account_id = v_customer_account_id and invoice.deleted_at is null), 0)
      - coalesce((select sum(payment.amount_paisa)
        from public.customer_payments payment
        where payment.account_id = v_customer_account_id and payment.deleted_at is null), 0)
    into v_customer_balance;
    if v_customer_balance + v_credit_total > v_customer.credit_limit_paisa then
      raise exception 'Customer credit limit would be exceeded.';
    end if;
  end if;
  v_loyalty_earned := case
    when v_customer_account_id is null then 0
    else least(floor(v_total::numeric / 10000), 2147483647)::integer
  end;

  select * into v_shift
  from public.pos_shifts
  where cashier_id = v_staff.local_staff_id
    and branch_id = v_branch_id
    and status = 'open'
    and deleted_at is null
  order by opened_at desc
  limit 1
  for update;
  if not found then raise exception 'Open a shift before completing a sale.'; end if;

  if p_payload ? 'heldSaleId' then
    begin
      v_held_sale_id := (p_payload->>'heldSaleId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid held sale.';
    end;
    select * into v_held
    from public.pos_held_sales
    where id = v_held_sale_id
      and branch_id = v_branch_id
      and cashier_id = v_staff.local_staff_id
      and status = 'resumed'
      and deleted_at is null
    for update;
    if not found then raise exception 'The resumed held sale is no longer available.'; end if;
  end if;

  select receipt_prefix into v_prefix
  from public.branches
  where id = v_branch_id and is_active and deleted_at is null;
  if v_prefix is null then raise exception 'Branch not found or inactive.'; end if;
  v_sale_id := gen_random_uuid();
  v_receipt_number := v_prefix || '-' ||
    to_char(v_now at time zone 'UTC', 'YYMMDDHH24MISS') || '-' ||
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into public.pos_sales (
    id, client_sale_id, receipt_number, branch_id, shift_id, cashier_id, customer_account_id,
    status, tax_mode, subtotal_paisa, item_discount_paisa, bill_discount_paisa,
    discount_paisa, tax_paisa, cost_total_paisa, total_paisa, paid_paisa, due_paisa,
    change_paisa, customer_name, customer_phone, loyalty_earned, loyalty_redeemed,
    loyalty_discount_paisa, completed_at, created_at, updated_at, server_updated_at
  ) values (
    v_sale_id, v_client_sale_id, v_receipt_number, v_branch_id, v_shift.id,
    v_staff.local_staff_id, v_customer_account_id,
    'completed', v_tax_mode, v_subtotal, 0, v_bill_discount,
    v_bill_discount + v_loyalty_discount,
    v_tax_total, v_cost_total, v_total, v_paid_total, v_credit_total, v_cash_change,
    coalesce(v_customer.name, 'Walk-in Customer'), v_customer.phone,
    v_loyalty_earned, v_loyalty_points, v_loyalty_discount,
    v_now, v_now, v_now, v_now
  );

  v_index := 0;
  for v_item in
    select value from jsonb_array_elements(v_final_lines) with ordinality as lines(value, ordinal) order by ordinal
  loop
    v_index := v_index + 1;
    insert into public.pos_sale_items (
      id, sale_id, line_number, product_id, product_name, sku, barcode, unit_code,
      quantity_milli, unit_price_paisa, unit_cost_paisa, discount_paisa,
      tax_rate_bps, tax_paisa, line_total_paisa, created_at, server_updated_at
    ) values (
      gen_random_uuid(), v_sale_id, v_index,
      (v_item->>'productId')::uuid, v_item->>'productName', v_item->>'sku',
      v_item->>'barcode', v_item->>'unitCode', (v_item->>'quantityMilli')::bigint,
      (v_item->>'unitPricePaisa')::bigint, (v_item->>'unitCostPaisa')::bigint,
      (v_item->>'discountPaisa')::bigint, (v_item->>'taxRateBps')::bigint,
      (v_item->>'taxPaisa')::bigint,
      case when v_tax_mode = 'exclusive'
        then (v_item->>'lineTotalPaisa')::bigint + (v_item->>'taxPaisa')::bigint
        else (v_item->>'lineTotalPaisa')::bigint
      end,
      v_now, v_now
    );
    insert into public.stock_movements (
      id, idempotency_key, branch_id, product_id, movement_type, quantity_delta_milli,
      unit_cost_paisa, reference_type, reference_id, created_by, occurred_at, created_at, server_updated_at
    ) values (
      gen_random_uuid(), v_client_sale_id || ':' || (v_item->>'productId') || ':' || v_index::text,
      v_branch_id, (v_item->>'productId')::uuid, 'sale',
      -((v_item->>'quantityMilli')::bigint), (v_item->>'unitCostPaisa')::bigint,
      'pos_sale', v_sale_id::text, v_staff.local_staff_id, v_now, v_now, v_now
    );
  end loop;

  v_index := 0;
  for v_payment in select value from jsonb_array_elements(v_payments)
  loop
    v_index := v_index + 1;
    v_method := v_payment->>'method';
    v_amount := (v_payment->>'amountPaisa')::bigint;
    v_reference := nullif(left(btrim(coalesce(v_payment->>'reference', '')), 100), '');
    v_tendered := case when v_method = 'cash'
      then coalesce(v_payment->>'tenderedPaisa', v_payment->>'amountPaisa')::bigint
      else null
    end;
    insert into public.pos_sale_payments (
      id, sale_id, sequence_number, method, amount_paisa, tendered_paisa,
      reference, created_at, server_updated_at
    ) values (
      gen_random_uuid(), v_sale_id, v_index, v_method, v_amount, v_tendered,
      v_reference, v_now, v_now
    );
  end loop;

  if v_customer_account_id is not null then
    v_invoice_id := gen_random_uuid();
    insert into public.customer_invoices (
      id, account_id, branch_id, invoice_number, invoice_date, description,
      amount_paisa, notes, created_by, created_at, pos_sale_id, server_updated_at
    ) values (
      v_invoice_id, v_customer_account_id, v_branch_id, v_receipt_number,
      (v_now at time zone 'Asia/Karachi')::date, 'POS sale ' || v_receipt_number,
      v_total, null, v_staff.local_staff_id, v_now, v_sale_id, v_now
    );
    for v_payment in select value from jsonb_array_elements(v_payments)
    loop
      if v_payment->>'method' <> 'credit' then
        insert into public.customer_payments (
          id, account_id, branch_id, invoice_id, method, amount_paisa, reference,
          notes, paid_by, paid_at, created_at, server_updated_at
        ) values (
          gen_random_uuid(), v_customer_account_id, v_branch_id, v_invoice_id,
          v_payment->>'method', (v_payment->>'amountPaisa')::bigint,
          nullif(left(btrim(coalesce(v_payment->>'reference', '')), 100), ''),
          'POS sale ' || v_receipt_number, v_staff.local_staff_id, v_now, v_now, v_now
        );
      end if;
    end loop;
  end if;

  insert into public.audit_log (
    id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
  ) values (
    gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'sale.completed',
    'pos_sale', v_sale_id,
    jsonb_build_object(
      'receiptNumber', v_receipt_number,
      'totalPaisa', v_total,
      'taxPaisa', v_tax_total,
      'billDiscountPaisa', v_bill_discount,
      'loyaltyPointsRedeemed', v_loyalty_points,
      'loyaltyDiscountPaisa', v_loyalty_discount,
      'loyaltyEarned', v_loyalty_earned,
      'customerAccountId', v_customer_account_id,
      'creditPaisa', v_credit_total,
      'itemCount', jsonb_array_length(v_final_lines)
    ),
    v_now
  );

  if v_held_sale_id is not null then
    update public.pos_held_sales
    set status = 'completed', updated_at = v_now, server_updated_at = v_now
    where id = v_held_sale_id;
  end if;
  return jsonb_build_object(
    'duplicate', false,
    'id', v_sale_id,
    'receiptNumber', v_receipt_number,
    'subtotalPaisa', v_subtotal,
    'taxPaisa', v_tax_total,
    'taxMode', v_tax_mode,
    'totalPaisa', v_total,
    'paidPaisa', v_paid_total,
    'duePaisa', v_credit_total,
    'changePaisa', v_cash_change,
    'loyaltyEarned', v_loyalty_earned,
    'loyaltyRedeemed', v_loyalty_points,
    'loyaltyDiscountPaisa', v_loyalty_discount,
    'customerName', coalesce(v_customer.name, 'Walk-in Customer')
  );
end;
$$;

revoke all on function public.staff_complete_pos_sale(jsonb) from public, anon;
grant execute on function public.staff_complete_pos_sale(jsonb) to authenticated;

commit;
