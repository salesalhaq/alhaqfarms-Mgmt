begin;

create or replace function public.staff_manage_web_order(
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
  v_order public.web_orders;
  v_order_id uuid;
  v_permission_action text;
  v_reason text;
  v_now timestamptz := now();
  v_item record;
  v_product record;
  v_available bigint;
  v_sale_id uuid;
  v_payment_method text;
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
    raise exception 'Provide a valid order action.';
  end if;
  if p_action is null
     or p_action not in ('accept', 'pack', 'dispatch', 'deliver', 'verify_payment', 'reject_payment', 'cancel') then
    raise exception 'Choose a supported order action.';
  end if;

  begin
    v_order_id := (p_payload->>'id')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid order.';
  end;
  if v_order_id is null then
    raise exception 'Choose a valid order.';
  end if;

  select * into v_order
  from public.web_orders
  where id = v_order_id and deleted_at is null
  for update;
  if not found then
    raise exception 'Order was not found or branch access is denied.';
  end if;
  if not public.has_branch_access(v_order.branch_id) then
    raise exception 'You cannot access this order.';
  end if;
  if v_staff.branch_id is not null and v_staff.branch_id <> v_order.branch_id then
    raise exception 'You cannot access this order.';
  end if;
  if v_order.payment_method not in ('cash_on_delivery', 'easypaisa', 'jazzcash', 'pay_at_store') then
    raise exception 'This order has an unsupported payment method.';
  end if;

  v_permission_action := case when p_action = 'reject_payment' then 'verify_payment' else p_action end;
  if v_staff.role <> 'admin' and exists (
    select 1
    from public.web_order_permissions permission
    where permission.branch_id = v_order.branch_id
      and permission.role = v_staff.role
      and permission.action = v_permission_action
      and permission.deleted_at is null
      and not permission.is_allowed
  ) then
    raise exception 'Your role cannot % web orders for this branch.', replace(v_permission_action, '_', ' ');
  end if;

  if p_action = 'verify_payment' then
    if v_order.payment_method not in ('easypaisa', 'jazzcash') then
      raise exception 'Only Easypaisa and JazzCash transfers require payment verification.';
    end if;
    if v_order.payment_status <> 'pending_verification'
       or v_order.payment_review_status <> 'awaiting_review' then
      raise exception 'This order is not awaiting payment verification.';
    end if;
    if nullif(btrim(v_order.payment_reference), '') is null then
      raise exception 'The customer transaction ID is missing.';
    end if;
    if nullif(v_order.payment_proof_path, '') is null then
      raise exception 'The customer has not uploaded a payment screenshot.';
    end if;

    update public.web_orders
    set payment_status = 'paid',
        payment_review_status = 'verified',
        payment_rejection_reason = null,
        payment_rejected_by = null,
        payment_rejected_at = null,
        payment_verified_by = v_staff.local_staff_id,
        payment_verified_at = v_now,
        updated_at = v_now,
        server_updated_at = v_now
    where id = v_order.id;

    insert into public.web_order_events (
      id, order_id, branch_id, actor_id, event_type, previous_status, next_status,
      payment_reference, occurred_at, created_at, server_updated_at
    ) values (
      gen_random_uuid(), v_order.id, v_order.branch_id, v_staff.local_staff_id,
      'payment_verified', v_order.status, v_order.status,
      v_order.payment_reference, v_now, v_now, v_now
    );
  elsif p_action = 'reject_payment' then
    if v_order.payment_method not in ('easypaisa', 'jazzcash')
       or v_order.payment_status <> 'pending_verification'
       or v_order.payment_review_status <> 'awaiting_review' then
      raise exception 'This order is not awaiting payment review.';
    end if;
    v_reason := left(btrim(coalesce(p_payload->>'reason', '')), 500);
    if v_reason = '' then
      raise exception 'Enter a reason to return the payment to the customer.';
    end if;

    update public.web_orders
    set payment_review_status = 'rejected',
        payment_rejection_reason = v_reason,
        payment_rejected_by = v_staff.local_staff_id,
        payment_rejected_at = v_now,
        updated_at = v_now,
        server_updated_at = v_now
    where id = v_order.id;

    insert into public.web_order_events (
      id, order_id, branch_id, actor_id, event_type, previous_status, next_status,
      payment_reference, notes, occurred_at, created_at, server_updated_at
    ) values (
      gen_random_uuid(), v_order.id, v_order.branch_id, v_staff.local_staff_id,
      'payment_rejected', v_order.status, v_order.status,
      v_order.payment_reference, v_reason, v_now, v_now, v_now
    );
  elsif p_action = 'accept' then
    if v_order.status <> 'pending' then
      raise exception 'Only pending orders can be accepted.';
    end if;
    update public.web_orders
    set status = 'accepted', updated_at = v_now, server_updated_at = v_now
    where id = v_order.id and status = 'pending';
    if not found then raise exception 'The order changed; refresh and try again.'; end if;
    insert into public.web_order_events (
      id, order_id, branch_id, actor_id, event_type, previous_status, next_status,
      occurred_at, created_at, server_updated_at
    ) values (
      gen_random_uuid(), v_order.id, v_order.branch_id, v_staff.local_staff_id,
      'accepted', v_order.status, 'accepted', v_now, v_now, v_now
    );
  elsif p_action = 'pack' then
    if v_order.status <> 'accepted' then
      raise exception 'Accept this order before packing it.';
    end if;
    if v_order.payment_method in ('easypaisa', 'jazzcash') and v_order.payment_status <> 'paid' then
      raise exception 'Verify the wallet payment before packing this order.';
    end if;
    if v_order.stock_deducted_at is not null then
      raise exception 'Stock was already deducted for this order.';
    end if;
    if not exists (
      select 1 from public.web_order_items
      where order_id = v_order.id and deleted_at is null
    ) then
      raise exception 'An empty order cannot be packed.';
    end if;
    if exists (
      select 1
      from public.web_order_items item
      left join public.products product on product.id = item.product_id
      where item.order_id = v_order.id and item.deleted_at is null
        and (product.id is null or not product.is_active or product.deleted_at is not null)
    ) then
      raise exception 'This order contains an item that is no longer linked to an active product.';
    end if;

    perform product.id
    from public.products product
    join (
      select distinct item.product_id
      from public.web_order_items item
      where item.order_id = v_order.id and item.deleted_at is null
    ) requested on requested.product_id = product.id
    order by product.id
    for update of product;

    for v_product in
      select item.product_id, sum(item.quantity_milli)::bigint as quantity_milli,
             max(product.name) as product_name
      from public.web_order_items item
      join public.products product on product.id = item.product_id
      where item.order_id = v_order.id and item.deleted_at is null
      group by item.product_id
      order by item.product_id
    loop
      select coalesce(sum(movement.quantity_delta_milli), 0)::bigint
      into v_available
      from public.stock_movements movement
      where movement.branch_id = v_order.branch_id
        and movement.product_id = v_product.product_id
        and movement.deleted_at is null;
      if v_available < v_product.quantity_milli then
        raise exception 'Insufficient stock to pack % for this order.', v_product.product_name;
      end if;
    end loop;

    for v_item in
      select item.*
      from public.web_order_items item
      where item.order_id = v_order.id and item.deleted_at is null
      order by item.line_number
    loop
      insert into public.stock_movements (
        id, idempotency_key, branch_id, product_id, movement_type, quantity_delta_milli,
        unit_cost_paisa, reference_type, reference_id, created_by, occurred_at, created_at,
        server_updated_at, notes
      ) values (
        gen_random_uuid(), 'web-order-pack:' || v_order.id::text || ':' || v_item.id::text,
        v_order.branch_id, v_item.product_id, 'sale', -v_item.quantity_milli,
        v_item.unit_cost_paisa, 'web_order', v_order.id::text, v_staff.local_staff_id,
        v_now, v_now, v_now, 'Packed web order ' || v_order.order_number
      );
    end loop;

    update public.web_orders
    set status = 'packed', stock_deducted_at = v_now, packed_by = v_staff.local_staff_id,
        packed_at = v_now, updated_at = v_now, server_updated_at = v_now
    where id = v_order.id and status = 'accepted' and stock_deducted_at is null;
    if not found then raise exception 'The order changed; refresh and try again.'; end if;
    insert into public.web_order_events (
      id, order_id, branch_id, actor_id, event_type, previous_status, next_status,
      occurred_at, created_at, server_updated_at
    ) values (
      gen_random_uuid(), v_order.id, v_order.branch_id, v_staff.local_staff_id,
      'packed', v_order.status, 'packed', v_now, v_now, v_now
    );
  elsif p_action = 'dispatch' then
    if v_order.status <> 'packed' or v_order.fulfillment_type <> 'delivery' then
      raise exception 'Only packed delivery orders can be dispatched.';
    end if;
    update public.web_orders
    set status = 'dispatched', dispatched_by = v_staff.local_staff_id,
        dispatched_at = v_now, updated_at = v_now, server_updated_at = v_now
    where id = v_order.id and status = 'packed';
    if not found then raise exception 'The order changed; refresh and try again.'; end if;
    insert into public.web_order_events (
      id, order_id, branch_id, actor_id, event_type, previous_status, next_status,
      occurred_at, created_at, server_updated_at
    ) values (
      gen_random_uuid(), v_order.id, v_order.branch_id, v_staff.local_staff_id,
      'dispatched', v_order.status, 'dispatched', v_now, v_now, v_now
    );
  elsif p_action = 'deliver' then
    if not (
      (v_order.fulfillment_type = 'delivery' and v_order.status in ('packed', 'dispatched'))
      or (v_order.fulfillment_type = 'pickup' and v_order.status = 'packed')
    ) then
      raise exception 'This order is not ready to be handed over.';
    end if;
    if v_order.payment_method in ('easypaisa', 'jazzcash') and v_order.payment_status <> 'paid' then
      raise exception 'Verify the wallet payment before completing this order.';
    end if;
    if v_order.payment_status <> 'paid' then
      if v_order.payment_method not in ('cash_on_delivery', 'pay_at_store')
         or p_payload->>'paymentReceived' is distinct from 'true' then
        raise exception 'Confirm payment collection before completing this order.';
      end if;
      update public.web_orders
      set payment_status = 'paid', updated_at = v_now, server_updated_at = v_now
      where id = v_order.id and payment_status = 'unpaid';
      if not found then raise exception 'The order payment status changed; refresh and try again.'; end if;
      insert into public.web_order_events (
        id, order_id, branch_id, actor_id, event_type, previous_status, next_status,
        notes, occurred_at, created_at, server_updated_at
      ) values (
        gen_random_uuid(), v_order.id, v_order.branch_id, v_staff.local_staff_id,
        'payment_collected', v_order.status, v_order.status,
        'Payment collected at handover.', v_now, v_now, v_now
      );
    end if;

    update public.web_orders
    set status = 'delivered', delivered_by = v_staff.local_staff_id,
        delivered_at = v_now, updated_at = v_now, server_updated_at = v_now
    where id = v_order.id and status = v_order.status;
    if not found then raise exception 'The order changed; refresh and try again.'; end if;
    insert into public.web_order_events (
      id, order_id, branch_id, actor_id, event_type, previous_status, next_status,
      occurred_at, created_at, server_updated_at
    ) values (
      gen_random_uuid(), v_order.id, v_order.branch_id, v_staff.local_staff_id,
      'delivered', v_order.status, 'delivered', v_now, v_now, v_now
    );

    if v_order.sale_id is null then
      v_sale_id := gen_random_uuid();
      v_payment_method := case v_order.payment_method
        when 'cash_on_delivery' then 'cash'
        when 'pay_at_store' then 'cash'
        when 'easypaisa' then 'easypaisa'
        when 'jazzcash' then 'jazzcash'
      end;
      insert into public.pos_sales (
        id, client_sale_id, receipt_number, branch_id, cashier_id, status, tax_mode,
        subtotal_paisa, tax_paisa, total_paisa, paid_paisa, due_paisa,
        customer_name, customer_phone, notes, source_type, source_order_id,
        completed_at, created_at, updated_at, server_updated_at
      ) values (
        v_sale_id, 'web-order:' || v_order.id::text, v_order.order_number,
        v_order.branch_id, v_staff.local_staff_id, 'completed', 'inclusive',
        v_order.subtotal_paisa, v_order.tax_paisa, v_order.total_paisa,
        v_order.total_paisa, 0, v_order.customer_name, v_order.customer_phone,
        'Website order ' || v_order.order_number, 'web_order', v_order.id,
        v_now, v_now, v_now, v_now
      );

      insert into public.pos_sale_items (
        id, sale_id, line_number, product_id, product_name, sku, barcode, unit_code,
        quantity_milli, unit_price_paisa, unit_cost_paisa, discount_paisa,
        tax_rate_bps, tax_paisa, line_total_paisa, created_at, server_updated_at
      )
      select gen_random_uuid(), v_sale_id, item.line_number, item.product_id,
             item.product_name, item.sku, null, item.unit_code, item.quantity_milli,
             item.unit_price_paisa, item.unit_cost_paisa, 0, item.tax_rate_bps,
             item.tax_paisa, item.line_total_paisa, v_now, v_now
      from public.web_order_items item
      where item.order_id = v_order.id and item.deleted_at is null
      order by item.line_number;

      if v_order.total_paisa > 0 then
        insert into public.pos_sale_payments (
          id, sale_id, sequence_number, method, amount_paisa, reference, created_at, server_updated_at
        ) values (
          gen_random_uuid(), v_sale_id, 1, v_payment_method, v_order.total_paisa,
          v_order.payment_reference, v_now, v_now
        );
      end if;
      update public.web_orders
      set sale_id = v_sale_id, updated_at = v_now, server_updated_at = v_now
      where id = v_order.id;
    end if;
  elsif p_action = 'cancel' then
    if v_order.status not in ('pending', 'accepted', 'packed') then
      raise exception 'Only pending, accepted or packed orders can be cancelled.';
    end if;
    if v_order.payment_status = 'paid' then
      if p_payload->>'refundIssued' is distinct from 'true' then
        raise exception 'Issue the customer refund before cancelling this paid order.';
      end if;
      update public.web_orders
      set payment_status = 'refunded', updated_at = v_now, server_updated_at = v_now
      where id = v_order.id and payment_status = 'paid';
      if not found then raise exception 'The payment status changed; refresh and try again.'; end if;
      insert into public.web_order_events (
        id, order_id, branch_id, actor_id, event_type, previous_status, next_status,
        payment_reference, notes, occurred_at, created_at, server_updated_at
      ) values (
        gen_random_uuid(), v_order.id, v_order.branch_id, v_staff.local_staff_id,
        'payment_refunded', v_order.status, v_order.status, v_order.payment_reference,
        'Staff confirmed that the payment was refunded.', v_now, v_now, v_now
      );
    end if;
    if v_order.stock_deducted_at is not null then
      for v_item in
        select item.*
        from public.web_order_items item
        where item.order_id = v_order.id and item.deleted_at is null
        order by item.line_number
      loop
        if v_item.product_id is null then
          raise exception 'A packed order item is no longer linked to a product.';
        end if;
        insert into public.stock_movements (
          id, idempotency_key, branch_id, product_id, movement_type, quantity_delta_milli,
          unit_cost_paisa, reference_type, reference_id, created_by, occurred_at, created_at,
          server_updated_at, notes
        ) values (
          gen_random_uuid(), 'web-order-cancel:' || v_order.id::text || ':' || v_item.id::text,
          v_order.branch_id, v_item.product_id, 'return', v_item.quantity_milli,
          v_item.unit_cost_paisa, 'web_order', v_order.id::text, v_staff.local_staff_id,
          v_now, v_now, v_now, 'Cancelled packed web order ' || v_order.order_number
        );
      end loop;
    end if;

    update public.web_orders
    set status = 'cancelled', cancelled_by = v_staff.local_staff_id,
        cancelled_at = v_now, updated_at = v_now, server_updated_at = v_now
    where id = v_order.id and status = v_order.status;
    if not found then raise exception 'The order changed; refresh and try again.'; end if;
    insert into public.web_order_events (
      id, order_id, branch_id, actor_id, event_type, previous_status, next_status,
      occurred_at, created_at, server_updated_at
    ) values (
      gen_random_uuid(), v_order.id, v_order.branch_id, v_staff.local_staff_id,
      'cancelled', v_order.status, 'cancelled', v_now, v_now, v_now
    );
  end if;

  return jsonb_build_object('id', v_order.id, 'action', p_action);
end;
$$;

revoke all on function public.staff_manage_web_order(text, jsonb) from public, anon;
grant execute on function public.staff_manage_web_order(text, jsonb) to authenticated;

drop policy if exists "web_order_payment_proofs_staff_read" on storage.objects;
create policy "web_order_payment_proofs_staff_read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'web-order-payment-proofs'
    and public.is_staff()
    and exists (
      select 1
      from public.web_orders order_row
      where order_row.payment_proof_path = storage.objects.name
        and order_row.deleted_at is null
        and case
          when (storage.foldername(storage.objects.name))[1] ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then order_row.branch_id = ((storage.foldername(storage.objects.name))[1])::uuid
            and public.has_branch_access(order_row.branch_id)
          else false
        end
        and (
          exists (
            select 1 from public.cloud_staff staff
            where staff.user_id = auth.uid() and staff.is_active and staff.role = 'admin'
          )
          or not exists (
            select 1
            from public.web_order_permissions permission
            join public.cloud_staff staff on staff.user_id = auth.uid() and staff.is_active
            where permission.branch_id = order_row.branch_id
              and permission.role = staff.role
              and permission.action = 'verify_payment'
              and permission.deleted_at is null
              and not permission.is_allowed
          )
        )
    )
  );

commit;
