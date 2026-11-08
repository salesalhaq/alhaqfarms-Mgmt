create table if not exists public.web_business_settings (
  id text primary key check (id = 'shop'),
  settings jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id)
);

alter table public.web_business_settings enable row level security;

grant select, insert, update on public.web_business_settings to authenticated;

create policy "Active staff can read web business settings"
  on public.web_business_settings
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.cloud_staff
      where user_id = auth.uid()
        and is_active
    )
  );

create policy "Admins can insert web business settings"
  on public.web_business_settings
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.cloud_staff
      where user_id = auth.uid()
        and is_active
        and role = 'admin'
    )
    and updated_by = auth.uid()
  );

create policy "Admins can update web business settings"
  on public.web_business_settings
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.cloud_staff
      where user_id = auth.uid()
        and is_active
        and role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from public.cloud_staff
      where user_id = auth.uid()
        and is_active
        and role = 'admin'
    )
    and updated_by = auth.uid()
  );
