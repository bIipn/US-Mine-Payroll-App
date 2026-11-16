-- MineMuster, step 1 hardening: the last-supervisor guard, again.
--
-- This migration is new; it never edits an applied one. It closes two gaps in
-- roster_keeps_a_supervisor:
--
--  1. Overlapping changes at REPEATABLE READ. Migration 20261116001400 had the
--     guard lock each affected company (FOR NO KEY UPDATE) before counting. A
--     row lock makes no new row version, so a second REPEATABLE READ
--     transaction that waited on it took the lock without any error once the
--     first committed, then counted with its own older snapshot, in which the
--     other supervisor was still there, and both committed. PostgREST runs at
--     READ COMMITTED, but a direct connection or a function set to a stricter
--     level does not. The guard now WRITES a row per affected company
--     (company_supervisor_guard), in a fixed order. First-updater-wins then
--     applies: at REPEATABLE READ and SERIALIZABLE the second writer fails
--     with 40001 (could not serialize access due to concurrent update) and
--     retries; at READ COMMITTED it waits, and its count, a new statement with
--     a new snapshot, sees the first one's change and refuses (23514).
--
--  2. Accounts that can no longer sign in. Supabase Auth can take an account
--     away without deleting its auth.users row: a soft delete
--     (auth.admin.deleteUser(id, true)) sets deleted_at, and a ban sets
--     banned_until. The roster's foreign key never fires, so the row keeps its
--     user_id, and the guard went on counting a supervisor nobody can sign in
--     as. With two supervisors, once one account was soft-deleted or banned
--     the other could step down through the API and leave nobody. The guard
--     now counts only supervisors whose account is not soft-deleted and not
--     banned now.
--
-- The soft delete or ban itself is an UPDATE on auth.users, which these
-- migrations never put a trigger on (Supabase owns that schema). So the server
-- must not soft-delete or ban the last supervisor of a company who can still
-- sign in; is_last_supervisor(user_id) tells it, and only the server key may
-- call it. A hard delete (auth.admin.deleteUser(id)) is refused by the guard
-- already, through the foreign key.
--
-- The guard reads deleted_at and banned_until from auth.users; Supabase's
-- postgres role, which owns these functions, can read that table.

-- One row per company whose supervisors have changed, written by the guard so
-- two overlapping changes to the same company's supervisors conflict. Nothing
-- reads it. It goes with its company.
create table public.company_supervisor_guard (
  company_id uuid primary key references public.companies (id) on delete cascade,
  changes bigint not null default 0
);

alter table public.company_supervisor_guard enable row level security;
revoke all on table public.company_supervisor_guard from public, anon, authenticated;
revoke truncate on table public.company_supervisor_guard from service_role;

create or replace function public.roster_keeps_a_supervisor()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- One write for each company that lost a counting supervisor in this
  -- statement, in a fixed order so two such statements cannot deadlock. A
  -- company being deleted (its rows going by cascade) is left alone.
  insert into public.company_supervisor_guard as g (company_id)
  select distinct o.company_id
  from old_rows o
  where o.role = 'supervisor' and o.active and o.user_id is not null
    and exists (select 1 from public.companies c where c.id = o.company_id)
  order by 1
  on conflict (company_id) do update set changes = g.changes + 1;

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
        join auth.users u on u.id = r.user_id
        where r.company_id = changed.company_id
          and r.role = 'supervisor'
          and r.active
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= pg_catalog.now())
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

-- Whether this account is, in some company, the only active supervisor who can
-- still sign in. The server asks before it soft-deletes or bans an account:
-- when this is true, it makes someone else a supervisor first.
create function public.is_last_supervisor(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from public.roster mine
    where mine.user_id = is_last_supervisor.user_id
      and mine.role = 'supervisor'
      and mine.active
      and not exists (
        select 1
        from public.roster r
        join auth.users u on u.id = r.user_id
        where r.company_id = mine.company_id
          and r.id <> mine.id
          and r.role = 'supervisor'
          and r.active
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= pg_catalog.now())
      )
  );
$$;

revoke all on function public.is_last_supervisor(uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_last_supervisor(uuid) to service_role;
