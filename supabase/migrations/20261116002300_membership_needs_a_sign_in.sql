-- MineMuster, step 1 hardening: membership goes by accounts that can still sign
-- in, and the row level security policies read only the caller's own companies.
--
-- This migration is new; it never edits an applied one. It closes two things:
--
--  1. A banned or soft-deleted supervisor kept every supervisor power. Migration
--     20261116001700 made the last-supervisor guard count only accounts that can
--     still sign in (auth.users.deleted_at is null and banned_until is not still
--     to come), but is_member and is_supervisor, which every policy and every
--     supervisor function asks, still looked only at the roster. A Supabase
--     access token stays valid until it expires, after a ban or a soft delete as
--     well, so for the rest of its token the account could still promote another
--     account it controls, take the supervisor who can still sign in off the
--     roster (the guard let it, since the new supervisor counted and the banned
--     one never did), rotate the code, approve requests and read everything.
--     Membership now applies the guard's own test: an account Supabase Auth has
--     soft-deleted or banned is no member of any company from that moment, and
--     no supervisor. For the same reason create_company refuses such an account
--     (it would start a company whose only supervisor cannot sign in), and so
--     does join_company (migration 20261116002600).
--
--  2. Every policy called is_member(company_id) or is_supervisor(company_id) on
--     each row the scan reached. A security definer function with a SET clause
--     is never inlined, so a request that did not itself filter on company_id
--     read every company's rows, one function call and one roster probe each;
--     and one that filtered on a column (company_id = X, last_name = Y,
--     company_id < X) took longer the more hidden rows of other companies fit
--     the filter. From response times alone any signed-in account could tell a
--     real company id from a made-up one and roughly how many people it has,
--     confirm a surname on another company's roster, and recover other
--     companies' ids by bisecting a range: what migration 20261116002200 closed
--     for the planner's estimates. Each policy now compares the row's company
--     with the caller's own companies, worked out once per statement
--     (member_company_ids() and supervisor_company_ids() in a scalar subquery,
--     which PostgreSQL runs once as an InitPlan). The comparison is an index
--     condition, so other companies' rows are not read at all.
--
-- The `::uuid[]` cast is needed: without it `= any ((select ...))` is read as a
-- comparison with each row of a subquery, and uuid = uuid[] does not exist.
-- is_member and is_supervisor stay, for the functions that ask about one company.

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
      and r.user_id = auth.uid()
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
      and r.user_id = auth.uid()
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

-- The companies the signed-in account is a member of, and those it supervises,
-- by the same rule as is_member and is_supervisor. Empty when nobody is signed
-- in. Security definer so the policies can call them without the roster's own
-- policy getting in the way; they say nothing but which companies are the
-- caller's own.
create function public.member_company_ids()
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(pg_catalog.array_agg(r.company_id), '{}')
  from public.roster r
  join auth.users u on u.id = r.user_id
  where r.user_id = auth.uid()
    and r.active
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.now());
$$;

create function public.supervisor_company_ids()
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(pg_catalog.array_agg(r.company_id), '{}')
  from public.roster r
  join auth.users u on u.id = r.user_id
  where r.user_id = auth.uid()
    and r.active
    and r.role = 'supervisor'
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.now());
$$;

revoke all on function public.member_company_ids() from public, anon, authenticated, service_role;
revoke all on function public.supervisor_company_ids() from public, anon, authenticated, service_role;
-- The policies run them as the signed-in user.
grant execute on function public.member_company_ids() to authenticated;
grant execute on function public.supervisor_company_ids() to authenticated;

-- The same nine policies, with the same names, commands and roles.

drop policy companies_select_members on public.companies;
create policy companies_select_members
  on public.companies for select
  to authenticated
  using (id = any ((select public.member_company_ids())::uuid[]));

drop policy companies_update_supervisors on public.companies;
create policy companies_update_supervisors
  on public.companies for update
  to authenticated
  using (id = any ((select public.supervisor_company_ids())::uuid[]))
  with check (id = any ((select public.supervisor_company_ids())::uuid[]));

drop policy roster_select_members on public.roster;
create policy roster_select_members
  on public.roster for select
  to authenticated
  using (company_id = any ((select public.member_company_ids())::uuid[]));

drop policy roster_insert_supervisors on public.roster;
create policy roster_insert_supervisors
  on public.roster for insert
  to authenticated
  with check (company_id = any ((select public.supervisor_company_ids())::uuid[]));

drop policy roster_update_supervisors on public.roster;
create policy roster_update_supervisors
  on public.roster for update
  to authenticated
  using (company_id = any ((select public.supervisor_company_ids())::uuid[]))
  with check (company_id = any ((select public.supervisor_company_ids())::uuid[]));

drop policy roster_delete_supervisors on public.roster;
create policy roster_delete_supervisors
  on public.roster for delete
  to authenticated
  using (company_id = any ((select public.supervisor_company_ids())::uuid[]));

drop policy join_requests_select_supervisors on public.join_requests;
create policy join_requests_select_supervisors
  on public.join_requests for select
  to authenticated
  using (company_id = any ((select public.supervisor_company_ids())::uuid[]));

drop policy notifications_select_supervisors on public.notifications;
create policy notifications_select_supervisors
  on public.notifications for select
  to authenticated
  using (company_id = any ((select public.supervisor_company_ids())::uuid[]));

drop policy notifications_update_supervisors on public.notifications;
create policy notifications_update_supervisors
  on public.notifications for update
  to authenticated
  using (company_id = any ((select public.supervisor_company_ids())::uuid[]))
  with check (company_id = any ((select public.supervisor_company_ids())::uuid[]));

-- Start a company. As before, and an account Supabase Auth has soft-deleted or
-- banned is refused: its company's only supervisor could not sign in.
create or replace function public.create_company(
  name text,
  state text,
  timezone text,
  first_name text,
  last_name text,
  title text default null
)
returns table (company_id uuid, join_code text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  caller uuid := auth.uid();
  company_name text := public.clean_text(create_company.name);
  company_state text := pg_catalog.upper(public.clean_text(create_company.state));
  company_timezone text := coalesce(nullif(public.clean_text(create_company.timezone), ''), 'America/Los_Angeles');
  person_first text := public.clean_text(create_company.first_name);
  person_last text := public.clean_text(create_company.last_name);
  person_title text := nullif(public.clean_text(create_company.title), '');
  made public.companies;
  attempts integer := 0;
  failed_constraint text;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using errcode = '42501', message = 'Sign in with an account first.';
  end if;
  if exists (
    select 1 from auth.users u
    where u.id = caller
      and (u.deleted_at is not null or u.banned_until > pg_catalog.now())
  ) then
    raise exception using errcode = '42501', message = 'This account can no longer sign in.';
  end if;
  if coalesce(pg_catalog.char_length(company_name), 0) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'Give the company a name of 1 to 120 characters.';
  end if;
  if coalesce(company_state, '') = '' then
    raise exception using errcode = '22023', message = 'Choose a state by its two-letter postal code, or DC.';
  end if;
  if coalesce(pg_catalog.char_length(person_first), 0) not between 1 and 100
     or coalesce(pg_catalog.char_length(person_last), 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Type your first and last name, up to 100 characters each.';
  end if;
  if pg_catalog.char_length(person_title) > 100 then
    raise exception using errcode = '22023', message = 'Keep the job title to 100 characters.';
  end if;

  loop
    begin
      insert into public.companies (name, state, timezone, join_code, created_by)
      values (company_name, company_state, company_timezone, public.new_join_code(), caller)
      returning * into made;
      exit;
    exception
      -- Two companies drew the same new code at the same moment: draw again.
      when unique_violation then
        attempts := attempts + 1;
        if attempts >= 5 then
          raise;
        end if;
      when check_violation then
        get stacked diagnostics failed_constraint = constraint_name;
        if failed_constraint = 'companies_state_code' then
          raise exception using errcode = '22023', message = 'Choose a state by its two-letter postal code, or DC.';
        end if;
        raise;
    end;
  end loop;

  insert into public.roster (company_id, first_name, last_name, title, role, user_id, claimed_at)
  values (made.id, person_first, person_last, person_title, 'supervisor', caller, pg_catalog.now());

  company_id := made.id;
  join_code := made.join_code;
  return next;
end;
$$;

revoke all on function public.create_company(text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_company(text, text, text, text, text, text) to authenticated;
