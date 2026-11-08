begin;

create or replace function public.manage_web_payroll_run(
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
  v_branch_id uuid;
  v_run_id uuid;
  v_run public.payroll_runs;
  v_employee record;
  v_compensation record;
  v_attendance record;
  v_advance record;
  v_recovery record;
  v_item_id uuid;
  v_period_start date;
  v_period_end date;
  v_working_days integer;
  v_monthly_paisa bigint;
  v_day_rate bigint;
  v_attendance_deduction bigint;
  v_gross_paisa bigint;
  v_advance_deduction bigint;
  v_remaining bigint;
  v_recovered bigint;
  v_paid_recovered bigint;
  v_take bigint;
  v_allocations jsonb;
  v_allocation jsonb;
  v_staff_count integer := 0;
  v_total_gross bigint := 0;
  v_total_attendance bigint := 0;
  v_total_advances bigint := 0;
  v_total_net bigint := 0;
  v_now timestamptz := now();
  v_notes text;
begin
  if not public.is_manager_or_admin() then
    raise exception 'HR and payroll are available to managers and administrators only.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid payroll action.';
  end if;
  select staff.local_staff_id into v_actor_id
  from public.cloud_staff staff
  where staff.user_id = auth.uid() and staff.is_active;
  if v_actor_id is null then
    raise exception 'Your staff profile is not linked for payroll actions.';
  end if;

  if p_action = 'generate' then
    begin
      v_branch_id := (p_payload->>'branchId')::uuid;
      v_period_start := (p_payload->>'periodStart')::date;
      v_period_end := (p_payload->>'periodEnd')::date;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception 'Choose a valid payroll branch and period.';
    end;
    if not public.has_branch_access(v_branch_id) then
      raise exception 'You cannot generate payroll for that branch.';
    end if;
    perform pg_advisory_xact_lock(hashtext(v_branch_id::text));
    if v_period_end < v_period_start then
      raise exception 'The period start must be on or before the period end.';
    end if;
    if v_period_end - v_period_start > 365 then
      raise exception 'Payroll periods cannot exceed 366 days.';
    end if;
    if exists (
      select 1
      from public.payroll_runs existing
      where existing.branch_id = v_branch_id
        and existing.period_start = v_period_start
        and existing.period_end = v_period_end
        and existing.status <> 'void'
        and existing.deleted_at is null
    ) then
      raise exception 'A payroll run already exists for this period.';
    end if;
    v_working_days := greatest((
      select count(*)::integer
      from generate_series(v_period_start, v_period_end, interval '1 day') day
      where extract(dow from day) <> 0
    ), 1);
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    v_run_id := gen_random_uuid();

    insert into public.payroll_runs (
      id, branch_id, period_start, period_end, status, working_days, staff_count,
      gross_paisa, attendance_deduction_paisa, advance_deduction_paisa, net_paisa,
      notes, created_by, created_at, server_updated_at
    ) values (
      v_run_id, v_branch_id, v_period_start, v_period_end, 'draft', v_working_days, 0,
      0, 0, 0, 0, v_notes, v_actor_id, v_now, v_now
    );

    for v_employee in
      select employee.id, employee.full_name, employee.job_title, employee.department_id,
             coalesce(department.name, 'Unassigned') as department_name
      from public.hr_employees employee
      left join public.hr_departments department on department.id = employee.department_id
      where employee.branch_id = v_branch_id
        and employee.deleted_at is null
        and employee.is_active
      order by employee.full_name, employee.id
    loop
      select compensation.base_salary_paisa, compensation.allowances_paisa
      into v_compensation
      from public.staff_compensation compensation
      where compensation.staff_id = v_employee.id
        and compensation.branch_id = v_branch_id
        and compensation.deleted_at is null
        and compensation.effective_from <= v_period_end
      order by compensation.effective_from desc, compensation.created_at desc, compensation.id desc
      limit 1;
      if not found then
        continue;
      end if;

      select
        count(*)::integer as recorded_days,
        count(*) filter (where attendance.status = 'present')::integer as present_days,
        count(*) filter (where attendance.status = 'absent')::integer as absent_days,
        count(*) filter (where attendance.status = 'half_day')::integer as half_days,
        count(*) filter (where attendance.status in ('leave', 'holiday'))::integer as leave_days
      into v_attendance
      from public.staff_attendance attendance
      where attendance.staff_id = v_employee.id
        and attendance.branch_id = v_branch_id
        and attendance.deleted_at is null
        and attendance.attendance_date between v_period_start and v_period_end;

      v_monthly_paisa := v_compensation.base_salary_paisa + v_compensation.allowances_paisa;
      v_day_rate := round(v_monthly_paisa::numeric / v_working_days)::bigint;
      v_attendance_deduction := least(
        v_monthly_paisa,
        v_attendance.absent_days * v_day_rate
          + round((v_attendance.half_days * v_day_rate)::numeric / 2)::bigint
      );
      v_gross_paisa := v_monthly_paisa - v_attendance_deduction;
      v_remaining := v_gross_paisa;
      v_advance_deduction := 0;
      v_item_id := gen_random_uuid();
      v_allocations := '[]'::jsonb;

      for v_advance in
        select advance.id, advance.amount_paisa,
          greatest(advance.amount_paisa - coalesce((
            select sum(recovery.amount_paisa)
            from public.payroll_advance_recoveries recovery
            join public.payroll_runs paid_run on paid_run.id = recovery.run_id
            where recovery.advance_id = advance.id
              and paid_run.status = 'paid'
              and paid_run.deleted_at is null
              and recovery.deleted_at is null
          ), 0), 0) as outstanding_paisa
        from public.staff_advances advance
        where advance.staff_id = v_employee.id
          and advance.branch_id = v_branch_id
          and advance.deleted_at is null
        order by advance.advance_date, advance.created_at, advance.id
        for update of advance
      loop
        exit when v_remaining <= 0;
        if v_advance.outstanding_paisa <= 0 then
          continue;
        end if;
        v_take := least(v_advance.outstanding_paisa, v_remaining);
        v_allocations := v_allocations || jsonb_build_array(
          jsonb_build_object('advanceId', v_advance.id, 'amountPaisa', v_take)
        );
        v_advance_deduction := v_advance_deduction + v_take;
        v_remaining := v_remaining - v_take;
      end loop;

      insert into public.payroll_items (
        id, run_id, staff_id, staff_name, role, base_salary_paisa, allowances_paisa,
        working_days, present_days, absent_days, half_days, leave_days,
        attendance_deduction_paisa, advance_deduction_paisa, gross_paisa, net_paisa,
        notes, created_at, department_id, department_name, tax_withheld_paisa,
        server_updated_at
      ) values (
        v_item_id, v_run_id, v_employee.id, v_employee.full_name, coalesce(v_employee.job_title, ''),
        v_compensation.base_salary_paisa, v_compensation.allowances_paisa, v_working_days,
        case when v_attendance.recorded_days > 0 then v_attendance.present_days else v_working_days end,
        v_attendance.absent_days, v_attendance.half_days, v_attendance.leave_days,
        v_attendance_deduction, v_advance_deduction, v_gross_paisa,
        v_gross_paisa - v_advance_deduction, null, v_now,
        v_employee.department_id, v_employee.department_name, 0, v_now
      );
      for v_allocation in select value from jsonb_array_elements(v_allocations)
      loop
        insert into public.payroll_advance_recoveries (
          id, run_id, item_id, advance_id, staff_id, amount_paisa, created_at, server_updated_at
        ) values (
          gen_random_uuid(), v_run_id, v_item_id, (v_allocation->>'advanceId')::uuid,
          v_employee.id, (v_allocation->>'amountPaisa')::bigint, v_now, v_now
        );
      end loop;

      v_staff_count := v_staff_count + 1;
      v_total_gross := v_total_gross + v_gross_paisa;
      v_total_attendance := v_total_attendance + v_attendance_deduction;
      v_total_advances := v_total_advances + v_advance_deduction;
      v_total_net := v_total_net + v_gross_paisa - v_advance_deduction;
    end loop;

    if v_staff_count = 0 then
      raise exception 'Set compensation for at least one active employee before running payroll.';
    end if;

    update public.payroll_runs
    set staff_count = v_staff_count,
        gross_paisa = v_total_gross,
        attendance_deduction_paisa = v_total_attendance,
        advance_deduction_paisa = v_total_advances,
        net_paisa = v_total_net,
        server_updated_at = v_now
    where id = v_run_id;

    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_branch_id, 'payroll.generated', 'payroll_run', v_run_id::text,
      jsonb_build_object(
        'periodStart', v_period_start,
        'periodEnd', v_period_end,
        'staffCount', v_staff_count,
        'grossPaisa', v_total_gross,
        'netPaisa', v_total_net
      ), v_now, v_now
    );
    return jsonb_build_object(
      'runId', v_run_id,
      'staffCount', v_staff_count,
      'grossPaisa', v_total_gross,
      'attendanceDeductionPaisa', v_total_attendance,
      'advanceDeductionPaisa', v_total_advances,
      'netPaisa', v_total_net
    );
  end if;

  begin
    v_run_id := (p_payload->>'runId')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid payroll run.';
  end;
  select * into v_run
  from public.payroll_runs run
  where run.id = v_run_id and run.deleted_at is null
  for update;
  if not found or not public.has_branch_access(v_run.branch_id) then
    raise exception 'Payroll run not found at an accessible branch.';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_run.branch_id::text));
  select * into v_run
  from public.payroll_runs run
  where run.id = v_run_id and run.deleted_at is null
  for update;
  if not found or not public.has_branch_access(v_run.branch_id) then
    raise exception 'Payroll run not found at an accessible branch.';
  end if;
  if v_run.status <> 'draft' then
    raise exception 'Only draft payroll runs can be changed.';
  end if;

  if p_action = 'mark-paid' then
    for v_recovery in
      select recovery.advance_id, sum(recovery.amount_paisa)::bigint as amount_paisa
      from public.payroll_advance_recoveries recovery
      where recovery.run_id = v_run_id and recovery.deleted_at is null
      group by recovery.advance_id
      order by recovery.advance_id
    loop
      select advance.amount_paisa into v_advance
      from public.staff_advances advance
      where advance.id = v_recovery.advance_id
        and advance.branch_id = v_run.branch_id
        and advance.deleted_at is null
      for update;
      if not found then
        raise exception 'An advance in this run is no longer available. Void and regenerate the run.';
      end if;
      select coalesce(sum(recovery.amount_paisa), 0)::bigint into v_paid_recovered
      from public.payroll_advance_recoveries recovery
      join public.payroll_runs paid_run on paid_run.id = recovery.run_id
      where recovery.advance_id = v_recovery.advance_id
        and recovery.run_id <> v_run_id
        and paid_run.status = 'paid'
        and paid_run.deleted_at is null
        and recovery.deleted_at is null;
      if v_recovery.amount_paisa > greatest(v_advance.amount_paisa - v_paid_recovered, 0) then
        raise exception 'An advance in this run is already recovered by another paid run. Void this run and regenerate it.';
      end if;
    end loop;
    update public.payroll_runs
    set status = 'paid', paid_by = v_actor_id, paid_at = v_now, server_updated_at = v_now
    where id = v_run_id and status = 'draft';
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_run.branch_id, 'payroll.paid', 'payroll_run', v_run_id::text,
      jsonb_build_object('netPaisa', v_run.net_paisa), v_now, v_now
    );
    return jsonb_build_object('runId', v_run_id, 'status', 'paid');
  elsif p_action = 'void' then
    update public.payroll_runs
    set status = 'void', voided_by = v_actor_id, voided_at = v_now, server_updated_at = v_now
    where id = v_run_id and status = 'draft';
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_actor_id, v_run.branch_id, 'payroll.voided', 'payroll_run', v_run_id::text,
      '{}'::jsonb, v_now, v_now
    );
    return jsonb_build_object('runId', v_run_id, 'status', 'void');
  end if;

  raise exception 'Choose a supported payroll run action.';
end;
$$;

revoke all on function public.manage_web_payroll_run(text, jsonb) from public;
grant execute on function public.manage_web_payroll_run(text, jsonb) to authenticated;

commit;
