begin;

create table if not exists public.fbr_pct_categories (
  id text primary key,
  name text not null,
  pct_code text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

with candidates as (
  select
    coalesce(
      nullif(btrim(metadata_json->>'fbrPctCategoryId'), ''),
      nullif(btrim(metadata_json->>'fbrPctCode'), ''),
      nullif(btrim(metadata_json->>'fbrPctCategoryName'), '')
    ) as category_id,
    nullif(btrim(metadata_json->>'fbrPctCategoryName'), '') as category_name,
    nullif(btrim(metadata_json->>'fbrPctCode'), '') as pct_code,
    nullif(btrim(metadata_json->>'fbrPctDescription'), '') as category_description
  from public.products
  where deleted_at is null
    and metadata_json is not null
)
insert into public.fbr_pct_categories (
  id, name, pct_code, description, is_active, created_at, updated_at
)
select distinct on (lower(coalesce(category_name, pct_code, category_id)))
  category_id,
  coalesce(category_name, pct_code, category_id),
  coalesce(pct_code, ''),
  category_description,
  true,
  now(),
  now()
from candidates
where category_id is not null
order by lower(coalesce(category_name, pct_code, category_id)), category_id
on conflict (id) do nothing;

create unique index if not exists ux_fbr_pct_categories_name
  on public.fbr_pct_categories (lower(name));

alter table public.fbr_pct_categories enable row level security;

grant select, insert, update on public.fbr_pct_categories to authenticated;

drop policy if exists "fbr_pct_categories_select" on public.fbr_pct_categories;
create policy "fbr_pct_categories_select" on public.fbr_pct_categories
  for select to authenticated using (public.is_admin_role());

drop policy if exists "fbr_pct_categories_insert" on public.fbr_pct_categories;
create policy "fbr_pct_categories_insert" on public.fbr_pct_categories
  for insert to authenticated with check (public.is_admin_role());

drop policy if exists "fbr_pct_categories_update" on public.fbr_pct_categories;
create policy "fbr_pct_categories_update" on public.fbr_pct_categories
  for update to authenticated using (public.is_admin_role())
  with check (public.is_admin_role());

commit;
