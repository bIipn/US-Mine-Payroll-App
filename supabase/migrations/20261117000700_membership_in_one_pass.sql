-- MineMuster: the caller's companies worked out in one pass, with the caller's
-- id read once.
--
-- This migration is new; it never edits an applied one. Every row level
-- security policy asks these functions which companies are the caller's, once
-- per statement, so their cost is the cost of every read.
--
--  1. records_open_company_ids (20261117000500) unnested member_company_ids()
--     and compared each company with supervisor_company_ids(), called in a
--     CTE. PostgreSQL inlines a CTE that is used once, so the call landed in
--     the filter and ran again for every one of the caller's companies: the
--     cost grew with the square of how many companies the caller is in. An
--     account in about 1,400 companies took one call past the 8 s
--     statement_timeout, holding one of PostgREST's database connections all
--     that time, and twelve such calls at once made another company's plain
--     read take 7 s instead of 0.03 s. Any account can be in that many: the
--     security scan's one account started 381 companies in nine minutes, and
--     an account may join as many companies as will have it.
--
--     It now reads the caller's roster rows once: every company it is a
--     member of, and of those it supervises only the ones that have
--     MineMuster. The answer is the same in every case, because the roster
--     holds one row per account and company (roster_one_row_per_account): "a
--     member there, and either not its supervisor or the company has
--     MineMuster" is a test of that one row. Inactive rows, accounts Supabase
--     Auth has soft-deleted or banned, and nobody signed in give no companies,
--     as before. company_has_access is asked once for each company the caller
--     supervises, as before, and for nothing else.
--
--  2. member_company_ids, supervisor_company_ids, is_member and is_supervisor
--     compared each roster row with auth.uid(), which PostgreSQL may work out
--     again for every row it reads (it did for the first two: once for each
--     of the caller's companies). Each now reads it once per call, as
--     (select auth.uid()), which PostgreSQL runs once as an InitPlan.
--     my_companies already reads it once, into a variable, and is left as it
--     is.
--
-- Nothing else about any of them changes: each is still language sql, stable,
-- security definer with search_path pg_catalog, pg_temp, with the same
-- arguments, the same answers and the same grants (to authenticated only).
-- membership_reads.db.mjs holds each to the answers of the definition it
-- replaces, case by case, and an account in 1,000 companies to a time well
-- inside the timeout.

-- As in 20261116002300_membership_needs_a_sign_in.sql, with the caller's id read once.
create or replace function public.is_member(company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from public.roster r
    join auth.users u on u.id = r.user_id
    where r.company_id = is_member.company_id
      and r.user_id = (select auth.uid())
      and r.active
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
  );
$$;

create or replace function public.is_supervisor(company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from public.roster r
    join auth.users u on u.id = r.user_id
    where r.company_id = is_supervisor.company_id
      and r.user_id = (select auth.uid())
      and r.active
      and r.role = 'supervisor'
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
  );
$$;

revoke all on function public.is_member(uuid) from public, anon, authenticated, service_role;
revoke all on function public.is_supervisor(uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_supervisor(uuid) to authenticated;

-- As in 20261116002300_membership_needs_a_sign_in.sql, with the caller's id read once.
create or replace function public.member_company_ids()
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(pg_catalog.array_agg(r.company_id), '{}')
  from public.roster r
  join auth.users u on u.id = r.user_id
  where r.user_id = (select auth.uid())
    and r.active
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.now());
$$;

create or replace function public.supervisor_company_ids()
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(pg_catalog.array_agg(r.company_id), '{}')
  from public.roster r
  join auth.users u on u.id = r.user_id
  where r.user_id = (select auth.uid())
    and r.active
    and r.role = 'supervisor'
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.now());
$$;

revoke all on function public.member_company_ids() from public, anon, authenticated, service_role;
revoke all on function public.supervisor_company_ids() from public, anon, authenticated, service_role;
grant execute on function public.member_company_ids() to authenticated;
grant execute on function public.supervisor_company_ids() to authenticated;

-- As in 20261117000500_billing.sql, in one pass over the caller's roster rows:
-- a company the caller is a member of, where it is not a supervisor or the
-- company has MineMuster. Like member_company_ids it never raises.
create or replace function public.records_open_company_ids()
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(pg_catalog.array_agg(r.company_id), '{}')
  from public.roster r
  join auth.users u on u.id = r.user_id
  where r.user_id = (select auth.uid())
    and r.active
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.now())
    and (r.role is distinct from 'supervisor' or public.company_has_access(r.company_id));
$$;

revoke all on function public.records_open_company_ids() from public, anon, authenticated, service_role;
grant execute on function public.records_open_company_ids() to authenticated;
