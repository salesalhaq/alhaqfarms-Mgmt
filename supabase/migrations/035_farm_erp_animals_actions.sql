begin;

create or replace function public.manage_web_animal(
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
  v_batch_id uuid;
  v_batch public.animal_batches;
  v_species_id uuid;
  v_species public.animal_species;
  v_name text;
  v_species_name text;
  v_batch_type text;
  v_event_type text;
  v_event_date date;
  v_heads integer := 0;
  v_heads_delta integer := 0;
  v_quantity bigint := 0;
  v_unit_cost bigint := 0;
  v_amount bigint := 0;
  v_product_id uuid;
  v_notes text;
  v_head_count bigint;
  v_cost_pool bigint;
  v_stock_balance bigint;
  v_now timestamptz := now();
  v_id uuid;
begin
  if not public.is_admin_role() then
    raise exception 'Farm animal actions are restricted to administrators.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid animal action.';
  end if;
  select staff.local_staff_id into v_actor_id
  from public.cloud_staff staff
  where staff.user_id = auth.uid() and staff.is_active;
  if v_actor_id is null then
    raise exception 'Your staff profile is not linked for animal actions.';
  end if;

  if p_action = 'save-batch' then
    begin
      v_branch_id := (p_payload->>'branchId')::uuid;
      v_species_id := (p_payload->>'speciesId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid branch and animal species.';
    end;
    if not public.has_branch_access(v_branch_id) then
      raise exception 'You cannot manage animals at that branch.';
    end if;
    v_name := nullif(btrim(p_payload->>'name'), '');
    v_batch_type := coalesce(p_payload->>'batchType', 'terminal');
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), '');
    if v_name is null or length(v_name) > 120 then
      raise exception 'Enter a batch name of 120 characters or fewer.';
    end if;
    if v_batch_type not in ('terminal', 'continuous') then
      raise exception 'Choose a supported batch type.';
    end if;
    if coalesce(p_payload->>'openingDate', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Choose a valid opening date.';
    end if;
    begin
      perform (p_payload->>'openingDate')::date;
      if coalesce(p_payload->>'openingHeads', '') !~ '^\d{1,7}$' then
        raise exception 'Opening head count must be between 0 and 1,000,000.';
      end if;
      if (p_payload->>'openingHeads')::bigint > 1000000 then
        raise exception 'Opening head count must be between 0 and 1,000,000.';
      end if;
      if coalesce(p_payload->>'openingCostPaisa', '') !~ '^\d{1,15}$' then
        raise exception 'Enter a valid opening purchase cost.';
      end if;
    exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      raise exception 'Choose a valid opening date, head count, and opening purchase cost.';
    end;
    if (p_payload->>'openingDate')::date > (now() at time zone 'Asia/Karachi')::date then
      raise exception 'Opening date cannot be in the future.';
    end if;
    select * into v_species from public.animal_species
    where id = v_species_id and deleted_at is null for share;
    if not found then raise exception 'Choose an animal species.'; end if;
    v_species_name := v_species.name;

    if nullif(p_payload->>'id', '') is not null then
      begin
        v_batch_id := (p_payload->>'id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid animal batch.';
      end;
      select * into v_batch from public.animal_batches
      where id = v_batch_id and deleted_at is null for update;
      if not found or not public.has_branch_access(v_batch.branch_id) then
        raise exception 'Animal batch not found at an accessible branch.';
      end if;
      if v_batch.status <> 'open' then raise exception 'A closed batch cannot be edited.'; end if;
      if v_species.is_active <> 1 and v_species_id <> v_batch.species_id then
        raise exception 'Choose an active animal species.';
      end if;
      v_branch_id := v_batch.branch_id;
      perform pg_advisory_xact_lock(hashtext(v_branch_id::text || ':' || lower(v_name)));
      if v_batch.batch_type <> v_batch_type and exists (
        select 1 from public.production_runs
        where animal_batch_id = v_batch_id and deleted_at is null
      ) then
        raise exception 'The batch type cannot change after production has been recorded.';
      end if;
      if exists (
        select 1 from public.animal_batches other
        where other.branch_id = v_branch_id and lower(other.name) = lower(v_name)
          and other.id <> v_batch_id and other.deleted_at is null
      ) then
        raise exception 'Another batch at this branch already uses this name.';
      end if;
      update public.animal_batches
      set name = v_name,
          species = case when v_species_name in ('goat','sheep','cattle','poultry','fish') then v_species_name else 'other' end,
          species_id = v_species_id,
          batch_type = v_batch_type,
          opening_heads = (p_payload->>'openingHeads')::bigint,
          opening_date = (p_payload->>'openingDate')::date,
          opening_cost_paisa = (p_payload->>'openingCostPaisa')::bigint,
          notes = v_notes,
          updated_at = v_now,
          server_updated_at = v_now
      where id = v_batch_id;
    else
      if v_species.is_active <> 1 then raise exception 'Choose an active animal species.'; end if;
      perform pg_advisory_xact_lock(hashtext(v_branch_id::text || ':' || lower(v_name)));
      if exists (
        select 1 from public.animal_batches other
        where other.branch_id = v_branch_id and lower(other.name) = lower(v_name) and other.deleted_at is null
      ) then
        raise exception 'Another batch at this branch already uses this name.';
      end if;
      v_batch_id := gen_random_uuid();
      insert into public.animal_batches (
        id, branch_id, name, species, species_id, batch_type, opening_heads, opening_date,
        opening_cost_paisa, notes, created_by, created_at, updated_at, server_updated_at
      ) values (
        v_batch_id, v_branch_id, v_name,
        case when v_species_name in ('goat','sheep','cattle','poultry','fish') then v_species_name else 'other' end,
        v_species_id, v_batch_type, (p_payload->>'openingHeads')::bigint,
        (p_payload->>'openingDate')::date, (p_payload->>'openingCostPaisa')::bigint,
        v_notes, v_actor_id, v_now, v_now, v_now
      );
    end if;
    insert into public.audit_log(id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at)
    values(
      gen_random_uuid(), v_actor_id, v_branch_id,
      case when nullif(p_payload->>'id', '') is not null then 'animal_batch.updated' else 'animal_batch.created' end,
      'animal_batch', v_batch_id::text,
      jsonb_build_object('name', v_name, 'speciesId', v_species_id, 'batchType', v_batch_type),
      v_now, v_now
    );
    return jsonb_build_object('id', v_batch_id, 'name', v_name);
  end if;

  if p_action = 'save-species' then
    v_name := nullif(btrim(p_payload->>'name'), '');
    if v_name is null or length(v_name) > 60 then
      raise exception 'Enter a species name of 60 characters or fewer.';
    end if;
    if coalesce(p_payload->>'sortOrder', '') !~ '^\d{1,6}$' then
      raise exception 'Enter a valid species sort order.';
    end if;
    if (p_payload->>'sortOrder')::integer > 100000 then
      raise exception 'Enter a valid species sort order.';
    end if;
    if coalesce(p_payload->>'isActive', '') not in ('true','false') then
      raise exception 'Choose a valid species status.';
    end if;
    if nullif(p_payload->>'id', '') is not null then
      begin
        v_species_id := (p_payload->>'id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid animal species.';
      end;
    end if;
    perform pg_advisory_xact_lock(hashtext('animal_species:' || lower(v_name)));
    if exists (
      select 1 from public.animal_species other
      where lower(other.name) = lower(v_name) and other.id is distinct from v_species_id and other.deleted_at is null
    ) then
      raise exception 'Another species already uses this name.';
    end if;
    if v_species_id is null then
      v_species_id := gen_random_uuid();
      insert into public.animal_species(id,name,is_active,sort_order,created_at,updated_at,server_updated_at)
      values(
        v_species_id, v_name, case when (p_payload->>'isActive')::boolean then 1 else 0 end,
        (p_payload->>'sortOrder')::integer, v_now, v_now, v_now
      );
    else
      update public.animal_species
      set name = v_name,
          is_active = case when (p_payload->>'isActive')::boolean then 1 else 0 end,
          sort_order = (p_payload->>'sortOrder')::integer,
          updated_at = v_now,
          server_updated_at = v_now
      where id = v_species_id and deleted_at is null;
      if not found then raise exception 'Species not found.'; end if;
    end if;
    insert into public.audit_log(id,actor_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
    values(
      gen_random_uuid(), v_actor_id,
      case when nullif(p_payload->>'id', '') is null then 'animal_species.created' else 'animal_species.updated' end,
      'animal_species', v_species_id::text,
      jsonb_build_object(
        'name',v_name,'isActive',(p_payload->>'isActive')::boolean,'sortOrder',(p_payload->>'sortOrder')::integer
      ),
      v_now,v_now
    );
    return jsonb_build_object('id',v_species_id,'name',v_name);
  end if;

  if p_action = 'deactivate-species' then
    begin
      v_species_id := (p_payload->>'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid animal species.';
    end;
    update public.animal_species
    set is_active = 0, updated_at = v_now, server_updated_at = v_now
    where id = v_species_id and deleted_at is null returning name into v_name;
    if not found then raise exception 'Species not found.'; end if;
    insert into public.audit_log(id,actor_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
    values(gen_random_uuid(),v_actor_id,'animal_species.deactivated','animal_species',v_species_id::text,
      jsonb_build_object('name',v_name),v_now,v_now);
    return jsonb_build_object('id',v_species_id);
  end if;

  begin
    v_batch_id := (p_payload->>'batchId')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid animal batch.';
  end;
  select * into v_batch from public.animal_batches
  where id = v_batch_id and deleted_at is null for update;
  if not found or not public.has_branch_access(v_batch.branch_id) then
    raise exception 'Animal batch not found at an accessible branch.';
  end if;
  v_branch_id := v_batch.branch_id;

  if p_action = 'close-batch' then
    if v_batch.status <> 'open' then raise exception 'This batch is already closed.'; end if;
    update public.animal_batches
    set status = 'closed', closed_by = v_actor_id, closed_at = v_now, updated_at = v_now, server_updated_at = v_now
    where id = v_batch_id;
    insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
    values(gen_random_uuid(),v_actor_id,v_branch_id,'animal_batch.closed','animal_batch',v_batch_id::text,
      jsonb_build_object('name',v_batch.name),v_now,v_now);
    return jsonb_build_object('id',v_batch_id,'status','closed');
  end if;
  if p_action <> 'record-event' then raise exception 'Choose a supported animal action.'; end if;
  if v_batch.status <> 'open' then raise exception 'A closed animal batch cannot receive events.'; end if;

  v_event_type := p_payload->>'eventType';
  if v_event_type is null or v_event_type not in ('mortality','purchase','feed','weight','sale','note') then
    raise exception 'Choose a supported animal event type.';
  end if;
  if coalesce(p_payload->>'eventDate','') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Choose a valid event date.';
  end if;
  begin
    v_event_date := (p_payload->>'eventDate')::date;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'Choose a valid event date.';
  end;
  if v_event_date > (now() at time zone 'Asia/Karachi')::date then
    raise exception 'Event date cannot be in the future.';
  end if;
  v_notes := nullif(left(btrim(coalesce(p_payload->>'notes','')),500),'');

  if v_event_type in ('mortality','purchase','sale') then
    if coalesce(p_payload->>'heads','') !~ '^\d{1,6}$' then
      raise exception 'Head count must be between 1 and 100,000.';
    end if;
    v_heads := (p_payload->>'heads')::integer;
    if v_heads < 1 or v_heads > 100000 then
      raise exception 'Head count must be between 1 and 100,000.';
    end if;
    v_heads_delta := case when v_event_type = 'purchase' then v_heads else -v_heads end;
  end if;
  if v_event_type = 'purchase' then
    if coalesce(p_payload->>'amountPaisa','') !~ '^\d{1,15}$' then
      raise exception 'Enter a valid purchase cost.';
    end if;
    v_amount := (p_payload->>'amountPaisa')::bigint;
    v_unit_cost := round(v_amount::numeric / v_heads)::bigint;
  end if;
  if v_event_type in ('feed','weight') then
    if coalesce(p_payload->>'quantityMilli','') !~ '^\d{1,15}$' then
      raise exception 'Enter a quantity greater than zero.';
    end if;
    v_quantity := (p_payload->>'quantityMilli')::bigint;
    if v_quantity < 1 then raise exception 'Enter a quantity greater than zero.'; end if;
    if v_event_type = 'feed' and coalesce(p_payload->>'unitCostPaisa','0') !~ '^\d{1,15}$' then
      raise exception 'Enter a valid unit cost.';
    end if;
    if v_event_type = 'feed' then
      v_unit_cost := coalesce((p_payload->>'unitCostPaisa')::bigint,0);
    end if;
  end if;
  if v_event_type = 'feed' then
    if v_unit_cost::numeric * v_quantity / 1000 > 9223372036854775807 then
      raise exception 'Feed cost is too large to record.';
    end if;
    v_amount := round(v_unit_cost::numeric * v_quantity / 1000)::bigint;
    if nullif(p_payload->>'productId','') is not null then
      begin
        v_product_id := (p_payload->>'productId')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid feed product.';
      end;
    end if;
  end if;

  select v_batch.opening_heads + coalesce(sum(event.heads_delta),0)
  into v_head_count
  from public.animal_batch_events event
  where event.batch_id = v_batch_id and event.deleted_at is null;
  if v_heads_delta < 0 and v_head_count + v_heads_delta < 0 then
    raise exception 'Only % head remain in this batch.', v_head_count;
  end if;
  if v_heads_delta < 0 then
    select greatest(
      v_batch.opening_cost_paisa
        + coalesce(sum(case when event.event_type in ('purchase','feed') then event.amount_paisa else 0 end),0)
        - coalesce(sum(case when event.event_type in ('mortality','sale','production') then event.amount_paisa else 0 end),0),
      0
    )
    into v_cost_pool
    from public.animal_batch_events event
    where event.batch_id = v_batch_id and event.deleted_at is null;
    v_amount := case when v_head_count > 0
      then round(v_cost_pool::numeric * -v_heads_delta / v_head_count)::bigint
      else 0 end;
  end if;

  if v_product_id is not null then
    select product.id into v_id
    from public.products product
    where product.id = v_product_id and product.is_active and product.deleted_at is null
    for share;
    if not found then
      raise exception 'Feed product not found or inactive.';
    end if;
    perform pg_advisory_xact_lock(hashtext(v_branch_id::text || ':' || v_product_id::text));
    select coalesce(sum(movement.quantity_delta_milli),0)
    into v_stock_balance
    from public.stock_movements movement
    where movement.branch_id = v_branch_id and movement.product_id = v_product_id and movement.deleted_at is null;
    if v_stock_balance < v_quantity then raise exception 'Not enough feed stock in this branch.'; end if;
  end if;

  v_id := gen_random_uuid();
  insert into public.animal_batch_events(
    id,batch_id,branch_id,event_date,event_type,heads_delta,quantity_milli,unit_cost_paisa,amount_paisa,
    product_id,notes,recorded_by,created_at,server_updated_at
  ) values(
    v_id,v_batch_id,v_branch_id,v_event_date,v_event_type,v_heads_delta,v_quantity,v_unit_cost,v_amount,
    v_product_id,v_notes,v_actor_id,v_now,v_now
  );
  if v_product_id is not null then
    insert into public.stock_movements(
      id,idempotency_key,branch_id,product_id,movement_type,quantity_delta_milli,unit_cost_paisa,
      reference_type,reference_id,created_by,notes,occurred_at,created_at,server_updated_at
    ) values(
      gen_random_uuid(),'animal_feed:'||v_id::text,v_branch_id,v_product_id,'adjustment',-v_quantity,
      v_unit_cost,'animal_feed',v_id::text,v_actor_id,'Feed issued to '||v_batch.name,v_now,v_now,v_now
    );
  end if;
  insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
  values(
    gen_random_uuid(),v_actor_id,v_branch_id,'animal_event.recorded','animal_batch_event',v_id::text,
    jsonb_build_object('batchId',v_batch_id,'eventType',v_event_type,'headsDelta',v_heads_delta,
      'quantityMilli',v_quantity,'amountPaisa',v_amount),
    v_now,v_now
  );
  return jsonb_build_object(
    'id',v_id,'batchId',v_batch_id,'eventType',v_event_type,'headsDelta',v_heads_delta,
    'quantityMilli',v_quantity,'amountPaisa',v_amount
  );
end;
$$;

revoke all on function public.manage_web_animal(text,jsonb) from public;
grant execute on function public.manage_web_animal(text,jsonb) to authenticated;

commit;
