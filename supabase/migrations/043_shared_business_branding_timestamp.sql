create or replace function public.set_web_business_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists web_business_settings_set_updated_at
  on public.web_business_settings;

create trigger web_business_settings_set_updated_at
  before insert or update on public.web_business_settings
  for each row
  execute function public.set_web_business_settings_updated_at();
