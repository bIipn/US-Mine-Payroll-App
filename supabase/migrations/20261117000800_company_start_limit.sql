-- MineMuster: how many companies one account may start.
--
-- This migration is new; it never edits an applied one. create_company had no
-- limit for an account: the security scan's one account started 381 companies
-- in about nine minutes. Each company an account is in adds to what every one
-- of its requests costs (each row level security policy works out the
-- account's companies), and every company is a row, a roster and a join code
-- kept for good. So one account now starts at most
--
--   * 3 companies in any 24 hours, and
--   * 20 companies in all.
--
-- They are counted from what the server already keeps: companies.created_by,
-- the account that started each company (set by create_company, never written
-- through the API, and changed by nothing but the account's own deletion), and
-- companies.created_at, with companies_created_by_idx to find them. A company
-- the owner makes in the SQL editor for an account counts too. Joining a
-- company counts toward neither.
--
-- Past either, it raises PT429, which PostgREST answers with HTTP 429, as the
-- contact form's limit does (20261117000500), with a one-line ASCII message
-- that says what to do and a hint a client can go by:
--
--   too_many_in_all  This account has started 20 companies, the most one
--                    account may. Write to MineMuster to start more.
--   too_many_today   This account has started 3 companies in the last 24
--                    hours. Try again in a day.
--
-- The limit in all is checked first: waiting a day does not lift it. A call
-- refused for its name, the person's name or title, or an account that cannot
-- sign in is refused before the count and counts toward nothing, as before. A
-- state code or time zone the database does not know is caught by the insert,
-- after the count, so an account already at a limit is told about the limit
-- instead. Either way nothing is written.
--
-- Calls from one account take turns from the count to the commit (an advisory
-- lock on the account's id), so two at once cannot both slip under a limit:
-- at READ COMMITTED, as PostgREST runs every call, the second waits for the
-- first and then counts its company (races.db.mjs). Calls from different
-- accounts do not wait for each other. At REPEATABLE READ or SERIALIZABLE,
-- which no API call runs at, a second call would count from the snapshot it
-- took before it waited; the lock does not cover that, as it does not for the
-- contact form's limit.
--
-- Everything else about create_company is as in
-- 20261116002300_membership_needs_a_sign_in.sql: its arguments and answer,
-- every other refusal, security definer, search_path pg_catalog, pg_temp, and
-- the grant to authenticated only.

-- As in 20261116002300_membership_needs_a_sign_in.sql, with the limit after
-- every check of what was typed and before anything is written.
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
  started_in_all bigint;
  started_today bigint;
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

  -- One call at a time for this account from here to the commit, so the counts
  -- below see every company it started before this one.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('create_company ' || caller::text, 0));
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where c.created_at > pg_catalog.now() - interval '24 hours')
  into started_in_all, started_today
  from public.companies c
  where c.created_by = caller;
  if started_in_all >= 20 then
    raise exception using
      errcode = 'PT429',
      message = 'This account has started 20 companies, the most one account may. Write to MineMuster to start more.',
      hint = 'too_many_in_all';
  end if;
  if started_today >= 3 then
    raise exception using
      errcode = 'PT429',
      message = 'This account has started 3 companies in the last 24 hours. Try again in a day.',
      hint = 'too_many_today';
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
