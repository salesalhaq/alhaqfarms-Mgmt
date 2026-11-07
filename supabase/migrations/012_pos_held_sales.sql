begin;

create table if not exists public.pos_discount_approvals (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null,
  cashier_id uuid not null,
  cashier_user_id uuid not null,
  items_json jsonb not null,
  bill_discount_paisa bigint not null check (bill_discount_paisa > 0),
  basket_fingerprint text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'used', 'expired')),
  approved_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);

create index if not exists ix_pos_discount_approvals_pending
  on public.pos_discount_approvals (branch_id, status, expires_at);
revoke all on public.pos_discount_approvals from public, anon, authenticated;

create or replace function public.staff_pos_customer_loyalty_balance(
  p_customer_account_id uuid,
  p_branch_id uuid
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select greatest(0, coalesce(sum(
    case
      when sale.status in ('void', 'refunded') or sale.total_paisa <= 0 then 0
      else sale.loyalty_earned
        - floor(sale.loyalty_earned::numeric * least(
          sale.total_paisa,
          greatest(0, coalesce(refunds.refund_paisa, 0))
        ) / sale.total_paisa)::integer
        - sale.loyalty_redeemed
        + floor(sale.loyalty_redeemed::numeric * least(
          sale.total_paisa,
          greatest(0, coalesce(refunds.refund_paisa, 0))
        ) / sale.total_paisa)::integer
    end
  ), 0))::integer
  from public.pos_sales sale
  left join lateral (
    select sum(return_row.refund_total_paisa) as refund_paisa
    from public.returns return_row
    where return_row.sale_id = sale.id
      and return_row.status = 'completed'
      and return_row.deleted_at is null
  ) refunds on true
  where sale.customer_account_id = p_customer_account_id
    and sale.branch_id = p_branch_id
    and sale.deleted_at is null;
$$;
revoke all on function public.staff_pos_customer_loyalty_balance(uuid, uuid) from public, anon, authenticated;

create or replace function public.staff_manage_pos_held_sale(
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
  v_shift public.pos_shifts;
  v_held public.pos_held_sales;
  v_id uuid;
  v_now timestamptz := now();
  v_items jsonb;
  v_payments jsonb;
  v_item jsonb;
  v_payment jsonb;
  v_product record;
  v_discount bigint;
  v_subtotal bigint := 0;
  v_line bigint;
  v_quantity bigint;
  v_items_result jsonb;
  v_result jsonb;
  v_tax_mode text;
  v_method text;
  v_amount text;
  v_tendered text;
  v_customer_account_id uuid;
  v_loyalty_points integer;
  v_customer record;
  v_customer_name text := 'Walk-in Customer';
  v_customer_phone text;
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid held sale action.';
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

  if p_action = 'list' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', held.id,
      'customerName', held.customer_name,
      'customerPhone', held.customer_phone,
      'taxMode', held.tax_mode,
      'items', held.items_json,
      'payments', held.payments_json,
      'billDiscountPaisa', held.bill_discount_paisa,
      'customerAccountId', held.customer_account_id,
      'loyaltyPointsRedeemed', held.loyalty_points_redeemed,
      'updatedAt', held.updated_at
    ) order by held.updated_at desc), '[]'::jsonb)
    into v_result
    from public.pos_held_sales held
    where held.branch_id = v_branch_id
      and held.cashier_id = v_staff.local_staff_id
      and held.status in ('held', 'resumed')
      and held.deleted_at is null;
    return jsonb_build_object('heldSales', v_result);
  elsif p_action = 'save' then
    select * into v_shift
    from public.pos_shifts
    where cashier_id = v_staff.local_staff_id
      and branch_id = v_branch_id
      and status = 'open'
      and deleted_at is null
    order by opened_at desc
    limit 1
    for update;
    if not found then raise exception 'Open a shift before holding a sale.'; end if;

    v_items := p_payload->'items';
    if coalesce(jsonb_typeof(v_items), '') <> 'array' then
      raise exception 'Held sale items must be a list.';
    end if;
    if jsonb_array_length(v_items) < 1 or jsonb_array_length(v_items) > 200 then
      raise exception 'A held sale must contain between 1 and 200 product lines.';
    end if;
    for v_item in select value from jsonb_array_elements(v_items)
    loop
      if coalesce(v_item->>'productId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(v_item->>'quantityMilli', '') !~ '^[1-9]\d{0,4}$' then
        raise exception 'A held sale product or quantity is invalid.';
      end if;
      v_quantity := (v_item->>'quantityMilli')::bigint;
      select product.id, product.price_paisa, product.on_sale, product.discounted_price_paisa,
             category.name as category_name
      into v_product
      from public.products product
      left join public.categories category
        on category.id = product.category_id and category.deleted_at is null
      where product.id = (v_item->>'productId')::uuid
        and product.is_active
        and product.deleted_at is null;
      if not found then raise exception 'A held sale product is no longer active.'; end if;
      if upper(btrim(coalesce(v_product.category_name, ''))) like 'RAW%' then
        raise exception 'Products in categories starting with RAW cannot be held at the POS.';
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_items) other(value)
        where other.value->>'productId' = v_item->>'productId'
        group by other.value->>'productId'
        having count(*) > 1
      ) then
        raise exception 'Each product must appear only once in a held basket.';
      end if;
      v_line := floor((
        case when v_product.on_sale and v_product.discounted_price_paisa is not null
          then v_product.discounted_price_paisa else v_product.price_paisa end
        )::numeric * v_quantity::numeric / 1000 + 0.5)::bigint;
      if v_line > 9000000000000000 or v_subtotal > 9000000000000000 - v_line then
        raise exception 'Held sale subtotal exceeds the supported amount.';
      end if;
      v_subtotal := v_subtotal + v_line;
    end loop;

    if coalesce(p_payload->>'billDiscountPaisa', '0') !~ '^\d{1,15}$' then
      raise exception 'Bill discount must be a non-negative whole number of paisa.';
    end if;
    v_discount := (coalesce(p_payload->>'billDiscountPaisa', '0'))::bigint;
    if v_discount > v_subtotal then raise exception 'Bill discount cannot exceed the sale subtotal.'; end if;
    if v_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000) then
      raise exception 'A manager or administrator must approve this discount before holding the sale.';
    end if;
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
      select account.id, account.name, account.phone, account.is_active,
        public.staff_pos_customer_loyalty_balance(account.id, v_branch_id) as loyalty_points
      into v_customer
      from public.customer_accounts account
      where account.id = v_customer_account_id
        and account.branch_id = v_branch_id
        and account.deleted_at is null;
      if not found or not v_customer.is_active then
        raise exception 'Customer account is not active at this branch.';
      end if;
      if v_loyalty_points > v_customer.loyalty_points then
        raise exception 'Customer does not have enough loyalty points.';
      end if;
      v_customer_name := v_customer.name;
      v_customer_phone := v_customer.phone;
    elsif v_loyalty_points > 0 then
      raise exception 'Select a customer account before redeeming loyalty points.';
    end if;
    if v_discount + v_loyalty_points::bigint * 100 > v_subtotal then
      raise exception 'Discounts and loyalty redemption cannot exceed the held sale subtotal.';
    end if;

    v_payments := p_payload->'payments';
    if coalesce(jsonb_typeof(v_payments), '') <> 'array' then
      raise exception 'A held sale payment list is invalid.';
    end if;
    if jsonb_array_length(v_payments) < 1 or jsonb_array_length(v_payments) > 10 then
      raise exception 'A held sale must have between one and ten payment methods.';
    end if;
    for v_payment in select value from jsonb_array_elements(v_payments)
    loop
      v_method := coalesce(v_payment->>'method', '');
      if v_method not in ('cash', 'card', 'jazzcash', 'easypaisa', 'other', 'credit') then
        raise exception 'Choose a supported payment method.';
      end if;
      v_amount := btrim(coalesce(v_payment->>'amount', ''));
      v_tendered := btrim(coalesce(v_payment->>'tendered', ''));
      if (v_amount <> '' and v_amount !~ '^\d{1,12}(\.\d{1,2})?$')
        or (v_tendered <> '' and v_tendered !~ '^\d{1,12}(\.\d{1,2})?$') then
        raise exception 'Held payment amounts must be valid amounts with up to two decimals.';
      end if;
      if v_method = 'credit' and v_customer_account_id is null then
        raise exception 'Select a customer account before taking credit.';
      end if;
    end loop;

    v_tax_mode := coalesce(p_payload->>'taxMode', 'inclusive');
    if v_tax_mode not in ('inclusive', 'exclusive') then
      raise exception 'Choose a supported tax mode.';
    end if;
    begin
      v_id := nullif(p_payload->>'id', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid held sale.';
    end;
    if v_id is null then v_id := gen_random_uuid(); end if;
    select * into v_held
    from public.pos_held_sales
    where id = v_id
      and cashier_id = v_staff.local_staff_id
      and branch_id = v_branch_id
      and status in ('held', 'resumed')
      and deleted_at is null
    for update;
    if p_payload ? 'id' and not found then
      raise exception 'Held sale not found or not owned by this staff account.';
    end if;

    if v_held.id is null then
      insert into public.pos_held_sales (
        id, branch_id, cashier_id, shift_id, customer_name, customer_phone, tax_mode,
        items_json, payments_json, status, created_at, updated_at, bill_discount_paisa,
        customer_account_id, loyalty_points_redeemed, server_updated_at
      ) values (
        v_id, v_branch_id, v_staff.local_staff_id, v_shift.id,
        v_customer_name, v_customer_phone,
        v_tax_mode, v_items, v_payments, 'held', v_now, v_now, v_discount,
        v_customer_account_id, v_loyalty_points, v_now
      );
    else
      update public.pos_held_sales
      set shift_id = v_shift.id,
          tax_mode = v_tax_mode,
          items_json = v_items,
          payments_json = v_payments,
          bill_discount_paisa = v_discount,
          customer_name = v_customer_name,
          customer_phone = v_customer_phone,
          customer_account_id = v_customer_account_id,
          loyalty_points_redeemed = v_loyalty_points,
          status = 'held',
          updated_at = v_now,
          server_updated_at = v_now
      where id = v_id;
    end if;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id,
      case when v_held.id is null then 'sale.held' else 'sale.unheld' end,
      'pos_held_sale', v_id, jsonb_build_object('itemCount', jsonb_array_length(v_items)), v_now
    );
    return jsonb_build_object('id', v_id, 'itemCount', jsonb_array_length(v_items));
  elsif p_action = 'resume' then
    begin
      v_id := (p_payload->>'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid held sale.';
    end;
    select * into v_held
    from public.pos_held_sales
    where id = v_id
      and branch_id = v_branch_id
      and cashier_id = v_staff.local_staff_id
      and status in ('held', 'resumed')
      and deleted_at is null
    for update;
    if not found then raise exception 'Held sale not found or not owned by this staff account.'; end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'product', jsonb_build_object(
        'id', product.id,
        'name', product.name,
        'sku', product.sku,
        'barcode', product.barcode,
        'category_id', product.category_id,
        'category_name', category.name,
        'image_path', product.image_path,
        'unit_code', product.unit_code,
        'price_paisa', product.price_paisa,
        'on_sale', product.on_sale,
        'discounted_price_paisa', product.discounted_price_paisa,
        'tax_rate_bps', coalesce(product.tax_rate_bps, 0),
        'is_active', product.is_active,
        'stock_milli', coalesce(stock.quantity_milli, 0)
      ),
      'quantityMilli', (line.value->>'quantityMilli')::bigint
    ) order by line.ordinal), '[]'::jsonb)
    into v_items_result
    from jsonb_array_elements(v_held.items_json) with ordinality as line(value, ordinal)
    join public.products product
      on product.id = (line.value->>'productId')::uuid
      and product.is_active
      and product.deleted_at is null
    left join public.categories category
      on category.id = product.category_id and category.deleted_at is null
    left join lateral (
      select sum(movement.quantity_delta_milli)::bigint as quantity_milli
      from public.stock_movements movement
      where movement.product_id = product.id
        and movement.branch_id = v_branch_id
        and movement.deleted_at is null
    ) stock on true
    where upper(btrim(coalesce(category.name, ''))) not like 'RAW%';
    if jsonb_array_length(v_items_result) <> jsonb_array_length(v_held.items_json) then
      raise exception 'A held sale includes a product that is no longer available.';
    end if;
    update public.pos_held_sales
    set status = 'resumed', updated_at = v_now, server_updated_at = v_now
    where id = v_id;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, occurred_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id,
      'sale.resumed', 'pos_held_sale', v_id, v_now
    );
    return jsonb_build_object('held', jsonb_build_object(
      'id', v_held.id,
      'taxMode', v_held.tax_mode,
      'items', v_items_result,
      'payments', v_held.payments_json,
      'billDiscountPaisa', v_held.bill_discount_paisa,
      'customerAccountId', v_held.customer_account_id,
      'loyaltyPointsRedeemed', v_held.loyalty_points_redeemed
    ));
  elsif p_action = 'delete' then
    begin
      v_id := (p_payload->>'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid held sale.';
    end;
    update public.pos_held_sales
    set deleted_at = v_now, updated_at = v_now, server_updated_at = v_now
    where id = v_id
      and branch_id = v_branch_id
      and cashier_id = v_staff.local_staff_id
      and status in ('held', 'resumed')
      and deleted_at is null;
    if not found then raise exception 'Held sale not found or not owned by this staff account.'; end if;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, occurred_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id,
      'sale.held_deleted', 'pos_held_sale', v_id, v_now
    );
    return jsonb_build_object('id', v_id, 'deleted', true);
  end if;

  raise exception 'Unsupported held sale action.';
end;
$$;

create or replace function public.get_staff_pos_tax_rates(
  p_branch_id uuid,
  p_product_ids uuid[]
)
returns table(product_id uuid, tax_rate_bps integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.cloud_staff;
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;
  if p_branch_id is null or not public.has_branch_access(p_branch_id) then
    raise exception 'You cannot access that branch.';
  end if;
  if p_product_ids is null or cardinality(p_product_ids) > 200 then
    raise exception 'Choose a valid product list.';
  end if;

  return query
  select product.id, greatest(0, least(coalesce(product.tax_rate_bps, 0), 10000))::integer
  from public.products product
  where product.id = any(p_product_ids)
    and product.is_active
    and product.deleted_at is null;
end;
$$;

create or replace function public.staff_manage_pos_customer(
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
  v_customer_id uuid;
  v_name text;
  v_phone text;
  v_search text;
  v_customers jsonb;
  v_filter_customer_id uuid;
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid customer action.';
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

  if p_action = 'list' then
    v_search := left(btrim(coalesce(p_payload->>'search', '')), 80);
    begin
      v_filter_customer_id := nullif(p_payload->>'customerAccountId', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid customer account.';
    end;
    select coalesce(jsonb_agg(to_jsonb(customer_row) order by customer_row.name), '[]'::jsonb)
    into v_customers
    from (
      select account.id,
        account.name,
        account.phone,
        account.credit_limit_paisa,
        coalesce((select sum(invoice.amount_paisa)
          from public.customer_invoices invoice
          where invoice.account_id = account.id and invoice.deleted_at is null), 0)
        - coalesce((select sum(payment.amount_paisa)
          from public.customer_payments payment
          where payment.account_id = account.id and payment.deleted_at is null), 0) as balance_paisa,
        greatest(0, account.credit_limit_paisa
          - coalesce((select sum(invoice.amount_paisa)
            from public.customer_invoices invoice
            where invoice.account_id = account.id and invoice.deleted_at is null), 0)
          + coalesce((select sum(payment.amount_paisa)
            from public.customer_payments payment
            where payment.account_id = account.id and payment.deleted_at is null), 0)) as available_credit_paisa,
        public.staff_pos_customer_loyalty_balance(account.id, v_branch_id) as loyalty_points
      from public.customer_accounts account
      where account.branch_id = v_branch_id
        and account.is_active
        and account.deleted_at is null
        and (v_filter_customer_id is null or account.id = v_filter_customer_id)
        and (v_search = ''
          or account.name ilike '%' || v_search || '%'
          or coalesce(account.phone, '') ilike '%' || v_search || '%')
      order by account.name
      limit 30
    ) customer_row;
    return jsonb_build_object('customers', v_customers);
  elsif p_action = 'create' then
    v_name := nullif(btrim(p_payload->>'name'), '');
    v_phone := nullif(left(btrim(coalesce(p_payload->>'phone', '')), 50), '');
    if v_name is null or length(v_name) > 200 then
      raise exception 'Enter a customer name of no more than 200 characters.';
    end if;
    perform pg_advisory_xact_lock(hashtext(v_branch_id::text || ':' || lower(v_name)));
    if exists (
      select 1 from public.customer_accounts account
      where account.branch_id = v_branch_id
        and account.is_active
        and account.deleted_at is null
        and lower(account.name) = lower(v_name)
    ) then
      raise exception 'A customer account with this name already exists at your branch.';
    end if;
    v_customer_id := gen_random_uuid();
    insert into public.customer_accounts (
      id, branch_id, name, phone, credit_limit_paisa, is_active, created_by,
      created_at, updated_at, server_updated_at
    ) values (
      v_customer_id, v_branch_id, v_name, v_phone, 0, true, v_staff.local_staff_id,
      now(), now(), now()
    );
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'customer.created_pos',
      'customer_account', v_customer_id, jsonb_build_object('name', v_name), now()
    );
    return jsonb_build_object('customer', jsonb_build_object(
      'id', v_customer_id, 'name', v_name, 'phone', v_phone,
      'credit_limit_paisa', 0, 'balance_paisa', 0,
      'available_credit_paisa', 0, 'loyalty_points', 0
    ));
  end if;
  raise exception 'Unsupported POS customer action.';
end;
$$;

create or replace function public.staff_manage_pos_discount(
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
  v_request_id uuid;
  v_status text;
  v_discount bigint;
  v_quantity bigint;
  v_unit_price bigint;
  v_line bigint;
  v_subtotal bigint := 0;
  v_items jsonb;
  v_item jsonb;
  v_fingerprint text;
  v_normalized_items jsonb;
  v_requests jsonb;
  v_product record;
  v_now timestamptz := now();
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid discount approval action.';
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

  if p_action = 'request' then
    if v_staff.role not in ('cashier', 'manager', 'admin') then
      raise exception 'Your role cannot request a POS discount approval.';
    end if;
    v_items := p_payload->'items';
    if coalesce(jsonb_typeof(v_items), '') <> 'array' then
      raise exception 'The discount request basket is invalid.';
    end if;
    if jsonb_array_length(v_items) < 1 or jsonb_array_length(v_items) > 200 then
      raise exception 'The discount request basket is invalid.';
    end if;
    if coalesce(p_payload->>'billDiscountPaisa', '') !~ '^[1-9]\d{0,14}$' then
      raise exception 'Enter a positive discount amount.';
    end if;
    v_discount := (p_payload->>'billDiscountPaisa')::bigint;
    for v_item in select value from jsonb_array_elements(v_items)
    loop
      if coalesce(v_item->>'productId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(v_item->>'quantityMilli', '') !~ '^[1-9]\d{0,4}$' then
        raise exception 'The discount request contains an invalid product or quantity.';
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_items) other(value)
        where other.value->>'productId' = v_item->>'productId'
        group by other.value->>'productId'
        having count(*) > 1
      ) then
        raise exception 'Each product must appear only once in the discount request.';
      end if;
      v_quantity := (v_item->>'quantityMilli')::bigint;
      select product.price_paisa, product.on_sale, product.discounted_price_paisa,
             category.name as category_name
      into v_product
      from public.products product
      left join public.categories category
        on category.id = product.category_id and category.deleted_at is null
      where product.id = (v_item->>'productId')::uuid
        and product.is_active
        and product.deleted_at is null;
      if not found or upper(btrim(coalesce(v_product.category_name, ''))) like 'RAW%' then
        raise exception 'A discount request product is not available at the POS.';
      end if;
      v_unit_price := case when v_product.on_sale and v_product.discounted_price_paisa is not null
        then v_product.discounted_price_paisa else v_product.price_paisa end;
      v_line := floor(v_unit_price::numeric * v_quantity::numeric / 1000 + 0.5)::bigint;
      if v_line > 9000000000000000 or v_subtotal > 9000000000000000 - v_line then
        raise exception 'Discount request subtotal exceeds the supported amount.';
      end if;
      v_subtotal := v_subtotal + v_line;
    end loop;
    if v_discount > v_subtotal
      or v_discount <= least(floor(v_subtotal::numeric * 0.03)::bigint, 10000) then
      raise exception 'This discount does not require manager approval or exceeds the basket subtotal.';
    end if;
    select jsonb_agg(jsonb_build_object(
      'productId', lower(line.value->>'productId'),
      'quantityMilli', (line.value->>'quantityMilli')::bigint
    ) order by lower(line.value->>'productId'))
    into v_normalized_items
    from jsonb_array_elements(v_items) line(value);
    v_fingerprint := md5(v_normalized_items::text || ':' || v_discount::text);
    update public.pos_discount_approvals
    set status = case when expires_at <= v_now then 'expired' else 'declined' end,
        updated_at = v_now, server_updated_at = v_now
    where cashier_id = v_staff.local_staff_id
      and branch_id = v_branch_id
      and status in ('pending', 'approved');
    v_request_id := gen_random_uuid();
    insert into public.pos_discount_approvals (
      id, branch_id, cashier_id, cashier_user_id, items_json,
      bill_discount_paisa, basket_fingerprint, status, created_at, expires_at,
      updated_at, server_updated_at
    ) values (
      v_request_id, v_branch_id, v_staff.local_staff_id, v_staff.user_id,
      v_normalized_items, v_discount, v_fingerprint, 'pending', v_now,
      v_now + interval '2 minutes', v_now, v_now
    );
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'sale.discount_requested',
      'pos_discount_approval', v_request_id,
      jsonb_build_object('billDiscountPaisa', v_discount, 'subtotalPaisa', v_subtotal), v_now
    );
    return jsonb_build_object('requestId', v_request_id, 'status', 'pending', 'expiresAt', v_now + interval '2 minutes');
  elsif p_action = 'list' then
    if v_staff.role not in ('manager', 'admin') then
      raise exception 'Manager or administrator access is required to review discount requests.';
    end if;
    update public.pos_discount_approvals
    set status = 'expired', updated_at = v_now, server_updated_at = v_now
    where branch_id = v_branch_id and status in ('pending', 'approved') and expires_at <= v_now;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', request.id,
      'cashierName', coalesce(cashier.full_name, 'Cashier'),
      'canReview', request.cashier_id is distinct from v_staff.local_staff_id,
      'billDiscountPaisa', request.bill_discount_paisa,
      'items', request.items_json,
      'expiresAt', request.expires_at
    ) order by request.created_at), '[]'::jsonb)
    into v_requests
    from public.pos_discount_approvals request
    left join public.cloud_staff cashier on cashier.local_staff_id = request.cashier_id
    where request.branch_id = v_branch_id
      and request.status = 'pending'
      and request.expires_at > v_now;
    return jsonb_build_object('requests', v_requests);
  elsif p_action = 'approve' or p_action = 'decline' then
    if v_staff.role not in ('manager', 'admin') then
      raise exception 'Manager or administrator access is required to review discount requests.';
    end if;
    begin
      v_request_id := (p_payload->>'requestId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid discount request.';
    end;
    v_status := case when p_action = 'approve' then 'approved' else 'declined' end;
    if p_action = 'approve' and exists (
      select 1 from public.pos_discount_approvals request
      where request.id = v_request_id
        and request.branch_id = v_branch_id
        and request.cashier_id = v_staff.local_staff_id
        and request.status = 'pending'
        and request.expires_at > v_now
    ) then
      raise exception 'Another staff member must approve your discount request.';
    end if;
    update public.pos_discount_approvals
    set status = v_status, approved_by = case when p_action = 'approve' then v_staff.local_staff_id else null end,
        updated_at = v_now, server_updated_at = v_now
    where id = v_request_id
      and branch_id = v_branch_id
      and status = 'pending'
      and expires_at > v_now;
    if not found then raise exception 'This discount request is no longer pending.'; end if;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, occurred_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id,
      case when p_action = 'approve' then 'sale.discount_approved' else 'sale.discount_declined' end,
      'pos_discount_approval', v_request_id, v_now
    );
    return jsonb_build_object('requestId', v_request_id, 'status', v_status);
  elsif p_action = 'status' then
    begin
      v_request_id := (p_payload->>'requestId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid discount request.';
    end;
    update public.pos_discount_approvals
    set status = 'expired', updated_at = v_now, server_updated_at = v_now
    where id = v_request_id and cashier_id = v_staff.local_staff_id
      and branch_id = v_branch_id and status in ('pending', 'approved')
      and expires_at <= v_now;
    select status into v_status
    from public.pos_discount_approvals
    where id = v_request_id
      and cashier_id = v_staff.local_staff_id
      and branch_id = v_branch_id;
    if not found then raise exception 'Discount approval request not found.'; end if;
    return jsonb_build_object('requestId', v_request_id, 'status', v_status);
  end if;
  raise exception 'Unsupported discount approval action.';
end;
$$;

revoke all on function public.staff_manage_pos_held_sale(text, jsonb) from public, anon;
grant execute on function public.staff_manage_pos_held_sale(text, jsonb) to authenticated;
revoke all on function public.get_staff_pos_tax_rates(uuid, uuid[]) from public, anon;
grant execute on function public.get_staff_pos_tax_rates(uuid, uuid[]) to authenticated;
revoke all on function public.staff_manage_pos_customer(text, jsonb) from public, anon;
grant execute on function public.staff_manage_pos_customer(text, jsonb) to authenticated;
revoke all on function public.staff_manage_pos_discount(text, jsonb) from public, anon;
grant execute on function public.staff_manage_pos_discount(text, jsonb) to authenticated;

commit;
