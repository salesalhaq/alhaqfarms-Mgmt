begin;

create or replace function public.staff_manage_stock_transfer(
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
  v_transfer public.stock_transfers;
  v_product public.products;
  v_item public.stock_transfer_items;
  v_permission text;
  v_now timestamptz := now();
  v_transfer_id uuid;
  v_from_branch_id uuid;
  v_to_branch_id uuid;
  v_product_id uuid;
  v_quantity bigint;
  v_received bigint;
  v_stock bigint;
  v_item_count integer;
  v_unique_count integer;
  v_locked_count integer := 0;
  v_short_lines integer := 0;
  v_module_key text;
  v_permission_key text;
  v_allowed boolean;
  v_idempotency_key text;
  v_audit_action text;
  v_existing_id uuid;
  v_prior_audit public.audit_log;
  v_destination_name text;
  v_source_name text;
  v_notes text;
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() or v_staff.local_staff_id is null then
    raise exception 'Sign in with an active staff account.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid stock transfer action.';
  end if;
  if p_action is null or p_action not in ('create', 'dispatch', 'receive', 'cancel') then
    raise exception 'Choose a supported stock transfer action.';
  end if;

  v_idempotency_key := nullif(btrim(p_payload->>'idempotencyKey'), '');
  if v_idempotency_key is null or length(v_idempotency_key) > 100 then
    raise exception 'This transfer action is missing a valid request key.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'stock-transfer:' || v_staff.user_id::text || ':' || p_action || ':' || v_idempotency_key,
    0
  ));
  v_audit_action := case p_action
    when 'create' then 'transfer.created'
    when 'dispatch' then 'transfer.dispatched'
    when 'receive' then 'transfer.received'
    else 'transfer.cancelled'
  end;
  select * into v_prior_audit
  from public.audit_log log
  where log.actor_id = v_staff.local_staff_id
    and log.action = v_audit_action
    and log.details_json->>'idempotencyKey' = v_idempotency_key
    and log.deleted_at is null
  order by log.occurred_at desc, log.id desc
  limit 1;
  if found then
    v_existing_id := v_prior_audit.entity_id::uuid;
    if p_action = 'create' then
      if (v_prior_audit.details_json->>'fromBranchId')::uuid
           is distinct from (p_payload->>'fromBranchId')::uuid
         or (v_prior_audit.details_json->>'toBranchId')::uuid
           is distinct from (p_payload->>'toBranchId')::uuid
         or v_prior_audit.details_json->'items' is distinct from p_payload->'items'
         or v_prior_audit.details_json->>'notes'
           is distinct from nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '') then
        raise exception 'This request key has already been used for a different transfer.';
      end if;
    elsif (p_payload->>'transferId')::uuid is distinct from v_existing_id
       or (p_action = 'receive'
         and v_prior_audit.details_json->'items'
           is distinct from coalesce(p_payload->'items', 'null'::jsonb)) then
      raise exception 'This request key has already been used for a different transfer.';
    end if;
    return jsonb_build_object('id', v_existing_id, 'duplicate', true);
  end if;

  if p_action = 'create' then
    begin
      v_from_branch_id := (p_payload->>'fromBranchId')::uuid;
      v_to_branch_id := (p_payload->>'toBranchId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose valid source and destination branches.';
    end;
    if v_from_branch_id is null or v_to_branch_id is null or v_from_branch_id = v_to_branch_id then
      raise exception 'Choose different source and destination branches.';
    end if;
    if not public.has_branch_access(v_from_branch_id)
       or (v_staff.branch_id is not null and v_staff.branch_id <> v_from_branch_id) then
      raise exception 'You cannot transfer stock from that branch.' using errcode = '42501';
    end if;
    if v_staff.role not in ('admin', 'manager') then
      raise exception 'Only managers and admins can create transfers.' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.branches
      where id = v_from_branch_id and is_active and deleted_at is null
    ) or not exists (
      select 1 from public.branches
      where id = v_to_branch_id and is_active and deleted_at is null
    ) then
      raise exception 'Choose active source and destination branches.';
    end if;

    if v_staff.role <> 'admin' then
      for v_permission in
        select unnest(array[
          'module:transfers:view',
          'module:transfers:manage',
          'action:create_transfer'
        ])
      loop
        select permission.is_allowed into v_allowed
        from public.branch_module_permissions permission
        where permission.branch_id = v_from_branch_id
          and permission.role = v_staff.role
          and permission.permission_key = v_permission
          and permission.deleted_at is null
        order by permission.updated_at desc, permission.id desc
        limit 1;
        if not coalesce(v_allowed, true) then
          raise exception 'Your role does not allow creating or managing transfers.' using errcode = '42501';
        end if;
      end loop;
    end if;
    if jsonb_typeof(p_payload->'items') is distinct from 'array' then
      raise exception 'A transfer must include between 1 and 200 products.';
    end if;
    v_item_count := jsonb_array_length(p_payload->'items');
    if v_item_count < 1 or v_item_count > 200 then
      raise exception 'A transfer must include between 1 and 200 products.';
    end if;
    select count(*)::integer,
           count(distinct (entry.value->>'productId')::uuid)::integer
    into v_item_count, v_unique_count
    from jsonb_array_elements(p_payload->'items') entry(value);
    if v_item_count <> v_unique_count then
      raise exception 'A product can only appear once in a transfer.';
    end if;
    for v_product_id in
      select product.id
      from public.products product
      where product.id in (
        select (entry.value->>'productId')::uuid
        from jsonb_array_elements(p_payload->'items') entry(value)
      )
        and product.deleted_at is null
        and product.is_active
      order by product.id
      for update
    loop
      v_locked_count := v_locked_count + 1;
    end loop;
    if v_locked_count <> v_item_count then
      raise exception 'A transfer product is no longer active.';
    end if;

    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    v_transfer_id := gen_random_uuid();
    insert into public.stock_transfers (
      id, transfer_number, from_branch_id, to_branch_id, status, notes, created_by,
      created_at, updated_at, server_updated_at
    ) values (
      v_transfer_id,
      'TRF-' || to_char(v_now at time zone 'UTC', 'YYMMDDHH24MISS') || '-'
        || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
      v_from_branch_id, v_to_branch_id, 'draft', v_notes, v_staff.local_staff_id,
      v_now, v_now, v_now
    );

    for v_product_id, v_quantity in
      select (entry.value->>'productId')::uuid,
             (entry.value->>'quantityMilli')::bigint
      from jsonb_array_elements(p_payload->'items') entry(value)
    loop
      if v_quantity is null or v_quantity < 1 or v_quantity > 9007199254740991 then
        raise exception 'Transfer quantities must be positive and within the supported range.';
      end if;
      select * into v_product
      from public.products
      where id = v_product_id and deleted_at is null and is_active;
      if not found then raise exception 'A transfer product is no longer active.'; end if;
      insert into public.stock_transfer_items (
        id, transfer_id, product_id, product_name, unit_code, quantity_milli,
        received_quantity_milli, unit_cost_paisa, created_at, server_updated_at
      ) values (
        gen_random_uuid(), v_transfer_id, v_product.id, v_product.name, v_product.unit_code,
        v_quantity, 0, v_product.cost_price_paisa, v_now, v_now
      );
    end loop;
    select name into v_destination_name from public.branches where id = v_to_branch_id;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_from_branch_id, 'transfer.created',
      'stock_transfer', v_transfer_id::text,
      jsonb_build_object(
        'fromBranchId', v_from_branch_id,
        'toBranchId', v_to_branch_id,
        'toBranchName', v_destination_name,
        'itemCount', v_item_count,
        'notes', v_notes,
        'items', p_payload->'items',
        'idempotencyKey', v_idempotency_key
      ),
      v_now, v_now
    );
    return jsonb_build_object('id', v_transfer_id, 'duplicate', false);
  end if;

  begin
    v_transfer_id := (p_payload->>'transferId')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid transfer.';
  end;
  select * into v_transfer
  from public.stock_transfers
  where id = v_transfer_id and deleted_at is null
  for update;
  if not found then raise exception 'Transfer not found.'; end if;
  v_from_branch_id := v_transfer.from_branch_id;
  v_to_branch_id := v_transfer.to_branch_id;

  if v_staff.role not in ('admin', 'manager') then
    raise exception 'Only managers and admins can manage transfers.' using errcode = '42501';
  end if;
  if v_staff.branch_id is not null
     and v_staff.branch_id not in (v_from_branch_id, v_to_branch_id) then
    raise exception 'This transfer does not belong to your branch.' using errcode = '42501';
  end if;
  if v_staff.role <> 'admin' and (
    (p_action in ('dispatch', 'cancel') and v_staff.branch_id <> v_from_branch_id)
    or (p_action = 'receive' and v_staff.branch_id <> v_to_branch_id)
  ) then
    raise exception 'Only the appropriate sending or receiving branch can perform this action.' using errcode = '42501';
  end if;
  if not public.has_branch_access(v_from_branch_id) and not public.has_branch_access(v_to_branch_id) then
    raise exception 'This transfer is not available to your account.' using errcode = '42501';
  end if;

  if v_staff.role <> 'admin' then
    v_module_key := case when p_action = 'receive' then 'module:receive_stock:view' else 'module:transfers:view' end;
    select permission.is_allowed into v_allowed
    from public.branch_module_permissions permission
    where permission.branch_id = case when p_action = 'receive' then v_to_branch_id else v_from_branch_id end
      and permission.role = v_staff.role
      and permission.permission_key = v_module_key
      and permission.deleted_at is null
    order by permission.updated_at desc, permission.id desc
    limit 1;
    if not coalesce(v_allowed, true) then
      raise exception 'Your role cannot access this transfer workflow.' using errcode = '42501';
    end if;
    v_permission_key := case
      when p_action = 'receive' then 'action:receive_transfer'
      else 'module:transfers:manage'
    end;
    select permission.is_allowed into v_allowed
    from public.branch_module_permissions permission
    where permission.branch_id = case when p_action = 'receive' then v_to_branch_id else v_from_branch_id end
      and permission.role = v_staff.role
      and permission.permission_key = v_permission_key
      and permission.deleted_at is null
    order by permission.updated_at desc, permission.id desc
    limit 1;
    if not coalesce(v_allowed, true) then
      raise exception 'Your role does not allow this transfer action.' using errcode = '42501';
    end if;
  end if;

  if p_action = 'dispatch' then
    if v_transfer.status <> 'draft' then
      raise exception 'Only a draft transfer can be dispatched.';
    end if;
    select count(*)::integer into v_item_count
    from public.stock_transfer_items
    where transfer_id = v_transfer.id and deleted_at is null;
    if v_item_count = 0 then raise exception 'This transfer has no items.'; end if;
    for v_item in
      select item.* from public.stock_transfer_items item
      where item.transfer_id = v_transfer.id and item.deleted_at is null
      order by item.product_id
      for update
    loop
      select * into v_product
      from public.products
      where id = v_item.product_id and deleted_at is null
      for update;
      if not found then raise exception '% is no longer available.', v_item.product_name; end if;
      select coalesce(sum(movement.quantity_delta_milli), 0)::bigint into v_stock
      from public.stock_movements movement
      where movement.product_id = v_item.product_id
        and movement.branch_id = v_from_branch_id
        and movement.deleted_at is null;
      if v_stock < v_item.quantity_milli then
        raise exception 'Not enough stock for %: % milli-units short.',
          v_item.product_name, v_item.quantity_milli - v_stock;
      end if;
      insert into public.stock_movements (
        id, idempotency_key, branch_id, product_id, movement_type, quantity_delta_milli,
        unit_cost_paisa, reference_type, reference_id, created_by, notes, occurred_at,
        created_at, server_updated_at
      ) values (
        gen_random_uuid(), 'transfer_out:' || v_transfer.id::text || ':' || v_item.product_id::text,
        v_from_branch_id, v_item.product_id, 'transfer_out', -v_item.quantity_milli,
        v_item.unit_cost_paisa, 'stock_transfer', v_transfer.id::text, v_staff.local_staff_id,
        'Transfer ' || v_transfer.transfer_number, v_now, v_now, v_now
      );
    end loop;
    update public.stock_transfers
    set status = 'dispatched', dispatched_by = v_staff.local_staff_id,
        dispatched_at = v_now, updated_at = v_now, server_updated_at = v_now
    where id = v_transfer.id and status = 'draft';
    if not found then raise exception 'This transfer has already changed.'; end if;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_from_branch_id, 'transfer.dispatched',
      'stock_transfer', v_transfer.id::text,
      jsonb_build_object('itemCount', v_item_count, 'idempotencyKey', v_idempotency_key),
      v_now, v_now
    );
  elsif p_action = 'receive' then
    if v_transfer.status <> 'dispatched' then
      raise exception 'Only a dispatched transfer can be received.';
    end if;
    if jsonb_typeof(p_payload->'items') is not null
       and jsonb_typeof(p_payload->'items') is distinct from 'array' then
      raise exception 'Enter valid received quantities for this transfer.';
    end if;
    if jsonb_typeof(p_payload->'items') = 'array' then
      v_item_count := jsonb_array_length(p_payload->'items');
      if v_item_count > 200 then
        raise exception 'A transfer cannot contain more than 200 product lines.';
      end if;
    end if;
    if jsonb_typeof(p_payload->'items') = 'array' then
      select count(*)::integer,
             count(distinct (entry.value->>'itemId'))::integer
      into v_item_count, v_unique_count
      from jsonb_array_elements(p_payload->'items') entry(value);
      if v_item_count <> v_unique_count then
        raise exception 'Each transfer line can only be confirmed once.';
      end if;
      if exists (
        select 1
        from jsonb_array_elements(p_payload->'items') entry(value)
        left join public.stock_transfer_items line
          on line.id = (entry.value->>'itemId')::uuid
         and line.transfer_id = v_transfer.id
         and line.deleted_at is null
        where line.id is null
      ) then
        raise exception 'A confirmed line does not belong to this transfer.';
      end if;
    end if;
    select name into v_source_name from public.branches where id = v_from_branch_id;
    select count(*)::integer into v_item_count
    from public.stock_transfer_items
    where transfer_id = v_transfer.id and deleted_at is null;
    if v_item_count = 0 then raise exception 'This transfer has no items.'; end if;
    for v_item in
      select item.* from public.stock_transfer_items item
      where item.transfer_id = v_transfer.id and item.deleted_at is null
      order by item.product_id
      for update
    loop
      v_received := v_item.quantity_milli;
      if jsonb_typeof(p_payload->'items') = 'array' then
        select (entry.value->>'receivedQuantityMilli')::bigint into v_received
        from jsonb_array_elements(p_payload->'items') entry(value)
        where (entry.value->>'itemId')::uuid = v_item.id;
        if not found then v_received := v_item.quantity_milli; end if;
      end if;
      if v_received is null or v_received < 0 or v_received > v_item.quantity_milli
         or v_received > 9007199254740991 then
        raise exception 'Received quantity for % must be between zero and the sent quantity.',
          v_item.product_name;
      end if;
      if v_received < v_item.quantity_milli then v_short_lines := v_short_lines + 1; end if;
      if v_received > 0 then
        insert into public.stock_movements (
          id, idempotency_key, branch_id, product_id, movement_type, quantity_delta_milli,
          unit_cost_paisa, reference_type, reference_id, created_by, notes, occurred_at,
          created_at, server_updated_at
        ) values (
          gen_random_uuid(), 'transfer_in:' || v_transfer.id::text || ':' || v_item.product_id::text,
          v_to_branch_id, v_item.product_id, 'transfer_in', v_received,
          v_item.unit_cost_paisa, 'stock_transfer', v_transfer.id::text, v_staff.local_staff_id,
          'Transfer ' || v_transfer.transfer_number || ' from ' || coalesce(v_source_name, 'source branch'),
          v_now, v_now, v_now
        );
      end if;
      update public.stock_transfer_items
      set received_quantity_milli = v_received, server_updated_at = v_now
      where id = v_item.id;
    end loop;
    update public.stock_transfers
    set status = 'received', received_by = v_staff.local_staff_id,
        received_at = v_now, updated_at = v_now, server_updated_at = v_now
    where id = v_transfer.id and status = 'dispatched';
    if not found then raise exception 'This transfer has already changed.'; end if;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_to_branch_id, 'transfer.received',
      'stock_transfer', v_transfer.id::text,
      jsonb_build_object(
        'itemCount', v_item_count,
        'shortLines', v_short_lines,
        'items', coalesce(p_payload->'items', 'null'::jsonb),
        'idempotencyKey', v_idempotency_key
      ),
      v_now, v_now
    );
  else
    if v_transfer.status <> 'draft' then
      raise exception 'Only a draft transfer can be cancelled.';
    end if;
    update public.stock_transfers
    set status = 'cancelled', cancelled_by = v_staff.local_staff_id,
        cancelled_at = v_now, updated_at = v_now, server_updated_at = v_now
    where id = v_transfer.id and status = 'draft';
    if not found then raise exception 'This transfer has already changed.'; end if;
    insert into public.audit_log (
      id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at
    ) values (
      gen_random_uuid(), v_staff.local_staff_id, v_from_branch_id, 'transfer.cancelled',
      'stock_transfer', v_transfer.id::text,
      jsonb_build_object('idempotencyKey', v_idempotency_key),
      v_now, v_now
    );
  end if;

  return jsonb_build_object('id', v_transfer.id, 'duplicate', false);
end;
$$;

create or replace function public.get_staff_transfer_branches()
returns table (id uuid, name text, code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff() then
    raise exception 'Sign in with an active staff account.' using errcode = '42501';
  end if;
  return query
  select branch.id, branch.name, branch.code
  from public.branches branch
  where branch.is_active and branch.deleted_at is null
  order by branch.name, branch.id;
end;
$$;

revoke all on function public.staff_manage_stock_transfer(text, jsonb) from public, anon;
grant execute on function public.staff_manage_stock_transfer(text, jsonb) to authenticated;
revoke all on function public.get_staff_transfer_branches() from public, anon;
grant execute on function public.get_staff_transfer_branches() to authenticated;

commit;
