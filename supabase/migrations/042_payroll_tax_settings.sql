begin;

-- Manual payroll withholding settings and per-payslip withholding.
--
-- The Windows desktop app keeps this toggle in `app_settings` under the
-- `hr.tax.settings` key. The cloud schema has no generic settings table, so
-- this migration stores the same toggle in a dedicated singleton table and
-- exposes both the toggle and withholding changes through one atomic RPC.

create table if not exists public.payroll_tax_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.payroll_tax_settings (id, enabled)
values (true, false)
on conflict (id) do nothing;

alter table public.payroll_tax_settings enable row level security;

grant select on public.payroll_tax_settings to authenticated;

drop policy if exists "payroll_tax_settings_select" on public.payroll_tax_settings;
create policy "payroll_tax_settings_select" on public.payroll_tax_settings
  for select to authenticated
  using (public.is_manager_or_admin());

-- Only the RPC below writes this table, so no insert/update policy is created.

create or replace function public.staff_manage_payroll_tax(
  p_action text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_actor_branch_id uuid;
  v_role text;
  v_enabled boolean;
  v_item public.payroll_items;
  v_run public.payroll_runs;
  v_item_id uuid;
  v_tax_paisa bigint;
  v_before_paisa bigint;
  v_net_paisa bigint;
  v_now timestamptz := now();
begin
  if not public.is_manager_or_admin() then
    raise exception 'HR and payroll are available to managers and administrators only.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid payroll tax action.';
  end if;

  select staff.local_staff_id, staff.role, staff.branch_id
  into v_actor_id, v_role, v_actor_branch_id
  from public.cloud_staff staff
  where staff.user_id = auth.uid() and staff.is_active;
  if v_actor_id is null then
    raise exception 'Your staff profile is not linked for payroll actions.';
  end if;

  if p_action = 'set-settings' then
    if v_role <> 'admin' then
      raise exception 'Only an administrator can change payroll tax settings.';
    end if;
    begin
      v_enabled := (p_payload->>'enabled')::boolean;
    exception when invalid_text_representation then
      v_enabled := null;
    end;
    if v_enabled is null then
      raise exception 'Choose whether manual payroll withholding is enabled.';
    end if;

    insert into public.payroll_tax_settings (id, enabled, updated_at, updated_by)
    values (true, v_enabled, v_now, v_actor_id)
    on conflict (id) do update set
      enabled = excluded.enabled,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_actor_branch_id, 'payroll.tax_toggle_updated', 'payroll_tax_settings', 'hr.tax.settings',
      jsonb_build_object('enabled', v_enabled), v_now, v_now
    );

    return jsonb_build_object('enabled', v_enabled);
  end if;

  if p_action = 'set-withholding' then
    if not coalesce((select settings.enabled from public.payroll_tax_settings settings where settings.id), false) then
      raise exception 'Enable manual payroll withholding before entering tax amounts.';
    end if;

    begin
      v_item_id := (p_payload->>'itemId')::uuid;
      v_tax_paisa := (p_payload->>'taxWithheldPaisa')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Choose a valid payslip and withholding amount.';
    end;
    if v_item_id is null or v_tax_paisa is null or v_tax_paisa < 0 then
      raise exception 'Choose a valid payslip and withholding amount.';
    end if;

    select item
    into v_item
    from public.payroll_items item
    where item.id = v_item_id and item.deleted_at is null;
    if v_item.id is null then
      raise exception 'Payslip not found.';
    end if;

    select run
    into v_run
    from public.payroll_runs run
    where run.id = v_item.run_id and run.deleted_at is null;
    if v_run.id is null then
      raise exception 'Payroll run not found.';
    end if;
    if not public.has_branch_access(v_run.branch_id) then
      raise exception 'Payslip not found at your branch.';
    end if;
    if v_run.status <> 'draft' then
      raise exception 'Withholding can only be changed on a draft payroll run.';
    end if;

    v_before_paisa := v_item.gross_paisa - v_item.advance_deduction_paisa;
    if v_tax_paisa > v_before_paisa then
      raise exception 'Withholding cannot exceed the employee''s remaining net pay.';
    end if;
    v_net_paisa := v_before_paisa - v_tax_paisa;

    update public.payroll_items
    set tax_withheld_paisa = v_tax_paisa,
        net_paisa = v_net_paisa,
        server_updated_at = v_now
    where id = v_item.id;

    update public.payroll_runs
    set net_paisa = (
          select coalesce(sum(item.net_paisa), 0)
          from public.payroll_items item
          where item.run_id = v_run.id and item.deleted_at is null
        ),
        server_updated_at = v_now
    where id = v_run.id and status = 'draft';

    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_run.branch_id, 'payroll.tax_withholding_updated', 'payroll_item',
      v_item.id::text,
      jsonb_build_object(
        'staffId', v_item.staff_id,
        'taxWithheldPaisa', v_tax_paisa,
        'netPaisa', v_net_paisa
      ), v_now, v_now
    );

    return jsonb_build_object(
      'itemId', v_item.id,
      'runId', v_run.id,
      'taxWithheldPaisa', v_tax_paisa,
      'netPaisa', v_net_paisa
    );
  end if;

  raise exception 'Choose a supported payroll tax action.';
end;
$$;

grant execute on function public.staff_manage_payroll_tax(text, jsonb) to authenticated;

commit;
