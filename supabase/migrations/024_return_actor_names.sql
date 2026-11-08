begin;

create or replace function public.get_return_actor_names(p_return_id uuid)
returns table (actor_id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id uuid;
begin
  if not public.is_staff() then
    raise exception 'An active staff account is required.' using errcode = '42501';
  end if;

  select return_record.branch_id
    into v_branch_id
    from public.returns return_record
   where return_record.id = p_return_id
     and return_record.deleted_at is null;
  if not found then
    raise exception 'Return not found.' using errcode = 'P0002';
  end if;
  if not public.has_branch_access(v_branch_id) then
    raise exception 'You cannot access this return.' using errcode = '42501';
  end if;

  return query
  select distinct actors.actor_id,
         coalesce(profile.full_name, 'Deleted staff')
    from public.returns return_record
    cross join lateral (
      values
        (return_record.created_by),
        (return_record.approved_by),
        (return_record.rejected_by),
        (return_record.completed_by)
    ) actors(actor_id)
    left join public.staff_profiles profile
      on profile.id = actors.actor_id
   where return_record.id = p_return_id
     and actors.actor_id is not null;
end;
$$;

revoke all on function public.get_return_actor_names(uuid) from public, anon;
grant execute on function public.get_return_actor_names(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
