-- MineMuster, step 1: a company always keeps a supervisor.
--
-- Every company has at least one active supervisor whose row is claimed by an
-- account, so there is always someone who can let people in. Any change that
-- would take the last one away is refused, whichever way it comes:
--  * a role changed to employee, or the row taken off (active = false),
--  * the row deleted,
--  * the claim released (release_roster_claim), or
--  * the supervisor's account deleted (the roster's foreign key clears user_id).
-- To step down, the last supervisor makes someone else a supervisor first.
--
-- Deleting the whole company is not refused: its roster goes with it.
--
-- The check runs once a statement has finished, so a statement that changes
-- many rows is judged by where it leaves each company. It only looks at
-- companies that lost a counting supervisor in that statement, so a company
-- in some other state is never held up by an unrelated change.
-- Security definer so it sees the whole roster whoever made the change.

create function public.roster_keeps_a_supervisor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from (
      select distinct o.company_id
      from old_rows o
      where o.role = 'supervisor' and o.active and o.user_id is not null
    ) changed
    where exists (select 1 from public.companies c where c.id = changed.company_id)
      and not exists (
        select 1
        from public.roster r
        where r.company_id = changed.company_id
          and r.role = 'supervisor'
          and r.active
          and r.user_id is not null
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'A company must keep at least one active supervisor with an account.',
      hint = 'Make someone else a supervisor first.';
  end if;
  return null;
end;
$$;

revoke all on function public.roster_keeps_a_supervisor() from public, anon, authenticated, service_role;

create trigger roster_keeps_a_supervisor_on_update
  after update on public.roster
  referencing old table as old_rows
  for each statement execute function public.roster_keeps_a_supervisor();

create trigger roster_keeps_a_supervisor_on_delete
  after delete on public.roster
  referencing old table as old_rows
  for each statement execute function public.roster_keeps_a_supervisor();
