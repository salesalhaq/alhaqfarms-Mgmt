-- HQ-managed expense categories must be readable by branch managers so they
-- can record expenses, while category creation remains HQ-admin-only.
drop policy if exists "expense_categories_select" on public."expense_categories";
create policy "expense_categories_select" on public."expense_categories"
  for select to authenticated
  using (
    public.is_manager_or_admin()
    and exists (
      select 1
      from public."staff_profiles" scope_1
      where scope_1.id = "created_by"
        and (
          public.has_branch_access(scope_1.branch_id)
          or (scope_1.branch_id is null and scope_1.role = 'admin')
        )
    )
  );
