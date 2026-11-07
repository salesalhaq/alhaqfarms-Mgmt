begin;

create or replace function public.staff_close_day(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.cloud_staff;
  v_branch_id uuid;
  v_business_date date;
  v_counted_cash bigint;
  v_expected_cash bigint;
  v_difference bigint;
  v_notes text;
  v_report jsonb;
  v_day_close_id uuid;
  v_now timestamptz := now();
  v_existing_id uuid;
  v_text text;
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;
  if v_staff.role not in ('manager', 'admin') then
    raise exception 'A manager or administrator must close the business day.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid day-close record.';
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
    raise exception 'You cannot close that branch.';
  end if;

  v_text := coalesce(p_payload->>'businessDate', '');
  if v_text !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Choose a valid business date.';
  end if;
  begin
    v_business_date := v_text::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'Choose a valid business date.';
  end;
  if coalesce(p_payload->>'countedCashPaisa', '') !~ '^\d{1,15}$' then
    raise exception 'Counted cash must be a non-negative whole number of paisa.';
  end if;
  v_counted_cash := (p_payload->>'countedCashPaisa')::bigint;
  v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');

  perform pg_advisory_xact_lock(hashtext(v_branch_id::text || ':' || v_business_date::text));
  select close_record.id into v_existing_id
  from public.day_closes close_record
  where close_record.branch_id = v_branch_id
    and close_record.business_date = v_business_date
    and close_record.deleted_at is null
  limit 1;
  if found then raise exception 'This business day is already closed.'; end if;

  v_report := public.get_staff_daily_report(v_business_date, v_branch_id);
  if v_report is null then raise exception 'Could not calculate the business-day report.'; end if;
  v_text := v_report->'cashDrawer'->>'expectedCashPaisa';
  if coalesce(v_text, '') !~ '^\d{1,15}$' then
    raise exception 'The expected cash total is not available for this business day.';
  end if;
  v_expected_cash := v_text::bigint;
  v_difference := v_counted_cash - v_expected_cash;
  v_day_close_id := gen_random_uuid();

  insert into public.day_closes (
    id, branch_id, business_date, opening_float_paisa, cash_sales_paisa,
    cash_refunds_paisa, cash_in_paisa, cash_out_paisa, expected_cash_paisa,
    counted_cash_paisa, difference_paisa, gross_sales_paisa, refunds_paisa,
    discount_paisa, tax_paisa, sale_count, return_count, notes, closed_by,
    closed_at, created_at, server_updated_at
  ) values (
    v_day_close_id, v_branch_id, v_business_date,
    coalesce((v_report->'cashDrawer'->>'openingFloatPaisa')::bigint, 0),
    coalesce((v_report->'cashDrawer'->>'cashSalesPaisa')::bigint, 0),
    coalesce((v_report->'cashDrawer'->>'cashRefundsPaisa')::bigint, 0),
    coalesce((v_report->'cashDrawer'->>'cashInPaisa')::bigint, 0),
    coalesce((v_report->'cashDrawer'->>'cashOutPaisa')::bigint, 0),
    v_expected_cash, v_counted_cash, v_difference,
    coalesce((v_report->'sales'->>'totalPaisa')::bigint, 0),
    coalesce((v_report->'returns'->>'refundPaisa')::bigint, 0),
    coalesce((v_report->'sales'->>'discountPaisa')::bigint, 0),
    coalesce((v_report->'sales'->>'taxPaisa')::bigint, 0),
    coalesce((v_report->'sales'->>'count')::bigint, 0),
    coalesce((v_report->'returns'->>'count')::bigint, 0),
    v_notes, v_staff.local_staff_id, v_now, v_now, v_now
  );
  insert into public.audit_log (
    id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
  ) values (
    gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'day.closed',
    'day_close', v_day_close_id::text, jsonb_build_object(
      'businessDate', v_business_date,
      'expectedCashPaisa', v_expected_cash,
      'countedCashPaisa', v_counted_cash,
      'differencePaisa', v_difference,
      'grossSalesPaisa', coalesce((v_report->'sales'->>'totalPaisa')::bigint, 0),
      'refundsPaisa', coalesce((v_report->'returns'->>'refundPaisa')::bigint, 0)
    ), v_now
  );

  return jsonb_build_object(
    'id', v_day_close_id,
    'businessDate', v_business_date,
    'branchId', v_branch_id,
    'expectedCashPaisa', v_expected_cash,
    'countedCashPaisa', v_counted_cash,
    'differencePaisa', v_difference
  );
end;
$$;

revoke all on function public.staff_close_day(jsonb) from public, anon, authenticated;
grant execute on function public.staff_close_day(jsonb) to authenticated;

commit;
