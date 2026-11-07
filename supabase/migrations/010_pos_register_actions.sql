begin;

create or replace function public.staff_pos_register_action(
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
  v_amount bigint;
  v_expected bigint;
  v_reason text;
  v_notes text;
  v_now timestamptz := now();
  v_id uuid;
  v_cash_sales bigint;
  v_cash_in bigint;
  v_cash_out bigint;
  v_cash_refunds bigint;
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid register action.';
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

  if p_action = 'open_shift' then
    perform pg_advisory_xact_lock(hashtext(v_staff.local_staff_id::text || ':' || v_branch_id::text));
    select * into v_shift
    from public.pos_shifts
    where cashier_id = v_staff.local_staff_id
      and branch_id = v_branch_id
      and status = 'open'
      and deleted_at is null
    order by opened_at desc
    limit 1
    for update;
    if found then
      return jsonb_build_object('shift', to_jsonb(v_shift));
    end if;

    if coalesce(p_payload->>'openingCashPaisa', '') !~ '^\d{1,15}$' then
      raise exception 'Opening cash must be a non-negative whole number of paisa.';
    end if;
    v_amount := (p_payload->>'openingCashPaisa')::bigint;
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    v_id := gen_random_uuid();
    insert into public.pos_shifts (
      id, branch_id, cashier_id, status, opening_cash_paisa, expected_cash_paisa,
      opening_notes, opened_at, created_at, updated_at, server_updated_at
    ) values (
      v_id, v_branch_id, v_staff.local_staff_id, 'open', v_amount, v_amount,
      v_notes, v_now, v_now, v_now, v_now
    ) returning * into v_shift;

    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'shift.opened',
      'pos_shift', v_id, jsonb_build_object('openingCashPaisa', v_amount), v_now
    );
    return jsonb_build_object('shift', to_jsonb(v_shift));
  elsif p_action in ('close_shift', 'cash_in', 'cash_out') then
    select * into v_shift
    from public.pos_shifts
    where cashier_id = v_staff.local_staff_id
      and branch_id = v_branch_id
      and status = 'open'
      and deleted_at is null
    order by opened_at desc
    limit 1
    for update;
    if not found then
      raise exception 'There is no open shift for this register.';
    end if;

    select coalesce(sum(payment.amount_paisa), 0)::bigint
    into v_cash_sales
    from public.pos_sale_payments payment
    join public.pos_sales sale on sale.id = payment.sale_id
    where sale.shift_id = v_shift.id
      and sale.status = 'completed'
      and sale.deleted_at is null
      and payment.method = 'cash'
      and payment.deleted_at is null;

    select
      coalesce(sum(case when movement.movement_type = 'cash_in' then movement.amount_paisa else 0 end), 0)::bigint,
      coalesce(sum(case when movement.movement_type = 'cash_out' then movement.amount_paisa else 0 end), 0)::bigint
    into v_cash_in, v_cash_out
    from public.pos_shift_cash_movements movement
    where movement.shift_id = v_shift.id and movement.deleted_at is null;

    select coalesce(sum(refund.amount_paisa - refund.credited_paisa), 0)::bigint
    into v_cash_refunds
    from public.return_refunds refund
    where refund.shift_id = v_shift.id
      and refund.method = 'cash'
      and refund.status = 'processed'
      and refund.deleted_at is null;

    v_expected := v_shift.opening_cash_paisa + v_cash_sales + v_cash_in - v_cash_out - v_cash_refunds;
    if v_expected < 0 then v_expected := 0; end if;

    if p_action = 'close_shift' then
      if coalesce(p_payload->>'countedCashPaisa', '') !~ '^\d{1,15}$' then
        raise exception 'Counted cash must be a non-negative whole number of paisa.';
      end if;
      v_amount := (p_payload->>'countedCashPaisa')::bigint;
      v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
      update public.pos_shifts
      set status = 'closed',
          expected_cash_paisa = v_expected,
          counted_cash_paisa = v_amount,
          difference_paisa = v_amount - v_expected,
          closing_notes = v_notes,
          closed_at = v_now,
          updated_at = v_now,
          server_updated_at = v_now
      where id = v_shift.id
      returning * into v_shift;
      insert into public.audit_log (
        id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
      ) values (
        gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'shift.closed',
        'pos_shift', v_shift.id,
        jsonb_build_object(
          'expectedCashPaisa', v_expected,
          'countedCashPaisa', v_amount,
          'differencePaisa', v_amount - v_expected
        ),
        v_now
      );
      return jsonb_build_object('shift', to_jsonb(v_shift));
    end if;

    if coalesce(p_payload->>'amountPaisa', '') !~ '^[1-9]\d{0,14}$' then
      raise exception 'Amount must be a positive whole number of paisa.';
    end if;
    v_amount := (p_payload->>'amountPaisa')::bigint;
    v_reason := nullif(left(btrim(coalesce(p_payload->>'reason', '')), 200), '');
    if v_reason is null then raise exception 'Enter a reason for the cash movement.'; end if;
    if p_action = 'cash_out' and v_amount > v_expected then
      raise exception 'Cash out cannot exceed the expected cash currently in the drawer.';
    end if;

    v_id := gen_random_uuid();
    insert into public.pos_shift_cash_movements (
      id, shift_id, branch_id, movement_type, amount_paisa, reason, created_by, created_at, server_updated_at
    ) values (
      v_id, v_shift.id, v_branch_id, p_action, v_amount, v_reason,
      v_staff.local_staff_id, v_now, v_now
    );
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'shift.' || p_action,
      'pos_shift', v_shift.id,
      jsonb_build_object('amountPaisa', v_amount, 'reason', v_reason), v_now
    );
    update public.pos_shifts
    set expected_cash_paisa = case when p_action = 'cash_in' then v_expected + v_amount else v_expected - v_amount end,
        updated_at = v_now,
        server_updated_at = v_now
    where id = v_shift.id
    returning * into v_shift;
    return jsonb_build_object('shift', to_jsonb(v_shift), 'movementId', v_id);
  else
    raise exception 'Unsupported register action.';
  end if;
end;
$$;

revoke all on function public.staff_pos_register_action(text, jsonb) from public, anon;
grant execute on function public.staff_pos_register_action(text, jsonb) to authenticated;

commit;
