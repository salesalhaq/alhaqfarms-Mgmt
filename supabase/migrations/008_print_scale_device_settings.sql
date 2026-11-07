-- Track C/D — weight-barcode assignment and per-device print/scale settings
--
-- Apply this file in the Supabase SQL editor (or with `supabase db push`)
-- before using weight-barcode assignment or cloud device settings.
--
-- The web app runs as the signed-in staff member. It never uses the service
-- role key, so both objects below are guarded by the existing RLS helpers:
--   is_staff(), is_hq_admin(), has_branch_access(branch_id)

/* -------------------------------------------------------------------------
 * 1. Atomic weight-barcode product-code assignment
 *
 * Mirrors the Windows desktop `getWeightBarcodeProductCode`:
 *   - only kg / ltr products can have a code;
 *   - an existing unique code is kept;
 *   - otherwise the lowest free code in 1..99999 is assigned.
 *
 * A transaction-level advisory lock serialises concurrent assignments so two
 * registers can never reserve the same code.
 * ---------------------------------------------------------------------- */

create or replace function public.assign_product_weight_barcode_code(p_product_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit text;
  v_metadata jsonb;
  v_current integer;
  v_assigned integer;
begin
  if not public.is_staff() then
    raise exception 'Staff access required.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('alhaq.product.weight_barcode_code'));

  select lower(coalesce(unit_code, '')), coalesce(metadata_json, '{}'::jsonb)
    into v_unit, v_metadata
  from public.products
  where id = p_product_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Product not found.' using errcode = 'P0002';
  end if;

  if v_unit not in ('kg', 'ltr') then
    raise exception 'Weight barcodes can only be assigned to kg or ltr products.'
      using errcode = '22023';
  end if;

  if (v_metadata ->> 'weightBarcodeCode') ~ '^[0-9]+$' then
    v_current := (v_metadata ->> 'weightBarcodeCode')::integer;
  else
    v_current := null;
  end if;

  if v_current is not null
     and v_current between 1 and 99999
     and not exists (
       select 1
       from public.products
       where id <> p_product_id
         and deleted_at is null
         and (metadata_json ->> 'weightBarcodeCode') ~ '^[0-9]+$'
         and (metadata_json ->> 'weightBarcodeCode')::integer = v_current
     )
  then
    return v_current;
  end if;

  select candidate
    into v_assigned
  from generate_series(1, 99999) as candidate
  where not exists (
    select 1
    from public.products
    where id <> p_product_id
      and deleted_at is null
      and (metadata_json ->> 'weightBarcodeCode') ~ '^[0-9]+$'
      and (metadata_json ->> 'weightBarcodeCode')::integer = candidate
  )
  order by candidate
  limit 1;

  if v_assigned is null then
    raise exception 'All 99,999 weight-barcode product codes are in use.'
      using errcode = '23505';
  end if;

  update public.products
     set metadata_json = jsonb_set(
           coalesce(metadata_json, '{}'::jsonb),
           '{weightBarcodeCode}',
           to_jsonb(v_assigned),
           true
         ),
         updated_at = now()
   where id = p_product_id;

  return v_assigned;
end;
$$;

revoke all on function public.assign_product_weight_barcode_code(uuid) from public;
grant execute on function public.assign_product_weight_barcode_code(uuid) to authenticated;

/* -------------------------------------------------------------------------
 * 2. Per-device printer / scale preferences
 *
 * Printers and scales are physical properties of a register, so preferences
 * are keyed by branch + a stable browser device id. `branch_id` is null for
 * HQ devices that are not tied to a branch.
 * ---------------------------------------------------------------------- */

create table if not exists public.device_settings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references public.branches(id) on delete cascade,
  device_id text not null,
  settings_json jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_settings_device_id_length check (length(device_id) between 1 and 120),
  constraint device_settings_branch_device_key unique (branch_id, device_id)
);

alter table public.device_settings enable row level security;

drop policy if exists "device_settings_select" on public.device_settings;
create policy "device_settings_select" on public.device_settings
  for select to authenticated
  using (
    (branch_id is null and public.is_hq_admin())
    or (branch_id is not null and public.has_branch_access(branch_id))
  );

drop policy if exists "device_settings_insert" on public.device_settings;
create policy "device_settings_insert" on public.device_settings
  for insert to authenticated
  with check (
    (branch_id is null and public.is_hq_admin())
    or (branch_id is not null and public.has_branch_access(branch_id))
  );

drop policy if exists "device_settings_update" on public.device_settings;
create policy "device_settings_update" on public.device_settings
  for update to authenticated
  using (
    (branch_id is null and public.is_hq_admin())
    or (branch_id is not null and public.has_branch_access(branch_id))
  )
  with check (
    (branch_id is null and public.is_hq_admin())
    or (branch_id is not null and public.has_branch_access(branch_id))
  );

drop policy if exists "device_settings_delete" on public.device_settings;
create policy "device_settings_delete" on public.device_settings
  for delete to authenticated
  using (
    (branch_id is null and public.is_hq_admin())
    or (branch_id is not null and public.has_branch_access(branch_id))
  );

create or replace function public.set_device_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists device_settings_set_updated_at on public.device_settings;
create trigger device_settings_set_updated_at
  before update on public.device_settings
  for each row execute function public.set_device_settings_updated_at();

revoke all on table public.device_settings from anon;
grant select, insert, update, delete on table public.device_settings to authenticated;
