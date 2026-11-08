begin;

create or replace function public.manage_web_bulk_sale(p_action text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_branch_id uuid;
  v_sale_id uuid;
  v_payment_id uuid;
  v_product_id uuid;
  v_lock_product_id uuid;
  v_product record;
  v_sale public.bulk_sales;
  v_line jsonb;
  v_payment jsonb;
  v_clean_items jsonb := '[]'::jsonb;
  v_clean_payments jsonb := '[]'::jsonb;
  v_product_ids uuid[] := array[]::uuid[];
  v_quantity bigint;
  v_unit_price bigint;
  v_line_total bigint;
  v_calculated numeric;
  v_subtotal numeric := 0;
  v_discount bigint := 0;
  v_total bigint := 0;
  v_paid numeric := 0;
  v_due numeric := 0;
  v_amount bigint;
  v_payment_method text;
  v_reference text;
  v_notes text;
  v_payment_notes text;
  v_sale_date date;
  v_customer_name text;
  v_customer_phone text;
  v_invoice_number text;
  v_stock_balance numeric;
  v_now timestamptz := now();
  v_stamp text;
  v_attempt integer := 0;
begin
  if not public.is_admin_role() then
    raise exception 'Bulk sale actions are restricted to administrators.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid bulk sale action.';
  end if;
  select staff.local_staff_id into v_actor_id
  from public.cloud_staff staff
  where staff.user_id = auth.uid() and staff.is_active;
  if v_actor_id is null then
    raise exception 'Your staff profile is not linked for bulk sale actions.';
  end if;

  if p_action = 'record' then
    begin
      v_branch_id := (p_payload->>'branchId')::uuid;
      if coalesce(p_payload->>'saleDate','') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Sale date must be a valid business date.';
      end if;
      v_sale_date := (p_payload->>'saleDate')::date;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception 'Choose a valid branch and sale date.';
    end;
    if v_branch_id is null or not public.has_branch_access(v_branch_id) or not exists (
      select 1 from public.branches branch
      where branch.id = v_branch_id and branch.is_active and branch.deleted_at is null
    ) then
      raise exception 'Choose an active branch you can access.';
    end if;
    if v_sale_date > (now() at time zone 'Asia/Karachi')::date then
      raise exception 'Sale date cannot be in the future.';
    end if;
    v_customer_name := nullif(btrim(p_payload->>'customerName'),'');
    if v_customer_name is null or length(v_customer_name) > 200 then
      raise exception 'Enter a customer name of up to 200 characters.';
    end if;
    v_customer_phone := nullif(left(btrim(coalesce(p_payload->>'customerPhone','')),50),'');
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes','')),500),'');
    if coalesce(p_payload->>'discountPaisa','0') !~ '^\d{1,15}$' then
      raise exception 'Enter a valid discount.';
    end if;
    v_discount := coalesce((p_payload->>'discountPaisa')::bigint,0);

    if jsonb_typeof(coalesce(p_payload->'items','[]'::jsonb)) <> 'array' then
      raise exception 'Bulk sale items must be a list.';
    end if;
    if jsonb_array_length(coalesce(p_payload->'items','[]'::jsonb)) < 1
      or jsonb_array_length(coalesce(p_payload->'items','[]'::jsonb)) > 200 then
      raise exception 'A bulk sale needs between 1 and 200 product lines.';
    end if;
    for v_line in select value from jsonb_array_elements(p_payload->'items') as lines(value)
    loop
      if jsonb_typeof(v_line) <> 'object' then raise exception 'Each bulk sale line must be an object.'; end if;
      begin
        v_product_id := (v_line->>'productId')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid product.';
      end;
      if v_product_id is null then raise exception 'Choose a product for every line.'; end if;
      if v_product_id = any(v_product_ids) then
        raise exception 'Each product can only appear once per bulk sale.';
      end if;
      if coalesce(v_line->>'quantityMilli','') !~ '^\d{1,15}$'
        or coalesce(v_line->>'unitPricePaisa','') !~ '^\d{1,15}$' then
        raise exception 'Enter a valid quantity and unit price for every line.';
      end if;
      v_quantity := (v_line->>'quantityMilli')::bigint;
      v_unit_price := (v_line->>'unitPricePaisa')::bigint;
      if v_quantity < 1 then raise exception 'Product quantity must be greater than zero.'; end if;
      select product.id,product.name,product.unit_code,product.cost_price_paisa
      into v_product
      from public.products product
      where product.id = v_product_id and product.is_active and product.deleted_at is null
      for share;
      if not found then raise exception 'Choose an active product.'; end if;
      v_calculated := round(v_unit_price::numeric * v_quantity / 1000);
      if v_calculated > 9223372036854775807 then raise exception 'A bulk sale line total is too large.'; end if;
      v_line_total := v_calculated::bigint;
      v_subtotal := v_subtotal + v_line_total;
      if v_subtotal > 9223372036854775807 then raise exception 'Bulk sale subtotal is too large.'; end if;
      v_product_ids := array_append(v_product_ids,v_product_id);
      v_clean_items := v_clean_items || jsonb_build_array(jsonb_build_object(
        'productId',v_product.id,'productName',v_product.name,'unitCode',v_product.unit_code,
        'quantityMilli',v_quantity,'unitPricePaisa',v_unit_price,
        'unitCostPaisa',v_product.cost_price_paisa,'lineTotalPaisa',v_line_total
      ));
    end loop;
    if v_discount > v_subtotal then raise exception 'Discount cannot exceed the invoice subtotal.'; end if;
    v_total := v_subtotal - v_discount;

    if jsonb_typeof(coalesce(p_payload->'payments','[]'::jsonb)) <> 'array' then
      raise exception 'Bulk sale payments must be a list.';
    end if;
    if jsonb_array_length(coalesce(p_payload->'payments','[]'::jsonb)) > 50 then
      raise exception 'A bulk sale can have at most 50 initial payments.';
    end if;
    for v_payment in select value from jsonb_array_elements(coalesce(p_payload->'payments','[]'::jsonb)) as payments(value)
    loop
      if jsonb_typeof(v_payment) <> 'object' then raise exception 'Each payment must be an object.'; end if;
      if coalesce(v_payment->>'amountPaisa','') !~ '^\d{1,15}$' then
        raise exception 'Enter a valid payment amount.';
      end if;
      v_amount := (v_payment->>'amountPaisa')::bigint;
      if v_amount < 1 then continue; end if;
      v_payment_method := coalesce(v_payment->>'method','');
      if v_payment_method not in ('cash','bank_transfer','card','jazzcash','easypaisa','other') then
        raise exception 'Choose a supported bulk sale payment method.';
      end if;
      v_reference := nullif(left(btrim(coalesce(v_payment->>'reference','')),100),'');
      v_payment_notes := nullif(left(btrim(coalesce(v_payment->>'notes','')),500),'');
      v_paid := v_paid + v_amount;
      if v_paid > 9223372036854775807 then raise exception 'Bulk sale payments are too large.'; end if;
      v_clean_payments := v_clean_payments || jsonb_build_array(jsonb_build_object(
        'method',v_payment_method,'amountPaisa',v_amount,'reference',v_reference,'notes',v_payment_notes
      ));
    end loop;
    if v_paid > v_total then raise exception 'Payments cannot exceed the invoice total.'; end if;

    for v_lock_product_id in
      select distinct item from unnest(v_product_ids) as ids(item) order by item
    loop
      perform pg_advisory_xact_lock(hashtext(v_branch_id::text || ':' || v_lock_product_id::text));
    end loop;
    for v_line in select value from jsonb_array_elements(v_clean_items) as lines(value)
    loop
      select coalesce(sum(movement.quantity_delta_milli),0)
      into v_stock_balance
      from public.stock_movements movement
      where movement.branch_id = v_branch_id
        and movement.product_id = (v_line->>'productId')::uuid
        and movement.deleted_at is null;
      if v_stock_balance < (v_line->>'quantityMilli')::bigint then
        raise exception 'Not enough % in stock (% milli-units on hand).',
          v_line->>'productName',v_stock_balance;
      end if;
    end loop;

    v_sale_id := gen_random_uuid();
    v_invoice_number := nullif(left(btrim(coalesce(p_payload->>'invoiceNumber','')),60),'');
    if v_invoice_number is null then
      v_stamp := to_char(v_now at time zone 'Asia/Karachi','YYMMDDHH24MISS');
      loop
        v_invoice_number := 'BLK-' || v_stamp || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
        exit when not exists (
          select 1 from public.bulk_sales
          where branch_id = v_branch_id and invoice_number = v_invoice_number
        );
        v_attempt := v_attempt + 1;
        if v_attempt >= 5 then raise exception 'Could not reserve a unique bulk invoice number.'; end if;
      end loop;
    elsif exists (
      select 1 from public.bulk_sales
      where branch_id = v_branch_id and invoice_number = v_invoice_number
    ) then
      raise exception 'That invoice number is already used at this branch.';
    end if;
    perform pg_advisory_xact_lock(hashtext('bulk-invoice:'||v_branch_id::text||':'||v_invoice_number));
    if exists (
      select 1 from public.bulk_sales
      where branch_id = v_branch_id and invoice_number = v_invoice_number
    ) then
      raise exception 'That invoice number is already used at this branch.';
    end if;

    insert into public.bulk_sales(
      id,branch_id,invoice_number,sale_date,customer_name,customer_phone,
      subtotal_paisa,discount_paisa,total_paisa,notes,created_by,created_at,server_updated_at
    ) values(
      v_sale_id,v_branch_id,v_invoice_number,v_sale_date,v_customer_name,v_customer_phone,
      v_subtotal::bigint,v_discount,v_total,v_notes,v_actor_id,v_now,v_now
    );
    for v_line in select value from jsonb_array_elements(v_clean_items) as lines(value)
    loop
      insert into public.bulk_sale_items(
        id,sale_id,product_id,product_name,unit_code,quantity_milli,unit_price_paisa,
        unit_cost_paisa,line_total_paisa,created_at,server_updated_at
      ) values(
        gen_random_uuid(),v_sale_id,(v_line->>'productId')::uuid,v_line->>'productName',
        v_line->>'unitCode',(v_line->>'quantityMilli')::bigint,(v_line->>'unitPricePaisa')::bigint,
        (v_line->>'unitCostPaisa')::bigint,(v_line->>'lineTotalPaisa')::bigint,v_now,v_now
      );
      insert into public.stock_movements(
        id,idempotency_key,branch_id,product_id,movement_type,quantity_delta_milli,unit_cost_paisa,
        reference_type,reference_id,created_by,notes,occurred_at,created_at,server_updated_at
      ) values(
        gen_random_uuid(),'bulk_sale:'||v_sale_id::text||':'||(v_line->>'productId'),v_branch_id,
        (v_line->>'productId')::uuid,'adjustment',-((v_line->>'quantityMilli')::bigint),
        (v_line->>'unitCostPaisa')::bigint,'bulk_sale',v_sale_id::text,v_actor_id,
        'Bulk sale '||v_invoice_number,v_now,v_now,v_now
      );
    end loop;
    for v_payment in select value from jsonb_array_elements(v_clean_payments) as payments(value)
    loop
      insert into public.bulk_sale_payments(
        id,sale_id,branch_id,method,amount_paisa,reference,notes,paid_by,paid_at,created_at,server_updated_at
      ) values(
        gen_random_uuid(),v_sale_id,v_branch_id,v_payment->>'method',(v_payment->>'amountPaisa')::bigint,
        v_payment->>'reference',v_payment->>'notes',v_actor_id,v_now,v_now,v_now
      );
    end loop;
    insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
    values(
      gen_random_uuid(),v_actor_id,v_branch_id,'bulk_sale.recorded','bulk_sale',v_sale_id::text,
      jsonb_build_object('invoiceNumber',v_invoice_number,'customerName',v_customer_name,
        'totalPaisa',v_total::bigint,'paidPaisa',v_paid::bigint),
      v_now,v_now
    );
    return jsonb_build_object('id',v_sale_id,'invoiceNumber',v_invoice_number,
      'totalPaisa',v_total::bigint,'paidPaisa',v_paid::bigint);
  elsif p_action = 'payment' then
    begin
      v_sale_id := (p_payload->>'saleId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid bulk invoice.';
    end;
    if v_sale_id is null or coalesce(p_payload->>'amountPaisa','') !~ '^\d{1,15}$' then
      raise exception 'Enter a valid payment amount.';
    end if;
    v_amount := (p_payload->>'amountPaisa')::bigint;
    if v_amount < 1 then raise exception 'Payment amount must be greater than zero.'; end if;
    v_payment_method := coalesce(p_payload->>'method','');
    if v_payment_method not in ('cash','bank_transfer','card','jazzcash','easypaisa','other') then
      raise exception 'Choose a supported bulk sale payment method.';
    end if;
    v_reference := nullif(left(btrim(coalesce(p_payload->>'reference','')),100),'');
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes','')),500),'');
    select * into v_sale
    from public.bulk_sales
    where id = v_sale_id and deleted_at is null
    for update;
    if not found or not public.has_branch_access(v_sale.branch_id) then
      raise exception 'Bulk sale not found at your branch.';
    end if;
    v_branch_id := v_sale.branch_id;
    select coalesce(sum(payment.amount_paisa),0)
    into v_paid
    from public.bulk_sale_payments payment
    where payment.sale_id = v_sale_id and payment.deleted_at is null;
    v_due := v_sale.total_paisa - v_paid;
    if v_amount > v_due then raise exception 'Payment cannot exceed the outstanding balance of % paisa.',v_due; end if;
    v_payment_id := gen_random_uuid();
    insert into public.bulk_sale_payments(
      id,sale_id,branch_id,method,amount_paisa,reference,notes,paid_by,paid_at,created_at,server_updated_at
    ) values(
      v_payment_id,v_sale_id,v_branch_id,v_payment_method,v_amount,v_reference,v_notes,v_actor_id,v_now,v_now,v_now
    );
    insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
    values(
      gen_random_uuid(),v_actor_id,v_branch_id,'bulk_sale.payment','bulk_sale_payment',v_payment_id::text,
      jsonb_build_object('saleId',v_sale_id,'invoiceNumber',v_sale.invoice_number,
        'method',v_payment_method,'amountPaisa',v_amount),
      v_now,v_now
    );
    return jsonb_build_object('id',v_payment_id,'saleId',v_sale_id,
      'paidPaisa',v_paid+v_amount,'duePaisa',v_due-v_amount);
  else
    raise exception 'Choose a supported bulk sale action.';
  end if;
end;
$$;

revoke all on function public.manage_web_bulk_sale(text,jsonb) from public;
grant execute on function public.manage_web_bulk_sale(text,jsonb) to authenticated;

commit;
