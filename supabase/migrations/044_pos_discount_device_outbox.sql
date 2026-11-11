begin;

do $migration$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  select pg_get_functiondef('public.staff_manage_pos_discount(text, jsonb)'::regprocedure)
  into v_definition;

  if strpos(v_definition, 'request_from_pos') = 0 then
    v_anchor := $anchor$  v_request_id uuid;$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS discount request declarations.';
    end if;
    v_definition := replace(v_definition, v_anchor, v_anchor || E'\n  v_cashier_id uuid;\n  v_existing public.pos_discount_approvals%rowtype;');

    v_anchor := $anchor$  v_status text;$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS discount request status declarations.';
    end if;
    v_definition := replace(v_definition, v_anchor, v_anchor || E'\n  v_request_expires_at timestamptz;');

    v_anchor := $anchor$  if p_action = 'request' then$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS discount request action.';
    end if;
    v_definition := replace(v_definition, v_anchor, $replacement$  if p_action in ('request', 'request_from_pos') then$replacement$);

    v_anchor := $anchor$    if v_staff.role not in ('cashier', 'manager', 'admin') then
      raise exception 'Your role cannot request a POS discount approval.';
    end if;
    v_items := p_payload->'items';$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS discount request role validation.';
    end if;
    v_replacement := $replacement$    if p_action = 'request' and v_staff.role not in ('cashier', 'manager', 'admin') then
      raise exception 'Your role cannot request a POS discount approval.';
    end if;
    v_cashier_id := v_staff.local_staff_id;
    if p_action = 'request_from_pos' then
      if v_staff.role not in ('manager', 'admin') then
        raise exception 'A branch manager account is required to send a POS cashier discount request.';
      end if;
      begin
        v_cashier_id := (p_payload->>'cashierId')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid cashier for this discount request.';
      end;
      if v_cashier_id is null or v_cashier_id = v_staff.local_staff_id or not exists (
        select 1 from public.staff_profiles cashier
        where cashier.id = v_cashier_id and cashier.branch_id = v_branch_id
          and cashier.role = 'cashier' and cashier.is_active and cashier.deleted_at is null
      ) then
        raise exception 'The cashier must be active at this branch and different from the Cloud account.';
      end if;
    end if;
    v_items := p_payload->'items';$replacement$;
    v_definition := replace(v_definition, v_anchor, v_replacement);

    v_anchor := $anchor$    update public.pos_discount_approvals
    set status = case when expires_at <= v_now then 'expired' else 'declined' end,$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS discount request replacement handling.';
    end if;
    v_replacement := $replacement$    begin
      v_request_id := (p_payload->>'requestId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid discount request ID.';
    end;
    if v_request_id is null then v_request_id := gen_random_uuid(); end if;
    select * into v_existing
    from public.pos_discount_approvals
    where id = v_request_id;
    if found then
      if v_existing.cashier_id <> v_cashier_id
        or v_existing.branch_id <> v_branch_id
        or v_existing.basket_fingerprint <> v_fingerprint
        or v_existing.bill_discount_paisa <> v_discount then
        raise exception 'This discount request ID was already used for a different request.';
      end if;
      return jsonb_build_object(
        'requestId', v_existing.id, 'status', v_existing.status,
        'expiresAt', v_existing.expires_at
      );
    end if;
    update public.pos_discount_approvals
    set status = case when expires_at <= v_now then 'expired' else 'declined' end,$replacement$;
    v_definition := replace(v_definition, v_anchor, v_replacement);

    v_anchor := $anchor$v_request_id := gen_random_uuid();
    insert into public.pos_discount_approvals ($anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS discount request creation.';
    end if;
    v_definition := replace(v_definition, v_anchor, $replacement$insert into public.pos_discount_approvals ($replacement$);

    v_anchor := $anchor$v_request_id, v_branch_id, v_staff.local_staff_id, v_staff.user_id,$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS discount cashier assignment.';
    end if;
    v_definition := replace(v_definition, v_anchor, $replacement$v_request_id, v_branch_id, v_cashier_id, v_staff.user_id,$replacement$);

    v_anchor := $anchor$    where cashier_id = v_staff.local_staff_id
      and branch_id = v_branch_id
      and status in ('pending', 'approved');$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate prior POS discount request cleanup.';
    end if;
    v_definition := replace(v_definition, v_anchor, $replacement$    where cashier_id = v_cashier_id
      and branch_id = v_branch_id
      and status in ('pending', 'approved');$replacement$);

    v_anchor := $anchor$  elsif p_action = 'status' then$anchor$;
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Could not locate POS discount request status action.';
    end if;
    v_replacement := $replacement$  elsif p_action = 'status_from_pos' then
    if v_staff.role not in ('manager', 'admin') then
      raise exception 'A branch manager account is required to retrieve a POS discount result.';
    end if;
    begin
      v_request_id := (p_payload->>'requestId')::uuid;
      v_cashier_id := (p_payload->>'cashierId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid discount request.';
    end;
    update public.pos_discount_approvals
    set status = 'expired', updated_at = v_now, server_updated_at = v_now
    where id = v_request_id and cashier_id = v_cashier_id
      and branch_id = v_branch_id and status in ('pending', 'approved')
      and expires_at <= v_now;
    select status, expires_at into v_status, v_request_expires_at
    from public.pos_discount_approvals
    where id = v_request_id and cashier_id = v_cashier_id and branch_id = v_branch_id;
    if not found then raise exception 'Discount approval request not found.'; end if;
    return jsonb_build_object(
      'requestId', v_request_id, 'status', v_status, 'expiresAt', v_request_expires_at
    );
  elsif p_action = 'status' then$replacement$;
    v_definition := replace(v_definition, v_anchor, v_replacement);

    v_anchor := $anchor$'cashierName', coalesce(cashier.full_name, 'Cashier'),$anchor$;
    if strpos(v_definition, v_anchor) > 0 then
      v_definition := replace(v_definition, v_anchor, $replacement$'cashierName', coalesce(cashier_profile.full_name, cashier.full_name, 'Cashier'),$replacement$);
      v_anchor := $anchor$left join public.cloud_staff cashier on cashier.local_staff_id = request.cashier_id$anchor$;
      if strpos(v_definition, v_anchor) = 0 then
        raise exception 'Could not locate POS discount request cashier lookup.';
      end if;
      v_definition := replace(v_definition, v_anchor, $replacement$left join public.staff_profiles cashier_profile on cashier_profile.id = request.cashier_id
    left join public.cloud_staff cashier on cashier.local_staff_id = request.cashier_id$replacement$);
    elsif strpos(v_definition, 'cashier_profile.full_name') = 0 then
      raise exception 'Could not locate POS discount request cashier details.';
    end if;

    execute v_definition;
  end if;
end;
$migration$;

commit;
