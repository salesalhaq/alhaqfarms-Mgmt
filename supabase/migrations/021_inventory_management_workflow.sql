begin;

create index if not exists ix_stock_movements_idempotency_key
  on public.stock_movements (idempotency_key) where deleted_at is null;
create index if not exists ix_audit_inventory_idempotency
  on public.audit_log (actor_id, branch_id, (details_json->>'idempotencyKey'))
  where action = 'inventory.stocktake_completed' and deleted_at is null;

create or replace function public.staff_record_inventory_action(
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
  v_product_id uuid;
  v_product public.products;
  v_now timestamptz := now();
  v_idempotency_key text;
  v_allowed boolean;
  v_delta bigint;
  v_current bigint;
  v_movement_type text;
  v_requested_type text;
  v_reference_type text;
  v_audit_action text;
  v_reason text;
  v_notes text;
  v_stocktake_id uuid;
  v_stocktake_row public.inventory_stocktakes;
  v_item jsonb;
  v_item_count integer;
  v_locked_count integer := 0;
  v_counted bigint;
  v_system bigint;
  v_variance bigint;
  v_changed_count integer := 0;
  v_total_variance bigint := 0;
  v_seen_count integer;
  v_unique_count integer;
  v_existing public.stock_movements;
  v_existing_audit jsonb;
  v_movement_id uuid;
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;
  if v_staff.local_staff_id is null then
    raise exception 'This staff account is not linked to a staff profile.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid inventory action.';
  end if;
  if p_action is null or p_action not in ('movement', 'stocktake') then
    raise exception 'Choose a supported inventory action.';
  end if;

  begin
    v_branch_id := (p_payload->>'branchId')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid target branch.';
  end;
  if v_branch_id is null
     or not public.has_branch_access(v_branch_id)
     or (v_staff.branch_id is not null and v_staff.branch_id <> v_branch_id) then
    raise exception 'You cannot record inventory for that branch.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.branches
    where id = v_branch_id and is_active and deleted_at is null
  ) then
    raise exception 'Choose an active branch.';
  end if;

  v_idempotency_key := nullif(btrim(p_payload->>'idempotencyKey'), '');
  if v_idempotency_key is null or length(v_idempotency_key) > 100 then
    raise exception 'This inventory action is missing a valid request key.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'inventory:' || v_staff.user_id::text || ':' || p_action || ':' || v_idempotency_key,
    0
  ));

  if v_staff.role <> 'admin' then
    if v_staff.role <> 'manager' then
      raise exception 'Only administrators or permitted managers can record inventory.' using errcode = '42501';
    end if;
    select permission.is_allowed into v_allowed
    from public.inventory_permissions permission
    where permission.branch_id = v_branch_id
      and permission.role = 'manager'
      and permission.action = case when p_action = 'movement' then 'record_stock_movement' else 'record_stocktake' end
      and permission.deleted_at is null
    order by permission.updated_at desc, permission.id desc
    limit 1;
    if not coalesce(v_allowed, false) then
      raise exception 'An administrator must enable this inventory action for your branch.' using errcode = '42501';
    end if;
  end if;

  if p_action = 'movement' then
    begin
      v_product_id := (p_payload->>'productId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid product.';
    end;
    if coalesce(p_payload->>'quantityDeltaMilli', '') !~ '^-?[0-9]+$' then
      raise exception 'Quantity change must be a non-zero whole number of milli-units.';
    end if;
    begin
      v_delta := (p_payload->>'quantityDeltaMilli')::bigint;
    exception when numeric_value_out_of_range then
      raise exception 'Quantity change is outside the supported range.';
    end;
    if v_delta = 0 then
      raise exception 'Quantity change must be a non-zero whole number of milli-units.';
    end if;
    if abs(v_delta::numeric) > 9007199254740991 then
      raise exception 'Quantity change is outside the supported range.';
    end if;
    v_requested_type := p_payload->>'movementType';
    if v_requested_type is null or v_requested_type not in ('opening', 'adjustment', 'damage', 'loss', 'expiry') then
      raise exception 'Choose a supported stock movement reason.';
    end if;
    if v_requested_type in ('damage', 'loss', 'expiry') and v_delta > 0 then
      raise exception 'Damage, loss and expiry movements must remove stock.';
    end if;
    v_reason := nullif(btrim(p_payload->>'reason'), '');
    if v_reason is null or length(v_reason) > 200 then
      raise exception 'Enter a reason of 200 characters or fewer.';
    end if;

    select * into v_product
    from public.products
    where id = v_product_id and deleted_at is null
    for update;
    if not found then raise exception 'Product not found.'; end if;

    v_current := coalesce((
      select sum(movement.quantity_delta_milli)
      from public.stock_movements movement
      where movement.product_id = v_product_id
        and movement.branch_id = v_branch_id
        and movement.deleted_at is null
    ), 0);

    v_movement_type := case
      when v_requested_type = 'opening' and v_current = 0 then 'opening'
      when v_requested_type in ('damage', 'loss', 'expiry') then 'damage'
      else 'adjustment'
    end;
    v_reference_type := case
      when v_requested_type in ('damage', 'loss', 'expiry') then 'inventory_' || v_requested_type
      else 'manual_adjustment'
    end;
    v_audit_action := case
      when v_requested_type in ('damage', 'loss', 'expiry') then 'stock.' || v_requested_type || '_recorded'
      else 'stock.adjusted'
    end;
    v_notes := case
      when v_requested_type in ('damage', 'loss', 'expiry') then v_requested_type || ': ' || v_reason
      else v_reason
    end;

    select * into v_existing
    from public.stock_movements
    where idempotency_key = 'manual:web:' || v_staff.user_id::text || ':' || v_idempotency_key
      and deleted_at is null
    limit 1;
    if found then
      select log.details_json into v_existing_audit
      from public.audit_log log
      where log.action = v_audit_action
        and log.actor_id = v_staff.local_staff_id
        and log.branch_id = v_branch_id
        and log.entity_id = v_product_id::text
        and log.details_json->>'idempotencyKey' = v_idempotency_key
        and log.deleted_at is null
      order by log.occurred_at desc, log.id desc
      limit 1;
      if v_existing.branch_id <> v_branch_id
         or v_existing.product_id <> v_product_id
         or v_existing.quantity_delta_milli <> v_delta
         or v_existing.reference_type <> v_reference_type
         or v_existing.notes <> v_notes
         or v_existing_audit->>'movementType' is distinct from v_requested_type
         or v_existing_audit->>'reason' is distinct from v_reason then
        raise exception 'This request key has already been used for a different stock movement.';
      end if;
      return jsonb_build_object(
        'action', p_action,
        'quantityMilli', v_current
      );
    end if;

    if v_current + v_delta < 0 then
      raise exception 'This adjustment would make branch stock negative.';
    end if;

    v_movement_id := gen_random_uuid();
    insert into public.stock_movements (
      id, idempotency_key, branch_id, product_id, movement_type, quantity_delta_milli,
      unit_cost_paisa, reference_type, reference_id, created_by, notes, occurred_at, created_at,
      server_updated_at
    ) values (
      v_movement_id, 'manual:web:' || v_staff.user_id::text || ':' || v_idempotency_key,
      v_branch_id, v_product_id, v_movement_type, v_delta,
      v_product.cost_price_paisa, v_reference_type, v_movement_id::text,
      v_staff.local_staff_id, v_notes, v_now, v_now, v_now
    );
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_branch_id, v_audit_action, 'product', v_product_id::text,
      jsonb_build_object(
        'delta', v_delta,
        'movementType', v_requested_type,
        'reason', v_reason,
        'previousQuantity', v_current,
        'nextQuantity', v_current + v_delta,
        'idempotencyKey', v_idempotency_key
      ),
      v_now, v_now
    );
    return jsonb_build_object('action', p_action, 'quantityMilli', v_current + v_delta);
  end if;

  if jsonb_typeof(p_payload->'items') <> 'array' then
    raise exception 'A stocktake must include product counts.';
  end if;
  select count(*) into v_item_count from jsonb_array_elements(p_payload->'items');
  if v_item_count < 1 or v_item_count > 1000 then
    raise exception 'A stocktake must include between 1 and 1,000 product counts.';
  end if;

  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item->>'productId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'Choose a valid product for every stocktake count.';
    end if;
    if coalesce(v_item->>'countedQuantityMilli', '') !~ '^[0-9]+$' then
      raise exception 'Enter a whole non-negative quantity for every stocktake count.';
    end if;
    if length(v_item->>'countedQuantityMilli') > 16
       or (length(v_item->>'countedQuantityMilli') = 16
           and v_item->>'countedQuantityMilli' > '9007199254740991') then
      raise exception 'Counted quantity is outside the supported range.';
    end if;
  end loop;

  select count(*), count(distinct (item.value->>'productId')::uuid)
  into v_seen_count, v_unique_count
  from jsonb_array_elements(p_payload->'items') item(value);
  if v_seen_count <> v_unique_count then
    raise exception 'A product can only be counted once per stocktake.';
  end if;

  for v_product_id in
    select product.id
    from public.products product
    where product.id in (
      select (item.value->>'productId')::uuid
      from jsonb_array_elements(p_payload->'items') item(value)
    )
      and product.deleted_at is null
    order by product.id
    for update
  loop
    v_locked_count := v_locked_count + 1;
  end loop;
  if v_locked_count <> v_item_count then
    raise exception 'A stocktake product was not found.';
  end if;

  v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
  select log.entity_id::uuid into v_stocktake_id
  from public.audit_log log
  where log.action = 'inventory.stocktake_completed'
    and log.actor_id = v_staff.local_staff_id
    and log.branch_id = v_branch_id
    and log.details_json->>'idempotencyKey' = v_idempotency_key
    and log.deleted_at is null
  order by log.occurred_at desc, log.id desc
  limit 1;
  if v_stocktake_id is not null then
    select * into v_stocktake_row
    from public.inventory_stocktakes
    where id = v_stocktake_id and deleted_at is null;
    if v_stocktake_row.branch_id <> v_branch_id or v_stocktake_row.notes is distinct from v_notes then
      raise exception 'This request key has already been used for a different stocktake.';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_payload->'items') input_item(value)
      left join public.inventory_stocktake_items saved
        on saved.stocktake_id = v_stocktake_id
       and saved.product_id = (input_item.value->>'productId')::uuid
       and saved.deleted_at is null
      where saved.id is null
         or saved.counted_quantity_milli <> (input_item.value->>'countedQuantityMilli')::bigint
    ) or (
      select count(*) from public.inventory_stocktake_items saved
      where saved.stocktake_id = v_stocktake_id and saved.deleted_at is null
    ) <> v_item_count then
      raise exception 'This request key has already been used for different stocktake counts.';
    end if;
    select count(*)::integer,
           count(*) filter (where item.variance_milli <> 0)::integer,
           coalesce(sum(item.variance_milli), 0)::bigint
    into v_item_count, v_changed_count, v_total_variance
    from public.inventory_stocktake_items item
    where item.stocktake_id = v_stocktake_id and item.deleted_at is null;
    return jsonb_build_object(
      'action', p_action,
      'id', v_stocktake_id,
      'itemCount', v_item_count,
      'changedCount', v_changed_count,
      'totalVarianceMilli', v_total_variance
    );
  end if;

  v_stocktake_id := gen_random_uuid();
  insert into public.inventory_stocktakes (
    id, branch_id, created_by, notes, created_at, server_updated_at
  ) values (v_stocktake_id, v_branch_id, v_staff.local_staff_id, v_notes, v_now, v_now);

  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    v_product_id := (v_item->>'productId')::uuid;
    v_counted := (v_item->>'countedQuantityMilli')::bigint;
    select * into v_product
    from public.products
    where id = v_product_id and deleted_at is null;
    v_system := coalesce((
      select sum(movement.quantity_delta_milli)
      from public.stock_movements movement
      where movement.product_id = v_product_id
        and movement.branch_id = v_branch_id
        and movement.deleted_at is null
    ), 0);
    v_variance := v_counted - v_system;
    v_total_variance := v_total_variance + v_variance;
    if v_variance <> 0 then v_changed_count := v_changed_count + 1; end if;

    insert into public.inventory_stocktake_items (
      id, stocktake_id, product_id, product_name, unit_code,
      system_quantity_milli, counted_quantity_milli, variance_milli, server_updated_at
    ) values (
      gen_random_uuid(), v_stocktake_id, v_product_id, v_product.name, v_product.unit_code,
      v_system, v_counted, v_variance, v_now
    );
    if v_variance <> 0 then
      insert into public.stock_movements (
        id, idempotency_key, branch_id, product_id, movement_type, quantity_delta_milli,
        unit_cost_paisa, reference_type, reference_id, created_by, notes, occurred_at, created_at,
        server_updated_at
      ) values (
        gen_random_uuid(),
        'stocktake:web:' || v_staff.user_id::text || ':' || v_idempotency_key || ':' || v_product_id::text,
        v_branch_id, v_product_id, 'stocktake', v_variance, v_product.cost_price_paisa,
        'inventory_stocktake', v_stocktake_id::text, v_staff.local_staff_id,
        coalesce(v_notes, 'Physical stocktake reconciliation'), v_now, v_now, v_now
      );
    end if;
  end loop;

  insert into public.audit_log (
    id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
  ) values (
    gen_random_uuid(), v_staff.local_staff_id, v_branch_id, 'inventory.stocktake_completed',
    'inventory_stocktake', v_stocktake_id::text,
    jsonb_build_object(
      'itemCount', v_item_count,
      'changedCount', v_changed_count,
      'totalVarianceMilli', v_total_variance,
      'notes', v_notes,
      'idempotencyKey', v_idempotency_key
    ),
    v_now, v_now
  );
  return jsonb_build_object(
    'action', p_action,
    'id', v_stocktake_id,
    'itemCount', v_item_count,
    'changedCount', v_changed_count,
    'totalVarianceMilli', v_total_variance
  );
end;
$$;

revoke all on function public.staff_record_inventory_action(text, jsonb) from public, anon;
grant execute on function public.staff_record_inventory_action(text, jsonb) to authenticated;

commit;
