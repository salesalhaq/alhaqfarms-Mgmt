begin;

create or replace function public.manage_web_production_run(p_payload jsonb)
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
  v_product record;
  v_line jsonb;
  v_clean_inputs jsonb := '[]'::jsonb;
  v_clean_outputs jsonb := '[]'::jsonb;
  v_input_product_ids uuid[] := array[]::uuid[];
  v_output_product_ids uuid[] := array[]::uuid[];
  v_run_id uuid;
  v_run_number text;
  v_run_date date;
  v_process_type text;
  v_animal_heads integer := 0;
  v_animal_cost bigint := 0;
  v_head_count bigint := 0;
  v_cost_pool numeric := 0;
  v_labor_cost bigint := 0;
  v_other_cost bigint := 0;
  v_input_cost numeric := 0;
  v_total_cost bigint := 0;
  v_total_output bigint := 0;
  v_unit_cost bigint := 0;
  v_line_total bigint;
  v_line_unit_cost bigint;
  v_quantity bigint;
  v_calculated numeric;
  v_product_id uuid;
  v_lock_product_id uuid;
  v_stock_balance numeric;
  v_notes text;
  v_output_count integer := 0;
  v_now timestamptz := now();
  v_stamp text;
begin
  if not public.is_admin_role() then
    raise exception 'Production actions are restricted to administrators.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid production run.';
  end if;
  select staff.local_staff_id into v_actor_id
  from public.cloud_staff staff
  where staff.user_id = auth.uid() and staff.is_active;
  if v_actor_id is null then
    raise exception 'Your staff profile is not linked for production actions.';
  end if;

  begin
    v_branch_id := (p_payload->>'branchId')::uuid;
    v_run_date := (p_payload->>'runDate')::date;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'Choose a valid production branch and run date.';
  end;
  if v_branch_id is null or v_run_date is null then
    raise exception 'Choose a valid production branch and run date.';
  end if;
  if not public.has_branch_access(v_branch_id) or not exists (
    select 1 from public.branches branch
    where branch.id = v_branch_id and branch.is_active and branch.deleted_at is null
  ) then
    raise exception 'Choose an active branch you can access.';
  end if;
  if v_run_date > (now() at time zone 'Asia/Karachi')::date then
    raise exception 'Run date cannot be in the future.';
  end if;
  v_process_type := coalesce(p_payload->>'processType','product');
  if v_process_type not in ('product','terminal','continuous') then
    raise exception 'Choose a supported production process.';
  end if;
  v_notes := nullif(left(btrim(coalesce(p_payload->>'notes','')),500),'');

  if coalesce(p_payload->>'laborCostPaisa','0') !~ '^\d{1,15}$'
    or coalesce(p_payload->>'otherCostPaisa','0') !~ '^\d{1,15}$' then
    raise exception 'Enter valid labour and other costs.';
  end if;
  v_labor_cost := coalesce((p_payload->>'laborCostPaisa')::bigint,0);
  v_other_cost := coalesce((p_payload->>'otherCostPaisa')::bigint,0);
  if coalesce(p_payload->>'animalHeads','0') !~ '^\d{1,6}$' then
    raise exception 'Enter a valid animal head count.';
  end if;
  v_animal_heads := coalesce((p_payload->>'animalHeads')::integer,0);
  if v_animal_heads > 100000 then raise exception 'Animal head count cannot exceed 100,000.'; end if;

  if nullif(p_payload->>'animalBatchId','') is not null then
    begin
      v_batch_id := (p_payload->>'animalBatchId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid animal batch.';
    end;
  end if;
  if v_process_type = 'product' then
    if v_batch_id is not null then raise exception 'Product-based production cannot use an animal batch.'; end if;
    if v_animal_heads > 0 then raise exception 'Choose an animal batch for the animals used.'; end if;
  else
    if v_batch_id is null then raise exception '% production requires an animal batch.', v_process_type; end if;
    select * into v_batch
    from public.animal_batches
    where id = v_batch_id and deleted_at is null
    for update;
    if not found or v_batch.branch_id <> v_branch_id then
      raise exception 'Choose an animal batch from the production branch.';
    end if;
    if v_batch.status <> 'open' then raise exception 'Choose an open animal batch.'; end if;
    if v_batch.batch_type <> v_process_type then
      raise exception 'The selected animal batch does not match the production process.';
    end if;
    if v_process_type = 'continuous' and v_animal_heads > 0 then
      raise exception 'A continuous batch keeps its animals; set animals used to zero.';
    end if;
    if v_process_type = 'terminal' and v_animal_heads < 1 then
      raise exception 'Enter how many animals from this terminal batch are used.';
    end if;
    if v_process_type = 'terminal' then
      select v_batch.opening_heads + coalesce(sum(event.heads_delta),0)
      into v_head_count
      from public.animal_batch_events event
      where event.batch_id = v_batch_id and event.deleted_at is null;
      if v_animal_heads > v_head_count then
        raise exception 'Only % head remain in this batch.', v_head_count;
      end if;
      select greatest(
        v_batch.opening_cost_paisa
          + coalesce(sum(case when event.event_type in ('purchase','feed') then event.amount_paisa else 0 end),0)
          - coalesce(sum(case when event.event_type in ('mortality','sale','production') then event.amount_paisa else 0 end),0),
        0
      )
      into v_cost_pool
      from public.animal_batch_events event
      where event.batch_id = v_batch_id and event.deleted_at is null;
      if v_head_count > 0 then
        v_calculated := round(v_cost_pool * v_animal_heads / v_head_count);
        if v_calculated > 9223372036854775807 then raise exception 'Animal cost is too large.'; end if;
        v_animal_cost := v_calculated::bigint;
      end if;
    end if;
  end if;

  if jsonb_typeof(coalesce(p_payload->'inputs','[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_payload->'outputs','[]'::jsonb)) <> 'array' then
    raise exception 'Production inputs and outputs must be lists.';
  end if;
  for v_line in select value from jsonb_array_elements(coalesce(p_payload->'inputs','[]'::jsonb)) as lines(value)
  loop
    if jsonb_typeof(v_line) <> 'object' then raise exception 'Each production input must be an object.'; end if;
    if coalesce(btrim(v_line->>'productId'),'') = '' and coalesce(v_line->>'quantityMilli','') in ('','0') then
      continue;
    end if;
    if coalesce(btrim(v_line->>'productId'),'') = ''
      or coalesce(v_line->>'quantityMilli','') !~ '^\d{1,15}$' then
      raise exception 'Choose an input product and enter a valid quantity.';
    end if;
    if cardinality(v_input_product_ids) >= 100 then raise exception 'A production run can have at most 100 input lines.'; end if;
    begin
      v_product_id := (v_line->>'productId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid input product.';
    end;
    if v_product_id = any(v_input_product_ids) then
      raise exception 'Each input product can only appear once.';
    end if;
    v_input_product_ids := array_append(v_input_product_ids,v_product_id);
    v_quantity := (v_line->>'quantityMilli')::bigint;
    if v_quantity < 1 then raise exception 'Input quantity must be greater than zero.'; end if;
    select product.id,product.name,product.unit_code,product.cost_price_paisa,product.category_id,category.name as category_name
    into v_product
    from public.products product
    left join public.categories category on category.id = product.category_id and category.deleted_at is null
    where product.id = v_product_id and product.is_active and product.deleted_at is null
    for share of product;
    if not found then raise exception 'Choose an active input product.'; end if;
    v_calculated := round(v_product.cost_price_paisa::numeric * v_quantity / 1000);
    if v_calculated > 9223372036854775807 then raise exception 'Production input cost is too large.'; end if;
    v_line_total := v_calculated::bigint;
    v_input_cost := v_input_cost + v_line_total;
    if v_input_cost > 9223372036854775807 then raise exception 'Production input cost is too large.'; end if;
    v_clean_inputs := v_clean_inputs || jsonb_build_array(jsonb_build_object(
      'productId',v_product.id,'productName',v_product.name,'unitCode',v_product.unit_code,
      'quantityMilli',v_quantity,'unitCostPaisa',v_product.cost_price_paisa,'lineTotalPaisa',v_line_total
    ));
  end loop;
  if v_process_type = 'product' and jsonb_array_length(v_clean_inputs) = 0 then
    raise exception 'Product-based production needs at least one input line.';
  end if;
  if v_process_type <> 'product' and jsonb_array_length(v_clean_inputs) > 0 then
    raise exception 'Animal-based production cannot include product input lines.';
  end if;

  for v_line in select value from jsonb_array_elements(coalesce(p_payload->'outputs','[]'::jsonb)) as lines(value)
  loop
    if jsonb_typeof(v_line) <> 'object' then raise exception 'Each production output must be an object.'; end if;
    if coalesce(btrim(v_line->>'productId'),'') = '' and coalesce(v_line->>'quantityMilli','') in ('','0') then
      continue;
    end if;
    if coalesce(btrim(v_line->>'productId'),'') = ''
      or coalesce(v_line->>'quantityMilli','') !~ '^\d{1,15}$' then
      raise exception 'Choose an output product and enter a valid quantity.';
    end if;
    if cardinality(v_output_product_ids) >= 50 then raise exception 'A production run can have at most 50 output lines.'; end if;
    begin
      v_product_id := (v_line->>'productId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid output product.';
    end;
    if v_product_id = any(v_input_product_ids) then
      raise exception 'The output product cannot also be an input.';
    end if;
    if v_product_id = any(v_output_product_ids) then
      raise exception 'Each output product can only appear once.';
    end if;
    v_output_product_ids := array_append(v_output_product_ids,v_product_id);
    v_quantity := (v_line->>'quantityMilli')::bigint;
    if v_quantity < 1 then raise exception 'Output quantity must be greater than zero.'; end if;
    select product.id,product.name,product.unit_code,product.cost_price_paisa,product.category_id,category.name as category_name
    into v_product
    from public.products product
    left join public.categories category on category.id = product.category_id and category.deleted_at is null
    where product.id = v_product_id and product.is_active and product.deleted_at is null
    for share of product;
    if not found then raise exception 'Choose an active output product.'; end if;
    if left(upper(coalesce(v_product.category_name,'')),3) = 'RAW' then
      raise exception 'Output products cannot be from RAW categories.';
    end if;
    v_total_output := v_total_output + v_quantity;
    if v_total_output > 9007199254740991 then
      raise exception 'Total output quantity exceeds the supported range.';
    end if;
    v_clean_outputs := v_clean_outputs || jsonb_build_array(jsonb_build_object(
      'productId',v_product.id,'productName',v_product.name,'unitCode',v_product.unit_code,
      'quantityMilli',v_quantity
    ));
  end loop;
  v_output_count := jsonb_array_length(v_clean_outputs);
  if v_output_count < 1 then raise exception 'A production run needs at least one output.'; end if;

  if v_process_type = 'product' then
    for v_lock_product_id in
      select distinct item from unnest(v_input_product_ids) as ids(item) order by item
    loop
      perform pg_advisory_xact_lock(hashtext(v_branch_id::text || ':' || v_lock_product_id::text));
    end loop;
    for v_line in select value from jsonb_array_elements(v_clean_inputs) as lines(value)
    loop
      select coalesce(sum(movement.quantity_delta_milli),0)
      into v_stock_balance
      from public.stock_movements movement
      where movement.branch_id = v_branch_id
        and movement.product_id = (v_line->>'productId')::uuid
        and movement.deleted_at is null;
      if v_stock_balance < (v_line->>'quantityMilli')::bigint then
        raise exception 'Not enough % in stock (% milli-units on hand).',
          v_line->>'productName',v_stock_balance;
      end if;
    end loop;
  end if;

  v_input_cost := v_input_cost + v_animal_cost;
  if v_input_cost + v_labor_cost + v_other_cost > 9223372036854775807 then
    raise exception 'Production run total cost is too large.';
  end if;
  v_total_cost := (v_input_cost + v_labor_cost + v_other_cost)::bigint;
  v_calculated := round(v_total_cost::numeric * 1000 / v_total_output);
  if v_calculated > 9223372036854775807 then raise exception 'Production unit cost is too large.'; end if;
  v_unit_cost := v_calculated::bigint;
  v_run_id := gen_random_uuid();
  v_stamp := to_char(v_now at time zone 'Asia/Karachi','YYMMDDHH24MISS');
  v_run_number := 'PRD-' || v_stamp || '-' || upper(substr(replace(v_run_id::text,'-',''),1,3));

  insert into public.production_runs(
    id,branch_id,run_number,run_date,output_product_id,output_product_name,output_unit_code,
    output_quantity_milli,input_cost_paisa,labor_cost_paisa,other_cost_paisa,total_cost_paisa,
    unit_cost_paisa,notes,created_by,created_at,animal_batch_id,animal_heads,animal_cost_paisa,
    process_type,server_updated_at
  )
  select v_run_id,v_branch_id,v_run_number,v_run_date,
    (output.value->>'productId')::uuid,output.value->>'productName',output.value->>'unitCode',
    v_total_output,v_input_cost::bigint,v_labor_cost,v_other_cost,v_total_cost,v_unit_cost,
    v_notes,v_actor_id,v_now,v_batch_id,v_animal_heads,v_animal_cost,v_process_type,v_now
  from jsonb_array_elements(v_clean_outputs) with ordinality as output(value,ordinality)
  where output.ordinality = 1;

  if v_batch_id is not null and v_process_type = 'terminal' then
    insert into public.animal_batch_events(
      id,batch_id,branch_id,event_date,event_type,heads_delta,amount_paisa,notes,recorded_by,created_at,server_updated_at
    ) values(
      gen_random_uuid(),v_batch_id,v_branch_id,v_run_date,'production',-v_animal_heads,v_animal_cost,
      'Used in production run '||v_run_number||case when v_notes is null then '' else ' · '||v_notes end,
      v_actor_id,v_now,v_now
    );
  end if;

  for v_line in select value from jsonb_array_elements(v_clean_inputs) as lines(value)
  loop
    insert into public.production_inputs(
      id,run_id,product_id,product_name,unit_code,quantity_milli,unit_cost_paisa,line_total_paisa,created_at,server_updated_at
    ) values(
      gen_random_uuid(),v_run_id,(v_line->>'productId')::uuid,v_line->>'productName',v_line->>'unitCode',
      (v_line->>'quantityMilli')::bigint,(v_line->>'unitCostPaisa')::bigint,(v_line->>'lineTotalPaisa')::bigint,v_now,v_now
    );
    insert into public.stock_movements(
      id,idempotency_key,branch_id,product_id,movement_type,quantity_delta_milli,unit_cost_paisa,
      reference_type,reference_id,created_by,notes,occurred_at,created_at,server_updated_at
    ) values(
      gen_random_uuid(),'production_in:'||v_run_id::text||':'||(v_line->>'productId'),v_branch_id,
      (v_line->>'productId')::uuid,'adjustment',-((v_line->>'quantityMilli')::bigint),
      (v_line->>'unitCostPaisa')::bigint,'production_run',v_run_id::text,v_actor_id,
      'Production '||v_run_number||' consumed '||(v_line->>'productName'),v_now,v_now,v_now
    );
  end loop;

  for v_line in select value from jsonb_array_elements(v_clean_outputs) as lines(value)
  loop
    v_calculated := round(v_total_cost::numeric * (v_line->>'quantityMilli')::bigint / v_total_output);
    if v_calculated > 9223372036854775807 then raise exception 'Production output cost is too large.'; end if;
    v_line_total := v_calculated::bigint;
    v_calculated := round(v_line_total::numeric * 1000 / (v_line->>'quantityMilli')::bigint);
    if v_calculated > 9223372036854775807 then raise exception 'Production output unit cost is too large.'; end if;
    v_line_unit_cost := v_calculated::bigint;
    insert into public.production_outputs(
      id,run_id,product_id,product_name,unit_code,quantity_milli,unit_cost_paisa,line_total_paisa,created_at,server_updated_at
    ) values(
      gen_random_uuid(),v_run_id,(v_line->>'productId')::uuid,v_line->>'productName',v_line->>'unitCode',
      (v_line->>'quantityMilli')::bigint,v_line_unit_cost,v_line_total,v_now,v_now
    );
    insert into public.stock_movements(
      id,idempotency_key,branch_id,product_id,movement_type,quantity_delta_milli,unit_cost_paisa,
      reference_type,reference_id,created_by,notes,occurred_at,created_at,server_updated_at
    ) values(
      gen_random_uuid(),'production_out:'||v_run_id::text||':'||(v_line->>'productId'),v_branch_id,
      (v_line->>'productId')::uuid,'adjustment',(v_line->>'quantityMilli')::bigint,
      v_line_unit_cost,'production_run',v_run_id::text,v_actor_id,
      'Production '||v_run_number||' produced '||(v_line->>'productName'),v_now,v_now,v_now
    );
  end loop;

  insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
  values(
    gen_random_uuid(),v_actor_id,v_branch_id,'production.recorded','production_run',v_run_id::text,
    jsonb_build_object('runNumber',v_run_number,'processType',v_process_type,'outputCount',v_output_count,
      'totalOutputQuantityMilli',v_total_output,'totalCostPaisa',v_total_cost),
    v_now,v_now
  );
  return jsonb_build_object('id',v_run_id,'runNumber',v_run_number,'totalCostPaisa',v_total_cost);
end;
$$;

revoke all on function public.manage_web_production_run(jsonb) from public;
grant execute on function public.manage_web_production_run(jsonb) to authenticated;

commit;
