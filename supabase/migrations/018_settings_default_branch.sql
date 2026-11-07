begin;

create or replace function public.staff_set_default_branch(p_branch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.cloud_staff;
  v_branch public.branches;
  v_now timestamptz := now();
begin
  select * into v_staff
  from public.cloud_staff
  where user_id = auth.uid() and is_active;
  if v_staff.user_id is null or not public.is_staff() then
    raise exception 'Sign in with an active staff account.';
  end if;
  if v_staff.role <> 'admin' or v_staff.branch_id is not null then
    raise exception 'Only an HQ administrator can change the default branch.';
  end if;
  if not public.has_branch_access(p_branch_id) then
    raise exception 'You cannot change that branch.';
  end if;

  perform pg_advisory_xact_lock(118, 1);
  select * into v_branch
  from public.branches
  where id = p_branch_id and is_active and deleted_at is null
  for update;
  if not found then
    raise exception 'Choose an active branch.';
  end if;

  update public.branches
  set is_default = false, updated_at = v_now
  where is_default and deleted_at is null;
  update public.branches
  set is_default = true, updated_at = v_now
  where id = p_branch_id;

  insert into public.audit_log (
    id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at
  ) values (
    gen_random_uuid(), v_staff.local_staff_id, null, 'branch.default_changed',
    'branch', p_branch_id,
    jsonb_build_object('name', v_branch.name), v_now
  );

  return jsonb_build_object(
    'id', v_branch.id,
    'code', v_branch.code,
    'name', v_branch.name,
    'isDefault', true
  );
end;
$$;

revoke all on function public.staff_set_default_branch(uuid) from public, anon;
grant execute on function public.staff_set_default_branch(uuid) to authenticated;

commit;
