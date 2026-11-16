-- MineMuster, step 1: finding, starting and joining a company.
--
-- Called by the app through the API (supabase.rpc). Each is security definer
-- with an empty search_path and fully qualified names, and refuses when
-- nobody is signed in (auth.uid() is null), except company_by_code, which a
-- person may use before they have an account.
--
-- Errors carry a SQLSTATE the app can act on:
--   42501  not signed in
--   22023  something typed is missing or not allowed

-- The company a join code is for: its name and state, and nothing else. No
-- row when no company has that code. The code is read the way join_company
-- reads it, so the app can show "Join <name>?" before asking for a name.
create function public.company_by_code(code text)
returns table (name text, state text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.name, c.state
  from public.companies c
  where c.join_code = public.normalize_join_code(company_by_code.code);
$$;

-- Start a company. The caller goes on its roster as a supervisor, with their
-- account on the row, and gets back the company's id and its join code.
create function public.create_company(
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
set search_path = ''
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

-- Join a company with its join code and the name the person goes by.
--
-- Returns {status, company_name?, role?, reason?}:
--   no_company      no company has that code
--   already_member  the caller already holds an active row there (with role)
--   joined          the name is one active unclaimed row: it is now the
--                   caller's (with role), and the supervisors are told
--   ambiguous       the name fits several rows and none exactly: nothing is
--                   recorded, and the app asks for the name as it is on the roster
--   pending         a join request is waiting for a supervisor, with reason
--                   not_on_roster (no row fits) or already_claimed (the row
--                   it fits belongs to another account). A second try while
--                   one is pending returns that one and adds nothing.
--
-- Claiming locks the row and takes it only if it is still unclaimed, so two
-- people can never claim the same row; the one who comes second is left a
-- request with reason already_claimed. Calls by the same account to the same
-- company take turns.
create function public.join_company(code text, first_name text, last_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  caller uuid := auth.uid();
  typed_first text := public.clean_text(join_company.first_name);
  typed_last text := public.clean_text(join_company.last_name);
  found_company public.companies;
  own_row public.roster;
  match_ids uuid[];
  claimed public.roster;
  why text;
  waiting public.join_requests;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  select c.* into found_company
  from public.companies c
  where c.join_code = public.normalize_join_code(join_company.code);
  if not found then
    return pg_catalog.jsonb_build_object('status', 'no_company');
  end if;

  if coalesce(pg_catalog.char_length(typed_first), 0) not between 1 and 100
     or coalesce(pg_catalog.char_length(typed_last), 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Type your first and last name, up to 100 characters each.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('join_company ' || caller::text || ' ' || found_company.id::text, 0)
  );

  select r.* into own_row
  from public.roster r
  where r.company_id = found_company.id and r.user_id = caller and r.active;
  if found then
    return pg_catalog.jsonb_build_object('status', 'already_member', 'company_name', found_company.name, 'role', own_row.role);
  end if;

  select coalesce(pg_catalog.array_agg(f.id), '{}') into match_ids
  from public.find_on_roster(found_company.id, typed_first, typed_last) f;

  if pg_catalog.cardinality(match_ids) > 1 then
    return pg_catalog.jsonb_build_object('status', 'ambiguous', 'company_name', found_company.name);
  end if;

  if pg_catalog.cardinality(match_ids) = 1 then
    select r.* into claimed
    from public.roster r
    where r.id = match_ids[1] and r.user_id is null and r.active
    for update;
    if found then
      -- An account holds one row per company: a row it held before and that
      -- was taken off the roster lets go of the account.
      update public.roster r
      set user_id = null
      where r.company_id = found_company.id and r.user_id = caller and not r.active;

      update public.roster r
      set user_id = caller, claimed_at = pg_catalog.now()
      where r.id = claimed.id;

      insert into public.notifications (company_id, kind, roster_id)
      values (found_company.id, 'joined', claimed.id);

      return pg_catalog.jsonb_build_object('status', 'joined', 'company_name', found_company.name, 'role', claimed.role);
    end if;
    why := 'already_claimed';
  else
    why := 'not_on_roster';
  end if;

  select j.* into waiting
  from public.join_requests j
  where j.company_id = found_company.id and j.user_id = caller and j.status = 'pending';
  if not found then
    insert into public.join_requests (company_id, user_id, first_name, last_name, reason)
    values (found_company.id, caller, typed_first, typed_last, why)
    returning * into waiting;

    insert into public.notifications (company_id, kind, request_id)
    values (found_company.id, 'join_request', waiting.id);
  end if;

  return pg_catalog.jsonb_build_object('status', 'pending', 'company_name', found_company.name, 'reason', waiting.reason);
end;
$$;

revoke all on function public.company_by_code(text) from public, anon, authenticated, service_role;
revoke all on function public.create_company(text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.join_company(text, text, text) from public, anon, authenticated, service_role;

grant execute on function public.company_by_code(text) to anon, authenticated;
grant execute on function public.create_company(text, text, text, text, text, text) to authenticated;
grant execute on function public.join_company(text, text, text) to authenticated;
