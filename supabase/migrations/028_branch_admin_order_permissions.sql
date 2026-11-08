begin;

drop policy if exists "web_order_permissions_insert" on public.web_order_permissions;
create policy "web_order_permissions_insert" on public.web_order_permissions
  for insert to authenticated
  with check (public.is_admin_role() and public.has_branch_access(branch_id));

drop policy if exists "web_order_permissions_update" on public.web_order_permissions;
create policy "web_order_permissions_update" on public.web_order_permissions
  for update to authenticated
  using (public.is_admin_role() and public.has_branch_access(branch_id))
  with check (public.is_admin_role() and public.has_branch_access(branch_id));

notify pgrst, 'reload schema';

commit;
