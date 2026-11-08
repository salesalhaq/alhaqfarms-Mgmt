begin;

create table if not exists public.branch_pos_settings (
  branch_id uuid primary key references public.branches (id) on delete cascade,
  tax_mode text not null default 'inclusive' check (tax_mode in ('inclusive', 'exclusive')),
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 10000),
  tax_rounding_scope text not null default 'per_line' check (tax_rounding_scope in ('per_line', 'per_sale')),
  tax_rounding_method text not null default 'half_up' check (tax_rounding_method in ('half_up', 'down', 'up')),
  tax_rounding_increment_paisa integer not null default 1 check (tax_rounding_increment_paisa in (1, 5, 10, 25, 50, 100)),
  tax_display text not null default 'summary' check (tax_display in ('summary', 'detailed')),
  max_item_discount_bps integer not null default 10000 check (max_item_discount_bps between 0 and 10000),
  max_bill_discount_bps integer not null default 10000 check (max_bill_discount_bps between 0 and 10000),
  loyalty_points_per_100 integer not null default 1 check (loyalty_points_per_100 between 0 and 10000),
  loyalty_point_value_paisa integer not null default 100 check (loyalty_point_value_paisa between 1 and 1000000),
  low_stock_threshold integer not null default 3 check (low_stock_threshold between 0 and 1000000),
  allow_negative_stock boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users (id)
);

alter table public.branch_pos_settings enable row level security;

create policy "Staff can read POS settings for accessible branches"
  on public.branch_pos_settings for select to authenticated
  using (public.is_staff() and public.has_branch_access(branch_id));

create policy "Admins can insert POS settings for accessible branches"
  on public.branch_pos_settings for insert to authenticated
  with check (public.is_admin_role() and public.has_branch_access(branch_id));

create policy "Admins can update POS settings for accessible branches"
  on public.branch_pos_settings for update to authenticated
  using (public.is_admin_role() and public.has_branch_access(branch_id))
  with check (public.is_admin_role() and public.has_branch_access(branch_id));

create table if not exists public.branch_fbr_settings (
  branch_id uuid primary key references public.branches (id) on delete cascade,
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  base_url text not null default '',
  registration_number text not null default '',
  pos_id text not null default '',
  payment_mode integer not null default 0 check (payment_mode between 0 and 2147483647),
  client_id text not null default '',
  enabled boolean not null default false,
  credentials_encrypted jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users (id)
);

alter table public.branch_fbr_settings enable row level security;

create policy "Admins can read FBR settings for accessible branches"
  on public.branch_fbr_settings for select to authenticated
  using (public.is_admin_role() and public.has_branch_access(branch_id));

create policy "Admins can insert FBR settings for accessible branches"
  on public.branch_fbr_settings for insert to authenticated
  with check (public.is_admin_role() and public.has_branch_access(branch_id));

create policy "Admins can update FBR settings for accessible branches"
  on public.branch_fbr_settings for update to authenticated
  using (public.is_admin_role() and public.has_branch_access(branch_id))
  with check (public.is_admin_role() and public.has_branch_access(branch_id));

do $migration$
declare
  v_definition text;
  v_replacement text;
  v_held_definition text;
  v_held_replacement text;
begin
  select pg_get_functiondef('public.staff_complete_pos_sale(jsonb)'::regprocedure)
    into v_definition;

  if position('v_branch_pos_settings' in v_definition) = 0 then
    v_definition := replace(
      v_definition,
      '  v_tax_mode text;',
      '  v_tax_mode text;' || E'\n' ||
      '  v_branch_pos_settings public.branch_pos_settings;' || E'\n' ||
      '  v_loyalty_point_value_paisa bigint := 100;' || E'\n' ||
      '  v_loyalty_points_per_100 integer := 1;' || E'\n' ||
      '  v_max_bill_discount_bps integer := 10000;' || E'\n' ||
      '  v_allow_negative_stock boolean := false;'
    );
    if position('v_branch_pos_settings public.branch_pos_settings;' in v_definition) = 0 then
      raise exception 'Could not add branch POS settings to the checkout function.';
    end if;

    v_replacement :=
      'if v_branch_id is null or not public.has_branch_access(v_branch_id) then' || E'\n' ||
      '    raise exception ''You cannot access that branch.'';' || E'\n' ||
      '  end if;' || E'\n' ||
      '  select * into v_branch_pos_settings' || E'\n' ||
      '  from public.branch_pos_settings' || E'\n' ||
      '  where branch_id = v_branch_id;' || E'\n' ||
      '  if found then' || E'\n' ||
      '    v_loyalty_point_value_paisa := v_branch_pos_settings.loyalty_point_value_paisa;' || E'\n' ||
      '    v_loyalty_points_per_100 := v_branch_pos_settings.loyalty_points_per_100;' || E'\n' ||
      '    v_max_bill_discount_bps := v_branch_pos_settings.max_bill_discount_bps;' || E'\n' ||
      '    v_allow_negative_stock := v_branch_pos_settings.allow_negative_stock;' || E'\n' ||
      '  end if;';
    if position(
      '  if v_branch_id is null or not public.has_branch_access(v_branch_id) then' in v_definition
    ) = 0 then
      raise exception 'Could not locate branch authorization in the checkout function.';
    end if;
    v_definition := replace(
      v_definition,
      '  if v_branch_id is null or not public.has_branch_access(v_branch_id) then' || E'\n' ||
      '    raise exception ''You cannot access that branch.'';' || E'\n' ||
      '  end if;',
      v_replacement
    );

    v_definition := replace(
      v_definition,
      'v_tax_mode := coalesce(p_payload->>''taxMode'', ''inclusive'');',
      'v_tax_mode := coalesce(v_branch_pos_settings.tax_mode, ''inclusive'');'
    );
    if position('v_tax_mode := coalesce(v_branch_pos_settings.tax_mode' in v_definition) = 0 then
      raise exception 'Could not enforce the branch tax mode during checkout.';
    end if;

    v_definition := replace(
      v_definition,
      'if v_available < v_stock.quantity_milli then',
      'if not v_allow_negative_stock and v_available < v_stock.quantity_milli then'
    );
    if position('if not v_allow_negative_stock and v_available < v_stock.quantity_milli then' in v_definition) = 0 then
      raise exception 'Could not enforce branch negative-stock policy during checkout.';
    end if;

    v_definition := replace(
      v_definition,
      '  if v_bill_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000) then',
      'if v_bill_discount::numeric * 10000 > v_subtotal::numeric * v_max_bill_discount_bps then' || E'\n' ||
      '    raise exception ''Bill discount exceeds the configured branch limit.'';' || E'\n' ||
      '  end if;' || E'\n' ||
      '  if v_bill_discount > least(floor(v_subtotal::numeric * 0.03)::bigint, 10000) then'
    );
    if position('Bill discount exceeds the configured branch limit.' in v_definition) = 0 then
      raise exception 'Could not enforce the configured maximum bill discount.';
    end if;

    v_definition := replace(
      v_definition,
      'v_loyalty_discount := v_loyalty_points::bigint * 100;',
      'v_loyalty_discount := v_loyalty_points::bigint * v_loyalty_point_value_paisa;'
    );
    if position('v_loyalty_points::bigint * v_loyalty_point_value_paisa' in v_definition) = 0 then
      raise exception 'Could not apply the configured loyalty point value during checkout.';
    end if;

    v_definition := replace(
      v_definition,
      'else least(floor(v_total::numeric / 10000), 2147483647)::integer',
      'else least(floor(v_total::numeric / 10000) * v_loyalty_points_per_100, 2147483647)::integer'
    );
    if position('v_loyalty_points_per_100, 2147483647' in v_definition) = 0 then
      raise exception 'Could not apply the configured loyalty earn rate during checkout.';
    end if;

    if position('branch_pos_settings' in v_definition) = 0
      or position('v_max_bill_discount_bps' in v_definition) = 0 then
      raise exception 'The checkout function was not fully updated with branch settings.';
    end if;
    execute v_definition;

    select pg_get_functiondef('public.staff_manage_pos_held_sale(text, jsonb)'::regprocedure)
      into v_held_definition;
    if position('v_branch_loyalty_point_value_paisa' in v_held_definition) = 0 then
      v_held_definition := replace(
        v_held_definition,
        '  v_loyalty_points integer;',
        '  v_loyalty_points integer;' || E'\n' ||
        '  v_branch_loyalty_point_value_paisa bigint := 100;'
      );
      if position('v_branch_loyalty_point_value_paisa bigint' in v_held_definition) = 0 then
        raise exception 'Could not add branch loyalty value to held-sale validation.';
      end if;
      v_held_replacement :=
        'select coalesce((select settings.loyalty_point_value_paisa::bigint' || E'\n' ||
        '    from public.branch_pos_settings settings where settings.branch_id = v_branch_id), 100)' || E'\n' ||
        '    into v_branch_loyalty_point_value_paisa;' || E'\n' ||
        '  ';
      if position('if p_action = ''list'' then' in v_held_definition) = 0 then
        raise exception 'Could not locate the held-sale action dispatch.';
      end if;
      v_held_definition := replace(
        v_held_definition,
        'if p_action = ''list'' then',
        v_held_replacement || 'if p_action = ''list'' then'
      );
      if position('into v_branch_loyalty_point_value_paisa' in v_held_definition) = 0 then
        raise exception 'Could not load branch loyalty settings for held-sale validation.';
      end if;
      v_held_definition := replace(
        v_held_definition,
        'v_discount + v_loyalty_points::bigint * 100 > v_subtotal',
        'v_discount + v_loyalty_points::bigint * v_branch_loyalty_point_value_paisa > v_subtotal'
      );
      if position('v_branch_loyalty_point_value_paisa > v_subtotal' in v_held_definition) = 0 then
        raise exception 'Could not enforce branch loyalty value during held-sale validation.';
      end if;
      execute v_held_definition;
    end if;
  end if;
end;
$migration$;

grant select, insert, update on public.branch_pos_settings to authenticated;
grant select, insert, update on public.branch_fbr_settings to authenticated;

notify pgrst, 'reload schema';
commit;
