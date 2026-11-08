begin;

create or replace function public.manage_web_customer_account(p_action text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_account_id uuid;
  v_branch_id uuid;
  v_invoice_id uuid;
  v_payment_id uuid;
  v_name text;
  v_phone text;
  v_email text;
  v_address text;
  v_notes text;
  v_credit_limit bigint;
  v_active boolean;
  v_invoice_number text;
  v_invoice_date date;
  v_description text;
  v_amount bigint;
  v_method text;
  v_reference text;
  v_balance numeric;
  v_now timestamptz := now();
  v_account public.customer_accounts;
begin
  if not public.is_admin_role() then
    raise exception 'Customer account actions are restricted to administrators.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid customer account action.';
  end if;
  select staff.local_staff_id into v_actor_id
  from public.cloud_staff staff
  where staff.user_id = auth.uid() and staff.is_active;
  if v_actor_id is null then
    raise exception 'Your staff profile is not linked for customer account actions.';
  end if;

  if p_action = 'save' then
    v_name := nullif(btrim(p_payload->>'name'), '');
    if v_name is null or length(v_name) > 200 then
      raise exception 'Enter a customer name of up to 200 characters.';
    end if;
    if coalesce(p_payload->>'creditLimitPaisa', '') !~ '^\d{1,15}$' then
      raise exception 'Enter a valid credit limit.';
    end if;
    v_credit_limit := (p_payload->>'creditLimitPaisa')::bigint;
    v_phone := nullif(left(btrim(coalesce(p_payload->>'phone', '')), 50), '');
    v_email := nullif(left(btrim(coalesce(p_payload->>'email', '')), 254), '');
    v_address := nullif(left(btrim(coalesce(p_payload->>'address', '')), 1000), '');
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 1000), '');
    if v_email is not null and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'Enter a valid customer email address.';
    end if;

    if nullif(p_payload->>'id', '') is not null then
      begin
        v_account_id := (p_payload->>'id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid customer account.';
      end;
      select * into v_account
      from public.customer_accounts
      where id = v_account_id and deleted_at is null
      for update;
      if not found or not public.has_branch_access(v_account.branch_id) then
        raise exception 'Customer account not found at your branch.';
      end if;
      v_branch_id := v_account.branch_id;
    else
      begin
        v_branch_id := (p_payload->>'branchId')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid customer branch.';
      end;
      if v_branch_id is null or not public.has_branch_access(v_branch_id) then
        raise exception 'You cannot create customer accounts at that branch.';
      end if;
      v_account_id := gen_random_uuid();
    end if;

    perform pg_advisory_xact_lock(hashtext(v_branch_id::text || ':customer:' || lower(v_name)));
    if exists (
      select 1
      from public.customer_accounts account
      where account.branch_id = v_branch_id
        and account.id <> v_account_id
        and account.deleted_at is null
        and lower(account.name) = lower(v_name)
    ) then
      raise exception 'Another customer at this branch already uses this name.';
    end if;

    if p_payload ? 'id' and nullif(p_payload->>'id', '') is not null then
      update public.customer_accounts
      set name = v_name, phone = v_phone, email = v_email, address = v_address,
          credit_limit_paisa = v_credit_limit, notes = v_notes,
          updated_at = v_now, server_updated_at = v_now
      where id = v_account_id;
    else
      insert into public.customer_accounts(
        id, branch_id, name, phone, email, address, credit_limit_paisa, notes,
        is_active, created_by, created_at, updated_at, server_updated_at
      ) values (
        v_account_id, v_branch_id, v_name, v_phone, v_email, v_address, v_credit_limit, v_notes,
        true, v_actor_id, v_now, v_now, v_now
      );
    end if;
    insert into public.audit_log(
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_branch_id,
      case when p_payload ? 'id' and nullif(p_payload->>'id', '') is not null
        then 'customer.updated' else 'customer.created' end,
      'customer_account', v_account_id::text,
      jsonb_build_object('name', v_name, 'creditLimitPaisa', v_credit_limit),
      v_now, v_now
    );
    return jsonb_build_object('id', v_account_id, 'name', v_name);

  elsif p_action = 'set-active' then
    begin
      v_account_id := (p_payload->>'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid customer account.';
    end;
    if coalesce(jsonb_typeof(p_payload->'active'), '') <> 'boolean' then
      raise exception 'Choose whether the customer account should be active.';
    end if;
    v_active := (p_payload->>'active')::boolean;
    select * into v_account
    from public.customer_accounts
    where id = v_account_id and deleted_at is null
    for update;
    if not found or not public.has_branch_access(v_account.branch_id) then
      raise exception 'Customer account not found at your branch.';
    end if;
    update public.customer_accounts
    set is_active = v_active, updated_at = v_now, server_updated_at = v_now
    where id = v_account_id;
    insert into public.audit_log(
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_account.branch_id,
      case when v_active then 'customer.activated' else 'customer.deactivated' end,
      'customer_account', v_account_id::text, jsonb_build_object('name', v_account.name), v_now, v_now
    );
    return jsonb_build_object('id', v_account_id, 'active', v_active);

  elsif p_action = 'invoice' then
    begin
      v_account_id := (p_payload->>'accountId')::uuid;
      v_invoice_date := (p_payload->>'invoiceDate')::date;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception 'Choose a valid customer account and invoice date.';
    end;
    if v_invoice_date is null or v_invoice_date > (v_now at time zone 'Asia/Karachi')::date then
      raise exception 'Invoice date must be today or earlier.';
    end if;
    v_description := nullif(btrim(p_payload->>'description'), '');
    if v_description is null or length(v_description) > 300 then
      raise exception 'Enter an invoice description of up to 300 characters.';
    end if;
    if coalesce(p_payload->>'amountPaisa', '') !~ '^\d{1,15}$' then
      raise exception 'Enter a valid invoice amount.';
    end if;
    v_amount := (p_payload->>'amountPaisa')::bigint;
    if v_amount < 1 then raise exception 'Invoice amount must be greater than zero.'; end if;
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    begin
      v_account_id := (p_payload->>'accountId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid customer account.';
    end;
    select * into v_account
    from public.customer_accounts
    where id = v_account_id and deleted_at is null
    for update;
    if not found or not public.has_branch_access(v_account.branch_id) then
      raise exception 'Customer account not found at your branch.';
    end if;
    if not v_account.is_active then raise exception 'This customer account is inactive.'; end if;
    v_branch_id := v_account.branch_id;

    v_invoice_number := left(btrim(coalesce(p_payload->>'invoiceNumber', '')), 60);
    if v_invoice_number = '' then
      v_invoice_number := 'ACC-' || to_char(v_now at time zone 'Asia/Karachi', 'YYMMDDHH24MISS')
        || '-' || upper(substr(gen_random_uuid()::text, 1, 8));
    end if;
    perform pg_advisory_xact_lock(hashtext(v_branch_id::text || ':customer-invoice:' || v_invoice_number));
    if exists (
      select 1 from public.customer_invoices invoice
      where invoice.branch_id = v_branch_id
        and invoice.invoice_number = v_invoice_number
        and invoice.deleted_at is null
    ) then
      raise exception 'That invoice number is already used at this branch.';
    end if;

    v_invoice_id := gen_random_uuid();
    insert into public.customer_invoices(
      id, account_id, branch_id, invoice_number, invoice_date, description, amount_paisa,
      notes, created_by, created_at, server_updated_at
    ) values (
      v_invoice_id, v_account_id, v_branch_id, v_invoice_number, v_invoice_date,
      v_description, v_amount, v_notes, v_actor_id, v_now, v_now
    );
    insert into public.audit_log(
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_branch_id, 'customer.invoice', 'customer_invoice',
      v_invoice_id::text,
      jsonb_build_object('accountId', v_account_id, 'invoiceNumber', v_invoice_number, 'amountPaisa', v_amount),
      v_now, v_now
    );
    return jsonb_build_object('id', v_invoice_id, 'accountId', v_account_id,
      'invoiceNumber', v_invoice_number, 'amountPaisa', v_amount);

  elsif p_action = 'payment' then
    begin
      v_account_id := (p_payload->>'accountId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid customer account.';
    end;
    if coalesce(p_payload->>'amountPaisa', '') !~ '^\d{1,15}$' then
      raise exception 'Enter a valid payment amount.';
    end if;
    v_amount := (p_payload->>'amountPaisa')::bigint;
    if v_amount < 1 then raise exception 'Payment amount must be greater than zero.'; end if;
    v_method := coalesce(p_payload->>'method', '');
    if v_method not in ('cash', 'bank_transfer', 'card', 'jazzcash', 'easypaisa', 'other') then
      raise exception 'Choose a supported customer payment method.';
    end if;
    v_reference := nullif(left(btrim(coalesce(p_payload->>'reference', '')), 100), '');
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    if nullif(p_payload->>'invoiceId', '') is not null then
      begin
        v_invoice_id := (p_payload->>'invoiceId')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid invoice.';
      end;
    else
      v_invoice_id := null;
    end if;
    select * into v_account
    from public.customer_accounts
    where id = v_account_id and deleted_at is null
    for update;
    if not found or not public.has_branch_access(v_account.branch_id) then
      raise exception 'Customer account not found at your branch.';
    end if;
    if not v_account.is_active then raise exception 'This customer account is inactive.'; end if;
    if v_invoice_id is not null and not exists (
      select 1 from public.customer_invoices invoice
      where invoice.id = v_invoice_id and invoice.account_id = v_account_id
        and invoice.branch_id = v_account.branch_id and invoice.deleted_at is null
    ) then
      raise exception 'That invoice does not belong to this customer.';
    end if;
    select
      coalesce((select sum(invoice.amount_paisa)
        from public.customer_invoices invoice
        where invoice.account_id = v_account_id and invoice.deleted_at is null), 0)
      - coalesce((select sum(payment.amount_paisa)
        from public.customer_payments payment
        where payment.account_id = v_account_id and payment.deleted_at is null), 0)
    into v_balance;
    if v_amount > greatest(v_balance, 0) then
      raise exception 'Payment cannot exceed the outstanding balance of % paisa.', greatest(v_balance, 0);
    end if;

    v_payment_id := gen_random_uuid();
    insert into public.customer_payments(
      id, account_id, branch_id, invoice_id, method, amount_paisa, reference, notes,
      paid_by, paid_at, created_at, server_updated_at
    ) values (
      v_payment_id, v_account_id, v_account.branch_id, v_invoice_id, v_method, v_amount,
      v_reference, v_notes, v_actor_id, v_now, v_now, v_now
    );
    insert into public.audit_log(
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_account.branch_id, 'customer.payment', 'customer_payment',
      v_payment_id::text,
      jsonb_build_object('accountId', v_account_id, 'method', v_method, 'amountPaisa', v_amount,
        'invoiceId', v_invoice_id),
      v_now, v_now
    );
    return jsonb_build_object('id', v_payment_id, 'accountId', v_account_id,
      'paidPaisa', v_amount, 'balancePaisa', greatest(v_balance, 0) - v_amount);
  else
    raise exception 'Choose a supported customer account action.';
  end if;
end;
$$;

revoke all on function public.manage_web_customer_account(text, jsonb) from public, anon;
grant execute on function public.manage_web_customer_account(text, jsonb) to authenticated;

commit;
