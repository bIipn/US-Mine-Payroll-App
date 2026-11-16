-- MineMuster, step 1 hardening: the last-supervisor guard holds under concurrency.
--
-- roster_keeps_a_supervisor is an after-statement trigger that counts a
-- company's remaining supervisors. On its own it takes no lock, so two
-- transactions that each remove a different supervisor of the same company
-- (two supervisors stepping down at once, releasing each other, or one
-- supervisor sending two requests) each count the other as still there under
-- READ COMMITTED, and the company can be left with no supervisor.
--
-- The guard now locks each company that lost a counting supervisor in this
-- statement, in a fixed order, before it counts. A second transaction changing
-- the same company's supervisors waits on that lock; the count that follows is
-- a new statement, so at READ COMMITTED it takes a fresh snapshot and sees the
-- first transaction's committed change. FOR NO KEY UPDATE does not conflict
-- with the FOR KEY SHARE that foreign-key checks take, and raises a
-- serialization failure under REPEATABLE READ instead of letting both through.
--
-- The triggers that call this function are unchanged; replacing the function
-- keeps them.

create or replace function public.roster_keeps_a_supervisor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Lock every company that lost a counting supervisor in this statement, in a
  -- fixed order so two such statements cannot deadlock each other.
  perform 1
  from public.companies c
  where c.id in (
    select o.company_id
    from old_rows o
    where o.role = 'supervisor' and o.active and o.user_id is not null
  )
  order by c.id
  for no key update of c;

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
