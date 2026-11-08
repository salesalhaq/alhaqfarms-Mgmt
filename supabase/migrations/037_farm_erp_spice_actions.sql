begin;

create or replace function public.manage_web_spice_batch(p_action text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_branch_id uuid;
  v_batch_id uuid;
  v_output_product_id uuid;
  v_output_product_name text;
  v_output_unit_code text;
  v_product_id uuid;
  v_lock_product_id uuid;
  v_product record;
  v_batch public.spice_batches;
  v_line jsonb;
  v_clean_inputs jsonb := '[]'::jsonb;
  v_input_ids uuid[] := array[]::uuid[];
  v_quantity bigint;
  v_input_cost numeric := 0;
  v_labor_cost bigint := 0;
  v_other_cost bigint := 0;
  v_total_cost bigint := 0;
  v_output_quantity bigint;
  v_unit_cost bigint;
  v_calculated numeric;
  v_stock_balance numeric;
  v_batch_number text;
  v_name text;
  v_notes text;
  v_grade text;
  v_now timestamptz := now();
  v_stamp text;
  v_attempt integer := 0;
begin
  if not public.is_admin_role() then
    raise exception 'Spice batch actions are restricted to administrators.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Provide a valid spice batch action.';
  end if;
  select staff.local_staff_id into v_actor_id
  from public.cloud_staff staff
  where staff.user_id = auth.uid() and staff.is_active;
  if v_actor_id is null then
    raise exception 'Your staff profile is not linked for spice batch actions.';
  end if;

  if p_action = 'open' then
    begin
      v_branch_id := (p_payload->>'branchId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose an active spice batch branch.';
    end;
    if v_branch_id is null or not public.has_branch_access(v_branch_id) or not exists (
      select 1 from public.branches branch
      where branch.id = v_branch_id and branch.is_active and branch.deleted_at is null
    ) then
      raise exception 'Choose an active branch you can access.';
    end if;
    begin
      if coalesce(p_payload->>'batchDate','') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Batch date must be a valid business date.';
      end if;
      if (p_payload->>'batchDate')::date > (now() at time zone 'Asia/Karachi')::date then
        raise exception 'Batch date cannot be in the future.';
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception 'Batch date must be a valid business date.';
    end;
    v_name := nullif(btrim(p_payload->>'name'),'');
    if v_name is null or length(v_name) > 160 then
      raise exception 'Enter a batch name of up to 160 characters.';
    end if;
    v_notes := nullif(left(btrim(coalesce(p_payload->>'notes','')),500),'');
    if coalesce(p_payload->>'laborCostPaisa','0') !~ '^\d{1,15}$'
      or coalesce(p_payload->>'otherCostPaisa','0') !~ '^\d{1,15}$' then
      raise exception 'Enter valid packing labour and other costs.';
    end if;
    v_labor_cost := coalesce((p_payload->>'laborCostPaisa')::bigint,0);
    v_other_cost := coalesce((p_payload->>'otherCostPaisa')::bigint,0);
    begin
      v_output_product_id := (p_payload->>'outputProductId')::uuid;
    exception when invalid_text_representation or not_null_violation then
      raise exception 'Choose an active output product.';
    end;
    if v_output_product_id is null then raise exception 'Choose an active output product.'; end if;
    select product.id,product.name,product.unit_code,product.category_id,category.name as category_name
    into v_product
    from public.products product
    left join public.categories category on category.id = product.category_id and category.deleted_at is null
    where product.id = v_output_product_id and product.is_active and product.deleted_at is null
    for share of product;
    if not found then raise exception 'Choose an active output product.'; end if;
    if left(upper(btrim(coalesce(v_product.category_name,''))),3) = 'RAW' then
      raise exception 'Output product cannot be from a category whose name starts with RAW.';
    end if;
    v_output_product_name := v_product.name;
    v_output_unit_code := v_product.unit_code;

    if jsonb_typeof(coalesce(p_payload->'inputs','[]'::jsonb)) <> 'array' then
      raise exception 'Spice batch inputs must be a list.';
    end if;
    if jsonb_array_length(coalesce(p_payload->'inputs','[]'::jsonb)) < 1
      or jsonb_array_length(coalesce(p_payload->'inputs','[]'::jsonb)) > 50 then
      raise exception 'A spice batch needs between 1 and 50 input lines.';
    end if;
    for v_line in select value from jsonb_array_elements(p_payload->'inputs') as lines(value)
    loop
      if jsonb_typeof(v_line) <> 'object' then raise exception 'Each spice input must be an object.'; end if;
      begin
        v_product_id := (v_line->>'productId')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid RAW input product.';
      end;
      if v_product_id is null or v_product_id = v_output_product_id then
        raise exception 'The output product cannot also be an input.';
      end if;
      if v_product_id = any(v_input_ids) then raise exception 'Each input product can only appear once.'; end if;
      if coalesce(v_line->>'quantityMilli','') !~ '^\d{1,15}$' then
        raise exception 'Enter a valid quantity for each raw input.';
      end if;
      v_quantity := (v_line->>'quantityMilli')::bigint;
      if v_quantity < 1 then raise exception 'Input quantity must be greater than zero.'; end if;
      select product.id,product.name,product.unit_code,product.cost_price_paisa,category.name as category_name
      into v_product
      from public.products product
      join public.categories category on category.id = product.category_id and category.deleted_at is null
      where product.id = v_product_id and product.is_active and product.deleted_at is null
      for share of product;
      if not found or left(upper(btrim(coalesce(v_product.category_name,''))),3) <> 'RAW' then
        raise exception 'Choose an active input product from a category whose name starts with RAW.';
      end if;
      if v_product.cost_price_paisa < 0 then
        raise exception 'Input product cost cannot be negative.';
      end if;
      v_calculated := round(v_product.cost_price_paisa::numeric * v_quantity / 1000);
      if v_calculated > 9223372036854775807 then raise exception 'Spice input cost is too large.'; end if;
      v_input_cost := v_input_cost + v_calculated;
      if v_input_cost > 9223372036854775807 then raise exception 'Spice input cost is too large.'; end if;
      v_input_ids := array_append(v_input_ids,v_product_id);
      v_clean_inputs := v_clean_inputs || jsonb_build_array(jsonb_build_object(
        'productId',v_product.id,'productName',v_product.name,'unitCode',v_product.unit_code,
        'quantityMilli',v_quantity,'unitCostPaisa',v_product.cost_price_paisa,
        'lineTotalPaisa',v_calculated::bigint
      ));
    end loop;
    if v_input_cost + v_labor_cost + v_other_cost > 9223372036854775807 then
      raise exception 'Total spice batch cost is too large.';
    end if;
    v_total_cost := (v_input_cost + v_labor_cost + v_other_cost)::bigint;

    for v_lock_product_id in
      select distinct item from unnest(v_input_ids) as ids(item) order by item
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

    v_batch_id := gen_random_uuid();
    v_stamp := to_char(v_now at time zone 'Asia/Karachi','YYMMDDHH24MISS');
    loop
      v_batch_number := 'SPC-' || v_stamp || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
      exit when not exists (
        select 1 from public.spice_batches
        where branch_id = v_branch_id and batch_number = v_batch_number
      );
      v_attempt := v_attempt + 1;
      if v_attempt >= 5 then raise exception 'Could not reserve a unique spice batch number.'; end if;
    end loop;

    insert into public.spice_batches(
      id,branch_id,batch_number,name,batch_date,output_product_id,output_product_name,output_unit_code,
      status,input_cost_paisa,labor_cost_paisa,other_cost_paisa,notes,created_by,created_at,server_updated_at
    ) values(
      v_batch_id,v_branch_id,v_batch_number,v_name,(p_payload->>'batchDate')::date,
      v_output_product_id,v_output_product_name,v_output_unit_code,'open',v_input_cost::bigint,v_labor_cost,
      v_other_cost,v_notes,v_actor_id,v_now,v_now
    );

    for v_line in select value from jsonb_array_elements(v_clean_inputs) as lines(value)
    loop
      insert into public.spice_batch_inputs(
        id,batch_id,product_id,product_name,unit_code,quantity_milli,unit_cost_paisa,line_total_paisa,created_at,server_updated_at
      ) values(
        gen_random_uuid(),v_batch_id,(v_line->>'productId')::uuid,v_line->>'productName',v_line->>'unitCode',
        (v_line->>'quantityMilli')::bigint,(v_line->>'unitCostPaisa')::bigint,
        (v_line->>'lineTotalPaisa')::bigint,v_now,v_now
      );
      insert into public.stock_movements(
        id,idempotency_key,branch_id,product_id,movement_type,quantity_delta_milli,unit_cost_paisa,
        reference_type,reference_id,created_by,notes,occurred_at,created_at,server_updated_at
      ) values(
        gen_random_uuid(),'spice_in:'||v_batch_id::text||':'||(v_line->>'productId'),v_branch_id,
        (v_line->>'productId')::uuid,'adjustment',-((v_line->>'quantityMilli')::bigint),
        (v_line->>'unitCostPaisa')::bigint,'spice_batch',v_batch_id::text,v_actor_id,
        'Spice batch '||v_batch_number||' consumed '||(v_line->>'productName'),v_now,v_now,v_now
      );
    end loop;

    insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
    values(
      gen_random_uuid(),v_actor_id,v_branch_id,'spice_batch.created','spice_batch',v_batch_id::text,
      jsonb_build_object('batchNumber',v_batch_number,'name',v_name,'inputCostPaisa',v_input_cost::bigint),
      v_now,v_now
    );
    return jsonb_build_object('id',v_batch_id,'batchNumber',v_batch_number,'totalCostPaisa',v_total_cost);
  elsif p_action = 'complete' then
    begin
      v_batch_id := (p_payload->>'batchId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid spice batch.';
    end;
    if v_batch_id is null or coalesce(p_payload->>'outputQuantityMilli','') !~ '^\d{1,15}$' then
      raise exception 'Enter a valid spice output quantity.';
    end if;
    v_output_quantity := (p_payload->>'outputQuantityMilli')::bigint;
    if v_output_quantity < 1 then raise exception 'Output quantity must be greater than zero.'; end if;
    v_grade := coalesce(p_payload->>'grade','unclassified');
    if v_grade not in ('premium','standard','economy','unclassified') then
      raise exception 'Choose a supported spice grade.';
    end if;

    select * into v_batch
    from public.spice_batches
    where id = v_batch_id and deleted_at is null
    for update;
    if not found or not public.has_branch_access(v_batch.branch_id) then
      raise exception 'Spice batch not found at your branch.';
    end if;
    if v_batch.status <> 'open' then raise exception 'This spice batch is already completed.'; end if;
    v_branch_id := v_batch.branch_id;
    v_calculated := v_batch.input_cost_paisa::numeric + v_batch.labor_cost_paisa + v_batch.other_cost_paisa;
    if v_calculated < 0 or v_calculated > 9223372036854775807 then
      raise exception 'Spice batch cost is outside the supported range.';
    end if;
    v_total_cost := v_calculated::bigint;
    v_calculated := round(v_total_cost::numeric * 1000 / v_output_quantity);
    if v_calculated > 9223372036854775807 then raise exception 'Spice output unit cost is too large.'; end if;
    v_unit_cost := v_calculated::bigint;

    select product.id into v_product_id
    from public.products product
    where product.id = v_batch.output_product_id and product.deleted_at is null
    for update;
    if not found then raise exception 'The spice output product is no longer available.'; end if;

    update public.spice_batches
    set status = 'completed',grade = v_grade,output_quantity_milli = v_output_quantity,
      unit_cost_paisa = v_unit_cost,completed_by = v_actor_id,completed_at = v_now,server_updated_at = v_now
    where id = v_batch_id and status = 'open';
    if not found then raise exception 'This spice batch is already completed.'; end if;

    insert into public.stock_movements(
      id,idempotency_key,branch_id,product_id,movement_type,quantity_delta_milli,unit_cost_paisa,
      reference_type,reference_id,created_by,notes,occurred_at,created_at,server_updated_at
    ) values(
      gen_random_uuid(),'spice_out:'||v_batch_id::text||':'||v_batch.output_product_id::text,
      v_branch_id,v_batch.output_product_id,'adjustment',v_output_quantity,v_unit_cost,'spice_batch',
      v_batch_id::text,v_actor_id,'Spice batch '||v_batch.batch_number||' produced '||v_batch.output_product_name,
      v_now,v_now,v_now
    );
    update public.products
    set cost_price_paisa = v_unit_cost,updated_at = v_now,server_updated_at = v_now
    where id = v_batch.output_product_id;

    insert into public.audit_log(id,actor_id,branch_id,action,entity_type,entity_id,details_json,occurred_at,server_updated_at)
    values(
      gen_random_uuid(),v_actor_id,v_branch_id,'spice_batch.completed','spice_batch',v_batch_id::text,
      jsonb_build_object('batchNumber',v_batch.batch_number,'outputQuantityMilli',v_output_quantity,
        'grade',v_grade,'inputCostPaisa',v_batch.input_cost_paisa,'laborCostPaisa',v_batch.labor_cost_paisa,
        'otherCostPaisa',v_batch.other_cost_paisa,'totalCostPaisa',v_total_cost,'unitCostPaisa',v_unit_cost),
      v_now,v_now
    );
    return jsonb_build_object('id',v_batch_id,'batchNumber',v_batch.batch_number,
      'outputQuantityMilli',v_output_quantity,'grade',v_grade,'unitCostPaisa',v_unit_cost);
  else
    raise exception 'Choose a supported spice batch action.';
  end if;
end;
$$;

revoke all on function public.manage_web_spice_batch(text,jsonb) from public;
grant execute on function public.manage_web_spice_batch(text,jsonb) to authenticated;

commit;
