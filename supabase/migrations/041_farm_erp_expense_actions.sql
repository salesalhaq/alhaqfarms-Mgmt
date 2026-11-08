begin;

create or replace function public.manage_web_erp_expense(p_action text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_actor_branch_id uuid;
  v_branch_id uuid;
  v_category_id uuid;
  v_expense_id uuid;
  v_category_name text;
  v_name text;
  v_description text;
  v_payment_method text;
  v_reference text;
  v_notes text;
  v_amount bigint;
  v_now timestamptz := now();
begin
  if not public.is_admin_role() then
    raise exception 'Farm expense actions are restricted to administrators.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid farm expense action.';
  end if;
  select staff.local_staff_id, staff.branch_id into v_actor_id, v_actor_branch_id
  from public.cloud_staff staff
  where staff.user_id = auth.uid() and staff.is_active;
  if v_actor_id is null then
    raise exception 'Your staff profile is not linked for farm expense actions.';
  end if;

  if p_action = 'save-category' then
    if v_actor_branch_id is not null then
      raise exception 'Only an HQ administrator can add expense categories.';
    end if;
    v_name := nullif(btrim(p_payload->>'name'), '');
    if v_name is null or length(v_name) > 100 then
      raise exception 'Enter an expense category of up to 100 characters.';
    end if;
    perform pg_advisory_xact_lock(hashtext('expense-category:' || lower(v_name)));
    if exists (
      select 1 from public.expense_categories category
      where category.deleted_at is null and lower(category.name) = lower(v_name)
    ) then
      raise exception 'An expense category with this name already exists.';
    end if;
    v_category_id := gen_random_uuid();
    insert into public.expense_categories(
      id, name, is_active, created_by, created_at, updated_at, server_updated_at
    ) values (
      v_category_id, v_name, true, v_actor_id, v_now, v_now, v_now
    );
    insert into public.audit_log(
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_actor_branch_id, 'expense_category.created',
      'expense_category', v_category_id::text, jsonb_build_object('name', v_name), v_now, v_now
    );
    return jsonb_build_object('id', v_category_id, 'name', v_name, 'isActive', true);

  elsif p_action = 'record' then
    begin
      v_branch_id := (p_payload->>'branchId')::uuid;
      v_category_id := (p_payload->>'categoryId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid branch and expense category.';
    end;
    if v_branch_id is null or not public.has_branch_access(v_branch_id) then
      raise exception 'You cannot record farm expenses for that branch.';
    end if;
    v_description := nullif(btrim(p_payload->>'description'), '');
    if v_description is null or length(v_description) > 200 then
      raise exception 'Enter an expense description of up to 200 characters.';
    end if;
    if coalesce(p_payload->>'amountPaisa', '') !~ '^\d{1,15}$' then
      raise exception 'Enter a valid expense amount.';
    end if;
    v_amount := (p_payload->>'amountPaisa')::bigint;
    if v_amount < 1 then raise exception 'Expense amount must be greater than zero.'; end if;
    v_payment_method := coalesce(p_payload->>'paymentMethod', '');
    if v_payment_method not in ('cash', 'bank_transfer', 'card', 'jazzcash', 'easypaisa', 'other') then
      raise exception 'Choose a supported expense payment method.';
    end if;
    v_reference := nullif(left(btrim(coalesce(p_payload->>'reference', '')), 100), '');
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    select category.name into v_category_name
    from public.expense_categories category
    where category.id = v_category_id and category.is_active and category.deleted_at is null
    for share;
    if not found then raise exception 'Choose an active expense category.'; end if;

    v_expense_id := gen_random_uuid();
    insert into public.expenses(
      id, branch_id, category_id, description, amount_paisa, payment_method,
      reference, notes, spent_at, recorded_by, created_at, server_updated_at
    ) values (
      v_expense_id, v_branch_id, v_category_id, v_description, v_amount, v_payment_method,
      v_reference, v_notes, v_now, v_actor_id, v_now, v_now
    );
    insert into public.audit_log(
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_branch_id, 'expense.recorded', 'expense',
      v_expense_id::text,
      jsonb_build_object('categoryId', v_category_id, 'categoryName', v_category_name,
        'description', v_description, 'amountPaisa', v_amount,
        'paymentMethod', v_payment_method, 'reference', v_reference),
      v_now, v_now
    );
    return jsonb_build_object('id', v_expense_id, 'amountPaisa', v_amount,
      'categoryName', v_category_name, 'spentAt', v_now);
  else
    raise exception 'Choose a supported farm expense action.';
  end if;
end;
$$;

revoke all on function public.manage_web_erp_expense(text, jsonb) from public, anon;
grant execute on function public.manage_web_erp_expense(text, jsonb) to authenticated;

commit;
