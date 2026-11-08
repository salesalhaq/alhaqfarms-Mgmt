begin;

create or replace function public.list_staff_accounts()
returns table (
  id uuid,
  user_id uuid,
  full_name text,
  email text,
  username text,
  role text,
  branch_id uuid,
  branch_name text,
  is_active boolean,
  web_enrolled boolean,
  pin_configured boolean,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz,
  permanently_deleted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_hq_admin() then
    raise exception 'Only the HQ administrator can view staff profiles.' using errcode = '42501';
  end if;

  return query
  select profile.id,
         cloud.user_id,
         profile.full_name,
         profile.email,
         profile.username,
         profile.role,
         profile.branch_id,
         coalesce(branch.name, 'Head office'),
         profile.is_active,
         coalesce(credential.web_enrolled_at is not null, false),
         coalesce(credential.pin_hash is not null, false),
         profile.created_at,
         profile.updated_at,
         profile.deleted_at,
         profile.permanently_deleted_at
    from public.staff_profiles profile
    left join public.branches branch on branch.id = profile.branch_id
    left join lateral (
      select staff.user_id
        from public.cloud_staff staff
       where staff.local_staff_id = profile.id
       order by staff.created_at desc, staff.user_id
       limit 1
    ) cloud on true
    left join public.staff_shared_credentials credential on credential.staff_id = profile.id
   order by profile.deleted_at nulls first, profile.full_name;
end;
$$;

create or replace function public.staff_manage_account(
  p_action text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.cloud_staff;
  v_profile public.staff_profiles;
  v_profile_id uuid;
  v_branch_id uuid;
  v_role text;
  v_name text;
  v_email text;
  v_username text;
  v_now timestamptz := now();
  v_is_active boolean;
  v_is_hq_admin boolean;
begin
  select * into v_actor
    from public.cloud_staff
   where user_id = auth.uid()
     and is_active
     and role = 'admin'
     and branch_id is null;
  if v_actor.user_id is null or not public.is_hq_admin() then
    raise exception 'Only the HQ administrator can manage staff profiles.' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Provide valid staff account details.';
  end if;

  if p_action = 'save_profile' then
    v_name := nullif(btrim(p_payload->>'fullName'), '');
    v_email := lower(nullif(btrim(p_payload->>'email'), ''));
    v_username := nullif(btrim(p_payload->>'username'), '');
    v_role := lower(coalesce(p_payload->>'role', ''));
    begin
      v_branch_id := (p_payload->>'branchId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose an active branch.';
    end;
    if v_name is null or length(v_name) > 200 then
      raise exception 'Enter a full name of 200 characters or fewer.';
    end if;
    if v_email is null or length(v_email) > 254 or v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'Enter a valid email address.';
    end if;
    if v_username is null or length(v_username) < 3 or length(v_username) > 50
       or v_username !~ '^[A-Za-z0-9._-]{3,50}$' then
      raise exception 'Username must be 3–50 letters, numbers, dots, underscores or hyphens.';
    end if;
    if v_role not in ('admin', 'manager', 'cashier') then
      raise exception 'Choose a valid staff role.';
    end if;
    if not exists (
      select 1 from public.branches
       where id = v_branch_id and is_active and deleted_at is null
    ) then
      raise exception 'Choose an active branch.';
    end if;
    v_profile_id := null;
    if nullif(p_payload->>'id', '') is not null then
      begin
        v_profile_id := (p_payload->>'id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Choose a valid staff profile.';
      end;
    end if;
    if exists (
      select 1 from public.staff_profiles
       where lower(email) = v_email
         and deleted_at is null
         and permanently_deleted_at is null
         and id <> coalesce(v_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) then
      raise exception 'Another staff account already uses this email.';
    end if;
    if exists (
      select 1 from public.staff_profiles
       where lower(username) = lower(v_username)
         and deleted_at is null
         and permanently_deleted_at is null
         and id <> coalesce(v_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) then
      raise exception 'Another staff account already uses this username.';
    end if;

    if v_profile_id is not null then
      select * into v_profile
        from public.staff_profiles
       where id = v_profile_id
         and deleted_at is null
         and permanently_deleted_at is null
       for update;
      if not found then raise exception 'Staff account not found.'; end if;
      if v_profile.branch_id is distinct from v_branch_id then
        raise exception 'A staff account cannot be moved between branches. Archive it and create a new profile at the destination branch.';
      end if;
      if v_profile.id = v_actor.local_staff_id and v_role <> v_profile.role then
        raise exception 'You cannot change your own role.';
      end if;
      if lower(v_profile.email) is distinct from v_email and exists (
        select 1 from public.cloud_staff
         where local_staff_id = v_profile_id
      ) then
        raise exception 'Email cannot be changed while a staff login is linked. Update the linked login before changing this profile email.';
      end if;

      update public.staff_profiles
         set full_name = v_name,
             email = v_email,
             username = v_username,
             role = v_role,
             updated_at = v_now,
             server_updated_at = v_now
       where id = v_profile_id;
      update public.cloud_staff
         set full_name = v_name, email = v_email, role = v_role, updated_at = v_now
       where local_staff_id = v_profile_id;
      insert into public.audit_log
        (id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at)
      values (
        gen_random_uuid(), v_actor.local_staff_id, v_profile.branch_id, 'staff.updated',
        'staff_profile', v_profile_id::text,
        jsonb_build_object('fullName', v_name, 'email', v_email, 'username', v_username, 'role', v_role, 'branchId', v_branch_id),
        v_now, v_now
      );
    else
      v_profile_id := gen_random_uuid();
      insert into public.staff_profiles (
        id, branch_id, full_name, email, username, role, is_active,
        pin_reset_required, created_at, updated_at, server_updated_at
      ) values (
        v_profile_id, v_branch_id, v_name, v_email, v_username, v_role, true,
        true, v_now, v_now, v_now
      );
      insert into public.audit_log
        (id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at)
      values (
        gen_random_uuid(), v_actor.local_staff_id, v_actor.branch_id, 'staff.created',
        'staff_profile', v_profile_id::text,
        jsonb_build_object('fullName', v_name, 'email', v_email, 'username', v_username, 'role', v_role, 'branchId', v_branch_id),
        v_now, v_now
      );
    end if;
    return jsonb_build_object('id', v_profile_id);
  end if;

  begin
    v_profile_id := (p_payload->>'id')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid staff profile.';
  end;
  select * into v_profile
    from public.staff_profiles
   where id = v_profile_id
   for update;
  if not found then raise exception 'Staff account not found.'; end if;

  select exists (
    select 1
      from public.cloud_staff
     where local_staff_id = v_profile_id
       and role = 'admin'
       and branch_id is null
       and is_active
  ) into v_is_hq_admin;

  if p_action = 'set_active' then
    if v_profile.deleted_at is not null or v_profile.permanently_deleted_at is not null then
      raise exception 'Restore the archived staff profile before changing its status.';
    end if;
    v_is_active := coalesce((p_payload->>'isActive')::boolean, false);
    if v_profile_id = v_actor.local_staff_id and not v_is_active then
      raise exception 'You cannot deactivate your own account.';
    end if;
    if v_is_active and not exists (
      select 1 from public.branches
       where id = v_profile.branch_id and is_active and deleted_at is null
    ) then
      raise exception 'Activate the assigned branch before activating this staff account.';
    end if;
    if v_is_hq_admin and not v_is_active and not exists (
      select 1 from public.cloud_staff other
       where other.user_id <> v_actor.user_id
         and other.role = 'admin'
         and other.branch_id is null
         and other.is_active
    ) then
      raise exception 'At least one HQ administrator must stay active.';
    end if;
    update public.staff_profiles
       set is_active = v_is_active,
           security_version = security_version + 1,
           pin_reset_required = case when v_is_active then true else pin_reset_required end,
           sessions_invalid_after = v_now::text,
           updated_at = v_now,
           server_updated_at = v_now
     where id = v_profile_id;
    update public.cloud_staff
       set is_active = v_is_active, updated_at = v_now
     where local_staff_id = v_profile_id;
    insert into public.audit_log
      (id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at)
    values (
      gen_random_uuid(), v_actor.local_staff_id, v_profile.branch_id,
      case when v_is_active then 'staff.activated' else 'staff.deactivated' end,
      'staff_profile', v_profile_id::text, jsonb_build_object('isActive', v_is_active), v_now, v_now
    );
    return jsonb_build_object('id', v_profile_id, 'isActive', v_is_active);
  elsif p_action = 'archive' then
    if v_profile.deleted_at is not null or v_profile.permanently_deleted_at is not null then
      raise exception 'Staff account not found.';
    end if;
    if v_profile_id = v_actor.local_staff_id then raise exception 'You cannot archive your own staff account.'; end if;
    if v_is_hq_admin and not exists (
      select 1 from public.cloud_staff other
       where other.user_id <> v_actor.user_id
         and other.role = 'admin'
         and other.branch_id is null
         and other.is_active
    ) then
      raise exception 'At least one HQ administrator must stay active.';
    end if;
    update public.staff_profiles
       set deleted_at = v_now, is_active = false,
           security_version = security_version + 1, pin_reset_required = true,
           sessions_invalid_after = v_now::text, updated_at = v_now, server_updated_at = v_now
     where id = v_profile_id;
    update public.cloud_staff set is_active = false, updated_at = v_now where local_staff_id = v_profile_id;
    update public.staff_credential_invitations
       set revoked_at = v_now
     where staff_id = v_profile_id and consumed_at is null and revoked_at is null;
    insert into public.audit_log
      (id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at)
    values (
      gen_random_uuid(), v_actor.local_staff_id, v_profile.branch_id, 'staff.archived',
      'staff_profile', v_profile_id::text, jsonb_build_object('archivedAt', v_now), v_now, v_now
    );
    return jsonb_build_object('id', v_profile_id, 'archived', true);
  elsif p_action = 'restore' then
    if v_profile.deleted_at is null or v_profile.permanently_deleted_at is not null then
      raise exception 'Archived staff account not found.';
    end if;
    update public.staff_profiles
       set deleted_at = null, is_active = false,
           security_version = security_version + 1, pin_reset_required = true,
           sessions_invalid_after = v_now::text, updated_at = v_now, server_updated_at = v_now
     where id = v_profile_id;
    update public.cloud_staff set is_active = false, updated_at = v_now where local_staff_id = v_profile_id;
    insert into public.audit_log
      (id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at)
    values (
      gen_random_uuid(), v_actor.local_staff_id, v_profile.branch_id, 'staff.restored',
      'staff_profile', v_profile_id::text, '{}'::jsonb, v_now, v_now
    );
    return jsonb_build_object('id', v_profile_id, 'restored', true);
  else
    raise exception 'Choose a supported staff account action.';
  end if;
end;
$$;

create or replace function public.authorize_staff_admin_credential_reset(p_staff_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.cloud_staff;
  v_profile public.staff_profiles;
  v_target_user_id uuid;
begin
  select * into v_actor
    from public.cloud_staff
   where user_id = auth.uid()
     and is_active
     and role = 'admin'
     and branch_id is null;
  if v_actor.user_id is null or not public.is_hq_admin() then
    raise exception 'Only the HQ administrator can reset staff credentials.' using errcode = '42501';
  end if;
  select * into v_profile
    from public.staff_profiles
   where id = p_staff_id
     and is_active
     and deleted_at is null
     and permanently_deleted_at is null;
  if not found then raise exception 'Choose an active staff profile.'; end if;

  select staff.user_id into v_target_user_id
    from public.cloud_staff staff
   where staff.local_staff_id = v_profile.id
     and staff.is_active
   order by staff.created_at desc, staff.user_id
   limit 1;
  return jsonb_build_object('authorized', true, 'userId', v_target_user_id);
end;
$$;

create or replace function public.set_staff_shared_credential_by_admin(
  p_actor_user_id uuid,
  p_staff_id uuid,
  p_mode text,
  p_new_secret text
)
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor public.cloud_staff;
  v_profile public.staff_profiles;
  v_credentials public.staff_shared_credentials;
  v_security_version integer;
begin
  select * into v_actor
    from public.cloud_staff
   where user_id = p_actor_user_id
     and is_active
     and role = 'admin'
     and branch_id is null;
  if v_actor.user_id is null then
    raise exception 'Only the HQ administrator can reset staff credentials.' using errcode = '42501';
  end if;
  select * into v_profile
    from public.staff_profiles
   where id = p_staff_id
     and is_active
     and deleted_at is null
     and permanently_deleted_at is null
   for update;
  if not found then raise exception 'Choose an active staff profile.'; end if;
  if p_mode = 'password' then
    if length(coalesce(p_new_secret, '')) < 10 or length(p_new_secret) > 200 then
      raise exception 'Password must be between 10 and 200 characters.';
    end if;
  elsif p_mode = 'pin' then
    if coalesce(p_new_secret, '') !~ '^[0-9]{4,8}$' then
      raise exception 'PIN must contain 4 to 8 digits.';
    end if;
  else
    raise exception 'Choose password or PIN.';
  end if;

  select * into v_credentials
    from public.staff_shared_credentials
   where staff_id = p_staff_id
   for update;
  v_security_version := coalesce(v_credentials.security_version, 0) + 1;
  if p_mode = 'pin' and v_credentials.staff_id is null then
    raise exception 'This staff member has not enrolled a password yet. Set the password or issue an enrollment invitation first.';
  end if;

  if p_mode = 'password' then
    insert into public.staff_shared_credentials (
      staff_id, password_hash, pin_hash, pin_configured_at, security_version, web_enrolled_at,
      failed_password_attempts, password_locked_until, failed_pin_attempts, pin_locked_until,
      created_at, updated_at
    ) values (
      p_staff_id,
      crypt(encode(digest(p_new_secret, 'sha256'), 'hex'), gen_salt('bf', 12)),
      v_credentials.pin_hash,
      v_credentials.pin_configured_at,
      v_security_version,
      coalesce(v_credentials.web_enrolled_at, now()),
      0, null, 0, null, now(), now()
    )
    on conflict (staff_id) do update
      set password_hash = excluded.password_hash,
          security_version = excluded.security_version,
          failed_password_attempts = 0,
          password_locked_until = null,
          failed_pin_attempts = 0,
          pin_locked_until = null,
          updated_at = now();
  else
    update public.staff_shared_credentials
       set pin_hash = crypt(p_new_secret, gen_salt('bf', 12)),
           pin_configured_at = now(),
           security_version = v_security_version,
           failed_pin_attempts = 0,
           pin_locked_until = null,
           updated_at = now()
     where staff_id = p_staff_id;
  end if;

  insert into public.audit_log
    (id, actor_id, branch_id, action, entity_type, entity_id, details_json, occurred_at, server_updated_at)
  values (
    gen_random_uuid(), v_actor.local_staff_id, v_profile.branch_id,
    case when p_mode = 'password' then 'staff.password_reset' else 'staff.pin_reset' end,
    'staff_profile', p_staff_id::text, jsonb_build_object('mode', p_mode), now(), now()
  );
  return v_security_version;
end;
$$;

revoke all on function public.list_staff_accounts() from public, anon;
revoke all on function public.staff_manage_account(text, jsonb) from public, anon;
revoke all on function public.authorize_staff_admin_credential_reset(uuid) from public, anon;
revoke all on function public.set_staff_shared_credential_by_admin(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.list_staff_accounts() to authenticated;
grant execute on function public.staff_manage_account(text, jsonb) to authenticated;
grant execute on function public.authorize_staff_admin_credential_reset(uuid) to authenticated;
grant execute on function public.set_staff_shared_credential_by_admin(uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
commit;
