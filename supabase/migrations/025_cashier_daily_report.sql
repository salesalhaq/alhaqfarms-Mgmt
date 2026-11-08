begin;

create or replace function public.get_staff_cashier_daily_report(
  p_business_date date,
  p_branch_id uuid,
  p_cashier_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_staff public.cloud_staff;
  v_report jsonb;
begin
  select * into v_staff
    from public.cloud_staff
   where user_id = auth.uid()
     and is_active;

  if v_staff.user_id is null
     or v_staff.role <> 'cashier'
     or v_staff.local_staff_id is distinct from p_cashier_id
     or v_staff.branch_id is distinct from p_branch_id
     or not public.has_branch_access(p_branch_id) then
    raise exception 'Cashier daily-report access is limited to your own branch and register.' using errcode = '42501';
  end if;

  with daily_shifts as (
    select shift.*
      from public.pos_shifts shift
     where shift.branch_id = p_branch_id
       and shift.cashier_id = p_cashier_id
       and shift.deleted_at is null
       and (shift.opened_at at time zone 'Asia/Karachi')::date = p_business_date
  ),
  daily_sales as (
    select sale.*
      from public.pos_sales sale
     where sale.branch_id = p_branch_id
       and sale.cashier_id = p_cashier_id
       and sale.deleted_at is null
       and sale.status <> 'void'
       and (sale.completed_at at time zone 'Asia/Karachi')::date = p_business_date
  ),
  daily_returns as (
    select return_record.*
      from public.returns return_record
     where return_record.branch_id = p_branch_id
       and return_record.completed_by = p_cashier_id
       and return_record.deleted_at is null
       and return_record.status = 'completed'
       and return_record.completed_at is not null
       and (return_record.completed_at at time zone 'Asia/Karachi')::date = p_business_date
  ),
  sales_totals as (
    select count(*)::bigint as sale_count,
           coalesce(sum(total_paisa), 0)::bigint as gross_paisa,
           coalesce(sum(discount_paisa), 0)::bigint as discount_paisa,
           coalesce(sum(tax_paisa), 0)::bigint as tax_paisa,
           coalesce(sum(paid_paisa), 0)::bigint as paid_paisa,
           coalesce(sum(due_paisa), 0)::bigint as due_paisa
      from daily_sales
  ),
  return_totals as (
    select count(*)::bigint as return_count,
           coalesce(sum(refund_total_paisa), 0)::bigint as refund_paisa,
           coalesce(sum(restock_total_milli), 0)::bigint as restock_milli
      from daily_returns
  ),
  payment_totals as (
    select payment.method, count(*)::bigint as payment_count,
           coalesce(sum(payment.amount_paisa), 0)::bigint as amount_paisa
      from public.pos_sale_payments payment
      join daily_sales sale on sale.id = payment.sale_id
     where payment.deleted_at is null
     group by payment.method
  ),
  refund_totals as (
    select refund.method, count(*)::bigint as refund_count,
           coalesce(sum(refund.amount_paisa), 0)::bigint as amount_paisa
      from public.return_refunds refund
      join daily_returns return_record on return_record.id = refund.return_id
     where refund.deleted_at is null
     group by refund.method
  ),
  movement_totals as (
    select coalesce(sum(movement.amount_paisa) filter (where movement.movement_type = 'cash_in'), 0)::bigint as cash_in_paisa,
           coalesce(sum(movement.amount_paisa) filter (where movement.movement_type = 'cash_out'), 0)::bigint as cash_out_paisa
      from public.pos_shift_cash_movements movement
      join daily_shifts shift on shift.id = movement.shift_id
     where movement.deleted_at is null
       and (movement.created_at at time zone 'Asia/Karachi')::date = p_business_date
  ),
  cash_sales as (
    select coalesce(sum(payment.amount_paisa), 0)::bigint as amount_paisa
      from public.pos_sale_payments payment
      join daily_sales sale on sale.id = payment.sale_id
     where payment.deleted_at is null
       and payment.method = 'cash'
  ),
  cash_refunds as (
    select coalesce(sum(refund.amount_paisa), 0)::bigint as amount_paisa
      from public.return_refunds refund
      join daily_returns return_record on return_record.id = refund.return_id
     where refund.deleted_at is null
       and refund.method = 'cash'
  ),
  cash_drawer as (
    select coalesce((select sum(opening_cash_paisa) from daily_shifts), 0)::bigint as opening_float_paisa,
           (select amount_paisa from cash_sales) as cash_sales_paisa,
           (select amount_paisa from cash_refunds) as cash_refunds_paisa,
           (select cash_in_paisa from movement_totals) as cash_in_paisa,
           (select cash_out_paisa from movement_totals) as cash_out_paisa,
           coalesce((
             select sum(greatest(
               0,
               shift.opening_cash_paisa
                 + coalesce(shift_sales.amount_paisa, 0)
                 + coalesce(shift_movements.cash_in_paisa, 0)
                 - coalesce(shift_movements.cash_out_paisa, 0)
                 - coalesce(shift_refunds.amount_paisa, 0)
             ))
               from daily_shifts shift
               left join lateral (
                 select sum(payment.amount_paisa)::bigint as amount_paisa
                   from public.pos_sale_payments payment
                   join daily_sales sale on sale.id = payment.sale_id
                  where sale.shift_id = shift.id
                    and payment.method = 'cash'
                    and payment.deleted_at is null
               ) shift_sales on true
               left join lateral (
                 select sum(movement.amount_paisa) filter (where movement.movement_type = 'cash_in')::bigint as cash_in_paisa,
                        sum(movement.amount_paisa) filter (where movement.movement_type = 'cash_out')::bigint as cash_out_paisa
                   from public.pos_shift_cash_movements movement
                  where movement.shift_id = shift.id
                    and movement.deleted_at is null
                    and (movement.created_at at time zone 'Asia/Karachi')::date = p_business_date
               ) shift_movements on true
               left join lateral (
                 select sum(refund.amount_paisa)::bigint as amount_paisa
                   from public.return_refunds refund
                   join daily_returns return_record on return_record.id = refund.return_id
                  where refund.shift_id = shift.id
                    and refund.method = 'cash'
                    and refund.deleted_at is null
               ) shift_refunds on true
           ), 0)::bigint as expected_cash_paisa
  ),
  top_products as (
    select item.product_name, item.sku,
           coalesce(sum(item.quantity_milli), 0)::bigint as quantity_milli,
           coalesce(sum(item.line_total_paisa), 0)::bigint as revenue_paisa
      from public.pos_sale_items item
      join daily_sales sale on sale.id = item.sale_id
     where item.deleted_at is null
     group by item.product_name, item.sku
     order by quantity_milli desc, revenue_paisa desc
     limit 10
  )
  select jsonb_build_object(
    'date', p_business_date,
    'branchId', p_branch_id,
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', branch.id, 'name', branch.name))
        from public.branches branch
       where branch.id = p_branch_id
         and branch.deleted_at is null
    ), '[]'::jsonb),
    'sales', (select jsonb_build_object(
      'count', sale_count, 'totalPaisa', gross_paisa, 'discountPaisa', discount_paisa,
      'taxPaisa', tax_paisa, 'paidPaisa', paid_paisa, 'duePaisa', due_paisa
    ) from sales_totals),
    'returns', (select jsonb_build_object(
      'count', return_count, 'refundPaisa', refund_paisa, 'restockMilli', restock_milli
    ) from return_totals),
    'netPaisa', (select gross_paisa - refund_paisa from sales_totals cross join return_totals),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', method, 'count', payment_count, 'amount', amount_paisa
      ) order by method) from payment_totals
    ), '[]'::jsonb),
    'refundsByMethod', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', method, 'count', refund_count, 'amount', amount_paisa
      ) order by method) from refund_totals
    ), '[]'::jsonb),
    'topProducts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_name', product_name, 'sku', sku,
        'quantity_milli', quantity_milli, 'revenue_paisa', revenue_paisa
      ) order by quantity_milli desc, revenue_paisa desc) from top_products
    ), '[]'::jsonb),
    'cashDrawer', (select jsonb_build_object(
      'openingFloatPaisa', opening_float_paisa,
      'cashSalesPaisa', cash_sales_paisa,
      'cashRefundsPaisa', cash_refunds_paisa,
      'cashInPaisa', cash_in_paisa,
      'cashOutPaisa', cash_out_paisa,
      'expectedCashPaisa', expected_cash_paisa
    ) from cash_drawer),
    'shifts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', shift.id, 'branch_id', shift.branch_id, 'cashier_id', shift.cashier_id,
        'status', shift.status, 'opening_cash_paisa', shift.opening_cash_paisa,
        'expected_cash_paisa', shift.expected_cash_paisa,
        'counted_cash_paisa', shift.counted_cash_paisa, 'difference_paisa', shift.difference_paisa,
        'opened_at', shift.opened_at, 'closed_at', shift.closed_at
      ) order by shift.opened_at, shift.id) from daily_shifts shift
    ), '[]'::jsonb),
    'dayClose', null,
    'dayCloses', '[]'::jsonb
  )
  into v_report;

  return v_report;
end;
$$;

revoke all on function public.get_staff_cashier_daily_report(date, uuid, uuid) from public, anon;
grant execute on function public.get_staff_cashier_daily_report(date, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
