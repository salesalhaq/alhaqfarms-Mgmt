begin;

-- Staff overview metrics must ignore voided sales.
--
-- The function was introduced by the desktop migration series
-- (0026_staff_overview_metrics.sql) and is shared by both clients. This
-- replacement keeps the same signature and adds the void exclusion so a
-- cashier and a manager see the same non-void sales total.

create or replace function public.get_staff_overview_metrics(
  p_branch_id uuid,
  p_day_start timestamptz,
  p_day_end timestamptz
)
returns table (
  product_count bigint,
  stock_count bigint,
  today_sales_count bigint,
  today_sales_total_paisa bigint,
  open_shift boolean
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    (
      select count(*)
      from public.products
      where is_active and deleted_at is null
    ),
    (
      select coalesce(sum(quantity_delta_milli), 0)::bigint
      from public.stock_movements
      where deleted_at is null
        and (p_branch_id is null or branch_id = p_branch_id)
    ),
    (
      select count(*)
      from public.pos_sales
      where deleted_at is null
        and status <> 'void'
        and completed_at >= p_day_start
        and completed_at < p_day_end
        and (p_branch_id is null or branch_id = p_branch_id)
    ),
    (
      select coalesce(sum(total_paisa), 0)::bigint
      from public.pos_sales
      where deleted_at is null
        and status <> 'void'
        and completed_at >= p_day_start
        and completed_at < p_day_end
        and (p_branch_id is null or branch_id = p_branch_id)
    ),
    exists (
      select 1
      from public.pos_shifts
      where status = 'open'
        and deleted_at is null
        and (p_branch_id is null or branch_id = p_branch_id)
    );
$$;

revoke all on function public.get_staff_overview_metrics(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_staff_overview_metrics(uuid, timestamptz, timestamptz) to authenticated;

commit;
