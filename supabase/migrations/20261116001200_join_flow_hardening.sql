-- MineMuster, step 1 hardening: how a name is claimed when someone joins.
--
-- This migration is new; it never edits an applied one. It closes four things
-- found in review, all in the join flow:
--
--  1. A supervisor-role row is no longer handed out by a typed name. A match
--     onto an unclaimed supervisor row leaves a request (reason 'supervisor_row')
--     for a supervisor to approve, the same way a brand-new name does. So the
--     join code alone makes nobody a supervisor, and the company cannot be
--     taken over by claiming an unclaimed supervisor row.
--  2. A person taken off the roster is not let back in by themselves. While the
--     caller holds an inactive row in the company, join_company records a
--     request (reason 'removed') instead of matching a name, so a supervisor
--     decides. This also stops a removed person landing on a coworker's row.
--  3. find_on_roster now looks for the exact match over every row of the
--     company, active or not, before the looser fallback. An exact name on an
--     inactive row still shadows the looser matches, so typing a removed
--     person's name never stands in for a different, still-active person. Only
--     active rows are ever returned or claimed, as before.
--  4. Names may no longer carry control or invisible format characters
--     (zero-width spaces, bidi overrides, soft hyphens, ...), so a request
--     cannot pose as a claimed coworker's name with a hidden character in it.
--
-- Two smaller fixes ride along:
--  * When a name is written the same way for several people so that no typing
--    can single one out, join_company leaves an 'ambiguous' request for a
--    supervisor rather than recording nothing.
--  * Joining settles the account's own pending request for that company, so a
--    stale request cannot be approved later to re-admit someone.
--
-- A Supabase anonymous sign-in (authenticated role, a real sub, is_anonymous
-- true in the JWT) is refused by join_company and create_company, so throwaway
-- accounts cannot claim rows or flood requests when anonymous sign-ins are on.

-- New reasons a join waits for a supervisor.
alter table public.join_requests drop constraint join_requests_reason_check;
alter table public.join_requests add constraint join_requests_reason_check
  check (reason in ('not_on_roster', 'already_claimed', 'removed', 'supervisor_row', 'ambiguous'));

-- Whether a value holds a control or invisible format character that survives
-- clean_text: C0/C1 controls, soft hyphen, the Arabic letter mark, the Mongolian
-- vowel separator, the zero-width and bidi range, the word joiner and invisible
-- operators, and the interlinear annotation marks. Kept ASCII with regex
-- escapes, like the other helpers. Private: the security definer trigger and
-- functions below call it.
create function public.has_hidden_characters(value text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    value ~ '[\x0001-\x001f\x007f-\x009f\x00ad\x061c\x180e\x200b-\x200f\x202a-\x202e\x2060-\x206f\xfff9-\xfffb]',
    false
  );
$$;

revoke all on function public.has_hidden_characters(text) from public, anon, authenticated, service_role;

-- Roster rows: as before, plus a name cannot hold a hidden character.
create or replace function public.roster_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.first_name := public.clean_text(new.first_name);
  new.last_name := public.clean_text(new.last_name);
  new.title := nullif(public.clean_text(new.title), '');

  if public.has_hidden_characters(new.first_name) or public.has_hidden_characters(new.last_name)
     or public.has_hidden_characters(coalesce(new.title, '')) then
    raise exception using
      errcode = '22023',
      message = 'A name cannot hold control or invisible characters.';
  end if;

  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id then
      raise exception using
        errcode = '42501',
        message = 'A roster row cannot move to another company.';
    end if;
    if old.user_id is not null and new.user_id is not null and new.user_id <> old.user_id then
      raise exception using
        errcode = '55000',
        message = 'That roster row is already claimed by another account.',
        hint = 'A supervisor can release it first.';
    end if;
  end if;

  if new.user_id is null then
    new.claimed_at := null;
  elsif new.claimed_at is null then
    new.claimed_at := pg_catalog.now();
  end if;

  return new;
end;
$$;

revoke all on function public.roster_before_write() from public, anon, authenticated, service_role;

-- Companies: as before, plus the company name cannot hold a hidden character.
create or replace function public.companies_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.name := public.clean_text(new.name);
  new.state := pg_catalog.upper(public.clean_text(new.state));
  new.timezone := public.clean_text(new.timezone);
  new.logo_path := nullif(public.clean_text(new.logo_path), '');

  if public.has_hidden_characters(new.name) then
    raise exception using
      errcode = '22023',
      message = 'A name cannot hold control or invisible characters.';
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.created_at is distinct from old.created_at
       or (new.created_by is distinct from old.created_by and new.created_by is not null) then
      raise exception using
        errcode = '42501',
        message = 'A company''s id, creator and creation time cannot be changed.';
    end if;
    new.updated_at := pg_catalog.now();
  end if;

  if (tg_op = 'INSERT' or new.timezone is distinct from old.timezone)
     and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception using
      errcode = '22023',
      message = 'That is not a time zone the database knows.',
      hint = 'Use an IANA name such as America/Los_Angeles.';
  end if;

  return new;
end;
$$;

revoke all on function public.companies_before_write() from public, anon, authenticated, service_role;

-- The active rows a typed name is. The exact match is looked for over every
-- row of the company, active or not; only its active rows are returned. So an
-- exact name on an inactive row shadows the looser fallback (nobody stands in
-- for a removed person), while an inactive row is never returned or claimed.
create or replace function public.find_on_roster(company_id uuid, first_name text, last_name text)
returns setof public.roster
language sql
stable
set search_path = ''
as $$
  with company_rows as (
    select r.*
    from public.roster r
    where r.company_id = find_on_roster.company_id
  ),
  exact as (
    select a.*
    from company_rows a
    where public.same_name(a.first_name, a.last_name, find_on_roster.first_name, find_on_roster.last_name)
  )
  select * from exact where exact.active
  union all
  select a.*
  from company_rows a
  where a.active
    and not exists (select 1 from exact)
    and public.name_fits(a.first_name, a.last_name, find_on_roster.first_name, find_on_roster.last_name);
$$;

revoke all on function public.find_on_roster(uuid, text, text) from public, anon, authenticated, service_role;

-- Start a company. As before, and a Supabase anonymous sign-in is refused.
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
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using errcode = '42501', message = 'Sign in with an account first.';
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

-- Join a company with its join code and the name the person goes by.
--
-- Returns {status, company_name?, role?, reason?}:
--   no_company      no company has that code
--   already_member  the caller already holds an active row there (with role)
--   joined          the name is one active unclaimed employee row: it is now
--                   the caller's (with role), and the supervisors are told
--   ambiguous       the name fits several rows and none exactly: nothing is
--                   recorded, and the app asks for the name as it is on the roster
--   pending         a request is waiting for a supervisor, with reason:
--                     not_on_roster  no row fits the name
--                     already_claimed the one row it fits is another account's
--                     supervisor_row  the one row it fits is a supervisor row
--                     removed         the caller was taken off this roster
--                     ambiguous       the name is written the same for several
--                                     people, so no typing can single one out
--
-- A supervisor-role row is never claimed by a typed name; a request is left so
-- a supervisor approves it. A caller who was taken off the roster leaves a
-- request too, so a supervisor lets them back. A Supabase anonymous sign-in is
-- refused. Claiming locks the row and takes it only while it is still unclaimed.
create or replace function public.join_company(code text, first_name text, last_name text)
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
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using errcode = '42501', message = 'Sign in with an account first.';
  end if;

  select c.* into found_company
  from public.companies c
  where c.join_code = public.normalize_join_code(join_company.code);
  if not found then
    return pg_catalog.jsonb_build_object('status', 'no_company');
  end if;

  if coalesce(pg_catalog.char_length(typed_first), 0) not between 1 and 100
     or coalesce(pg_catalog.char_length(typed_last), 0) not between 1 and 100
     or public.has_hidden_characters(typed_first)
     or public.has_hidden_characters(typed_last) then
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

  if exists (
    select 1 from public.roster r
    where r.company_id = found_company.id and r.user_id = caller and not r.active
  ) then
    -- The caller was taken off this roster: only a supervisor lets them back.
    why := 'removed';
  else
    select coalesce(pg_catalog.array_agg(f.id), '{}') into match_ids
    from public.find_on_roster(found_company.id, typed_first, typed_last) f;

    if pg_catalog.cardinality(match_ids) > 1 then
      if exists (
        select 1 from public.roster r
        where r.id = any (match_ids)
          and not public.same_name(r.first_name, r.last_name, typed_first, typed_last)
      ) then
        -- Some of the rows are only a loose fit: typing the whole name settles it.
        return pg_catalog.jsonb_build_object('status', 'ambiguous', 'company_name', found_company.name);
      end if;
      -- Written the same way for several people: no typing can single one out.
      why := 'ambiguous';
    elsif pg_catalog.cardinality(match_ids) = 1 then
      select r.* into claimed
      from public.roster r
      where r.id = match_ids[1] and r.user_id is null and r.active
      for update;
      if found and claimed.role = 'supervisor' then
        -- A supervisor row is never handed out by a typed name.
        why := 'supervisor_row';
      elsif found then
        update public.roster r
        set user_id = caller, claimed_at = pg_catalog.now()
        where r.id = claimed.id;

        -- A request this account left while it waited is settled by the join.
        delete from public.join_requests j
        where j.company_id = found_company.id and j.user_id = caller and j.status = 'pending';

        insert into public.notifications (company_id, kind, roster_id)
        values (found_company.id, 'joined', claimed.id);

        return pg_catalog.jsonb_build_object('status', 'joined', 'company_name', found_company.name, 'role', claimed.role);
      else
        why := 'already_claimed';
      end if;
    else
      why := 'not_on_roster';
    end if;
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

revoke all on function public.join_company(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.join_company(text, text, text) to authenticated;
