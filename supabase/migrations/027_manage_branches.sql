begin;

create or replace function public.staff_manage_branch(
  p_action text,
  p_branch_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.cloud_staff;
  v_branch public.branches;
  v_code text := upper(btrim(coalesce(p_payload->>'code', '')));
  v_name text := btrim(coalesce(p_payload->>'name', ''));
  v_address text := nullif(btrim(coalesce(p_payload->>'address', '')), '');
  v_phone text := nullif(btrim(coalesce(p_payload->>'phone', '')), '');
  v_email text := nullif(btrim(coalesce(p_payload->>'email', '')), '');
  v_timezone text := btrim(coalesce(p_payload->>'timezone', ''));
  v_receipt_prefix text := upper(btrim(coalesce(p_payload->>'receiptPrefix', '')));
  v_is_active boolean;
  v_now timestamptz := now();
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;
  if v_staff.role <> 'admin' or v_staff.branch_id is not null then
    raise exception 'Only an HQ administrator can manage branches.';
  end if;
  if p_action not in ('create', 'update') then
    raise exception 'Choose a valid branch action.';
  end if;
  if jsonb_typeof(p_payload->'isActive') is distinct from 'boolean' then
    raise exception 'Branch status must be true or false.';
  end if;
  v_is_active := (p_payload->>'isActive')::boolean;

  if length(v_code) < 1 or length(v_code) > 20 or v_code !~ '^[A-Z0-9][A-Z0-9_-]*$' then
    raise exception 'Branch code must be 1–20 letters, numbers, underscores, or hyphens.';
  end if;
  if length(v_name) < 1 or length(v_name) > 200 then
    raise exception 'Branch name must be 1–200 characters.';
  end if;
  if length(coalesce(v_address, '')) > 300
      or length(coalesce(v_phone, '')) > 40
      or length(coalesce(v_email, '')) > 254 then
    raise exception 'Branch contact details are too long.';
  end if;
  if v_email is not null and v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid branch email address.';
  end if;
  if length(v_timezone) < 1 or length(v_timezone) > 100
      or not exists (select 1 from pg_timezone_names where name = v_timezone) then
    raise exception 'Choose a valid timezone.';
  end if;
  if length(v_receipt_prefix) < 1 or length(v_receipt_prefix) > 12
      or v_receipt_prefix !~ '^[A-Z0-9_-]+$' then
    raise exception 'Receipt prefix must be 1–12 letters, numbers, underscores, or hyphens.';
  end if;

  perform pg_advisory_xact_lock(118, 2);
  if p_action = 'create' then
    if p_branch_id is null then
      raise exception 'A branch identifier is required.';
    end if;
    insert into public.branches (
      id, code, name, address, phone, email, timezone, receipt_prefix,
      is_default, is_active, created_at, updated_at, server_updated_at
    ) values (
      p_branch_id, v_code, v_name, v_address, v_phone, v_email, v_timezone, v_receipt_prefix,
      false, v_is_active, v_now, v_now, v_now
    )
    returning * into v_branch;
  else
    if p_branch_id is null then
      raise exception 'Choose a branch to update.';
    end if;
    update public.branches
    set code = v_code,
        name = v_name,
        address = v_address,
        phone = v_phone,
        email = v_email,
        timezone = v_timezone,
        receipt_prefix = v_receipt_prefix,
        is_active = v_is_active,
        is_default = case when v_is_active then is_default else false end,
        updated_at = v_now,
        server_updated_at = v_now
    where id = p_branch_id and deleted_at is null
    returning * into v_branch;
    if not found then
      raise exception 'Choose an existing branch.';
    end if;
  end if;

  insert into public.audit_log (
    id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
  ) values (
    gen_random_uuid(), v_staff.local_staff_id, v_branch.id,
    case when p_action = 'create' then 'branch.created' else 'branch.updated' end,
    'branch', v_branch.id,
    jsonb_build_object('code', v_branch.code, 'name', v_branch.name, 'is_active', v_branch.is_active),
    v_now
  );

  return jsonb_build_object(
    'id', v_branch.id,
    'code', v_branch.code,
    'name', v_branch.name,
    'address', v_branch.address,
    'phone', v_branch.phone,
    'email', v_branch.email,
    'timezone', v_branch.timezone,
    'receiptPrefix', v_branch.receipt_prefix,
    'isDefault', v_branch.is_default,
    'isActive', v_branch.is_active
  );
end;
$$;

revoke all on function public.staff_manage_branch(text, uuid, jsonb) from public, anon;
grant execute on function public.staff_manage_branch(text, uuid, jsonb) to authenticated;

commit;
