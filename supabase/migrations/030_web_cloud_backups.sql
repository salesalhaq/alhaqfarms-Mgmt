begin;

create table if not exists public.web_data_backups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  branch_ids uuid[] not null,
  object_path text not null unique,
  file_name text not null,
  size_bytes bigint not null check (size_bytes > 0),
  date_from date not null,
  date_to date not null,
  trigger_type text not null default 'manual' check (trigger_type in ('manual', 'scheduled')),
  created_at timestamptz not null default now(),
  check (date_to >= date_from)
);

create index if not exists ix_web_data_backups_owner_created
  on public.web_data_backups (owner_id, created_at desc);

alter table public.web_data_backups enable row level security;
drop policy if exists "Staff can read their own web data backups" on public.web_data_backups;
create policy "Staff can read their own web data backups"
  on public.web_data_backups for select to authenticated
  using (owner_id = auth.uid() and public.is_staff());
drop policy if exists "Staff can create their own web data backups" on public.web_data_backups;
create policy "Staff can create their own web data backups"
  on public.web_data_backups for insert to authenticated
  with check (owner_id = auth.uid() and public.is_staff());
drop policy if exists "Staff can delete their own web data backups" on public.web_data_backups;
create policy "Staff can delete their own web data backups"
  on public.web_data_backups for delete to authenticated
  using (owner_id = auth.uid() and public.is_staff());

create table if not exists public.web_data_backup_preferences (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  branch_ids uuid[] not null,
  frequency text not null default 'manual' check (frequency in ('manual', 'daily', 'weekly')),
  schedule_day smallint check (schedule_day between 0 and 6),
  schedule_time time not null default '02:00',
  retention_days smallint not null default 90 check (retention_days between 30 and 365),
  last_run_date date,
  last_run_at timestamptz,
  last_attempt_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users (id),
  check ((frequency = 'weekly' and schedule_day is not null) or (frequency <> 'weekly' and schedule_day is null))
);

alter table public.web_data_backup_preferences enable row level security;
drop policy if exists "Staff can read their own backup preferences" on public.web_data_backup_preferences;
create policy "Staff can read their own backup preferences"
  on public.web_data_backup_preferences for select to authenticated
  using (owner_id = auth.uid() and public.is_staff());
drop policy if exists "Staff can manage their own backup preferences" on public.web_data_backup_preferences;
create policy "Staff can manage their own backup preferences"
  on public.web_data_backup_preferences for all to authenticated
  using (owner_id = auth.uid() and public.is_staff())
  with check (owner_id = auth.uid() and public.is_staff());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('web-data-backups', 'web-data-backups', false, 26214400, array['application/json'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Staff can read own private web backups" on storage.objects;
create policy "Staff can read own private web backups"
  on storage.objects for select to authenticated
  using (bucket_id = 'web-data-backups' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Staff can upload own private web backups" on storage.objects;
create policy "Staff can upload own private web backups"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'web-data-backups' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Staff can delete own private web backups" on storage.objects;
create policy "Staff can delete own private web backups"
  on storage.objects for delete to authenticated
  using (bucket_id = 'web-data-backups' and (storage.foldername(name))[1] = auth.uid()::text);

grant select, insert, delete on public.web_data_backups to authenticated;
grant select, insert, update, delete on public.web_data_backup_preferences to authenticated;

create or replace function public.claim_due_web_data_backup_preferences(p_now timestamptz default now())
returns setof public.web_data_backup_preferences
language sql
security definer
set search_path = public
as $$
  update public.web_data_backup_preferences as preference
  set last_attempt_at = p_now
  where preference.frequency <> 'manual'
    and (preference.last_run_date is null or preference.last_run_date <> timezone('Asia/Karachi', p_now)::date)
    and (preference.last_attempt_at is null or preference.last_attempt_at < p_now - interval '30 minutes')
    and preference.schedule_time <= timezone('Asia/Karachi', p_now)::time
    and (
      preference.frequency = 'daily'
      or preference.schedule_day = extract(dow from timezone('Asia/Karachi', p_now))::smallint
    )
  returning preference.*;
$$;

revoke all on function public.claim_due_web_data_backup_preferences(timestamptz) from public, anon, authenticated;
grant execute on function public.claim_due_web_data_backup_preferences(timestamptz) to service_role;

notify pgrst, 'reload schema';
commit;
