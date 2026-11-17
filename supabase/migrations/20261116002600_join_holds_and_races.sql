-- MineMuster, step 1 hardening: what a supervisor decided about an account
-- holds, and join_company reads the caller and the row it claims whole.
--
-- This migration is new; it never edits an applied one. It closes six things
-- found in review, all in the join flow:
--
--  1. Lifting a bar forgot a release. join_holds kept one row per account and
--     company, 'released' or 'barred'; a bar overwrote a release, and lifting
--     the bar deleted the row, so the account was neither barred nor released
--     and took rows by typing a name again: an impostor whose claim was
--     released, then barred and later let ask again, typed the coworker's name
--     and had the row back before the right person was approved. The two are
--     now kept apart, one row each (the key is company, account and kind):
--     lifting a bar deletes the bar only, and a released account stays held
--     until a supervisor approves one of its requests, as the README says.
--  2. Releasing or deleting a removed person's old row while they typed a name
--     let them claim a coworker's row. join_company read the caller's active
--     row, its holds and its inactive row in three statements, each with its
--     own snapshot, and release_roster_claim and a DELETE do not take the
--     per-account lock: a release committing between the second and the third
--     was seen by neither, and the name matching ran.
--  3. Taking a removed person back while they typed left a fresh pending
--     request on an active member, the same way (a reactivation committing
--     between the first read and the third), which a supervisor could approve
--     after a later removal: what roster_after_reactivate is there to stop.
--     For both, join_company now locks the caller's own row in the company
--     (FOR NO KEY UPDATE) before it reads anything about the caller. A release,
--     a delete, replace_claim and a reactivation all hold that row's lock until
--     they commit, so join_company waits for them and its later statements see
--     their whole change; and one that starts later waits for join_company. The
--     request it leaves is also written only while the caller holds no active
--     row there, in the same statement.
--  4. A row renamed while its old name was typed was claimed under its new
--     name. Locking the matched row re-checks, after waiting, only the claim
--     and the active flag, not the name. join_company now matches the name
--     again once the row is locked, and if the roster changed meanwhile it
--     matches afresh.
--  5. The inactive-row shadow only covered a name typed character for
--     character. find_on_roster looks for the exact name over every row, active
--     or not, so that typing a removed person's name never stands in for a
--     different, still-active person; but the looser fallback, which reads full
--     stops, commas and quote marks as spaces and allows a suffix, then looked
--     at active rows only. "Riley J." "Quinn" with an inactive Riley J Quinn and
--     an active Riley J Quinn Jr claimed the son's row. Now the fallback runs
--     only when no inactive row fits the typed name either.
--  6. join_company refuses a typed name that looks like a name on the roster
--     without being it or fitting it (poses_as_roster_name, migration
--     20261116002500), and an account Supabase Auth has soft-deleted or banned
--     (migration 20261116002300 explains why).

-- 1. Holds: an account may be released and barred in a company at once.
alter table public.join_holds drop constraint join_holds_pkey;
alter table public.join_holds add constraint join_holds_pkey primary key (company_id, user_id, kind);

-- Let go of the account on a roster row, so the right person can claim it, and
-- hold that account. Nothing changes for a row nobody has claimed. The
-- last-supervisor guard refuses releasing the last supervisor who can sign in.
create or replace function public.release_roster_claim(roster_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  caller uuid := auth.uid();
  target public.roster;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  select r.* into target
  from public.roster r
  where r.id = release_roster_claim.roster_id
    and public.is_supervisor(r.company_id)
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'No such roster row.';
  end if;
  if target.user_id is null then
    return;
  end if;

  -- Kept beside a bar, if the account has one.
  insert into public.join_holds (company_id, user_id, kind)
  values (target.company_id, target.user_id, 'released')
  on conflict (company_id, user_id, kind) do nothing;

  update public.roster r
  set user_id = null
  where r.id = target.id;
end;
$$;

revoke all on function public.release_roster_claim(uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_roster_claim(uuid) to authenticated;

-- Deleting a claimed row holds its account, as releasing the claim does. Not
-- when the company itself is being deleted: its rows go by cascade, with it.
create or replace function public.roster_before_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.user_id is not null and exists (select 1 from public.companies c where c.id = old.company_id) then
    insert into public.join_holds (company_id, user_id, kind)
    values (old.company_id, old.user_id, 'released')
    on conflict (company_id, user_id, kind) do nothing;
  end if;
  return old;
end;
$$;

revoke all on function public.roster_before_delete() from public, anon, authenticated, service_role;

-- Approve a join request, as before. A claimed row handed over with
-- replace_claim holds the account it is taken from, beside any bar it has.
create or replace function public.approve_join_request(
  request_id uuid,
  roster_id uuid default null,
  role text default 'employee',
  title text default null,
  replace_claim boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  caller uuid := auth.uid();
  new_role text := pg_catalog.lower(public.clean_text(approve_join_request.role));
  new_title text := nullif(public.clean_text(approve_join_request.title), '');
  request public.join_requests;
  target public.roster;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  -- Found first without a lock, so the per-account lock join_company takes is
  -- taken before the request is locked, in the same order as join_company.
  select j.* into request
  from public.join_requests j
  where j.id = approve_join_request.request_id
    and public.is_supervisor(j.company_id);
  if not found then
    raise exception using errcode = 'P0002', message = 'No such join request.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('join_company ' || request.user_id::text || ' ' || request.company_id::text, 0)
  );
  select j.* into request
  from public.join_requests j
  where j.id = request.id
    and public.is_supervisor(j.company_id)
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'No such join request.';
  end if;

  if request.status <> 'pending' then
    raise exception using errcode = '55000', message = 'That join request has already been decided.';
  end if;
  if new_role is null or new_role not in ('employee', 'supervisor') then
    raise exception using errcode = '22023', message = 'A role is employee or supervisor.';
  end if;
  if pg_catalog.char_length(new_title) > 100 then
    raise exception using errcode = '22023', message = 'Keep the job title to 100 characters.';
  end if;
  if exists (
    select 1 from public.roster r
    where r.company_id = request.company_id and r.user_id = request.user_id and r.active
  ) then
    raise exception using
      errcode = '55000',
      message = 'That person is already on the roster.',
      hint = 'Deny the request to close it.';
  end if;

  if approve_join_request.roster_id is not null then
    select r.* into target
    from public.roster r
    where r.id = approve_join_request.roster_id
      and r.company_id = request.company_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'No such roster row.';
    end if;
    if not target.active then
      raise exception using errcode = '55000', message = 'That roster row is not active.';
    end if;
    if target.user_id is not null then
      if not coalesce(approve_join_request.replace_claim, false) then
        raise exception using
          errcode = '55000',
          message = 'That roster row is already claimed.',
          hint = 'Approve with replace_claim to hand it to this person in one step, or release it first.';
      end if;
      -- Hand the row over in this one step: let go of the account on it, and
      -- hold that account. The last-supervisor guard still has its say.
      insert into public.join_holds (company_id, user_id, kind)
      values (target.company_id, target.user_id, 'released')
      on conflict (company_id, user_id, kind) do nothing;
      update public.roster r
      set user_id = null
      where r.id = target.id;
    end if;
  end if;

  -- An account holds one row per company: a row the requester held before and
  -- that was taken off the roster lets go of the account.
  update public.roster r
  set user_id = null
  where r.company_id = request.company_id and r.user_id = request.user_id and not r.active;

  if approve_join_request.roster_id is not null then
    update public.roster r
    set user_id = request.user_id, claimed_at = pg_catalog.now()
    where r.id = target.id
    returning r.* into target;
  else
    insert into public.roster (company_id, first_name, last_name, title, role, user_id, claimed_at)
    values (request.company_id, request.first_name, request.last_name, new_title, new_role, request.user_id, pg_catalog.now())
    returning * into target;
  end if;

  -- Every hold on the requester in that company goes: a release and a bar.
  delete from public.join_holds h
  where h.company_id = request.company_id and h.user_id = request.user_id;

  update public.join_requests j
  set status = 'approved', roster_id = target.id, decided_by = caller, decided_at = pg_catalog.now()
  where j.id = request.id;

  return target.id;
end;
$$;

revoke all on function public.approve_join_request(uuid, uuid, text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.approve_join_request(uuid, uuid, text, text, boolean) to authenticated;

-- Deny a join request that is still pending, as before. A bar is kept beside a
-- release the account already has, so lifting the bar leaves the release.
create or replace function public.deny_join_request(request_id uuid, bar boolean default false)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  caller uuid := auth.uid();
  request public.join_requests;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  -- The per-account lock first, as in approve_join_request, so a bar cannot
  -- race a join by the same account.
  select j.* into request
  from public.join_requests j
  where j.id = deny_join_request.request_id
    and public.is_supervisor(j.company_id);
  if not found then
    raise exception using errcode = 'P0002', message = 'No such join request.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('join_company ' || request.user_id::text || ' ' || request.company_id::text, 0)
  );
  select j.* into request
  from public.join_requests j
  where j.id = request.id
    and public.is_supervisor(j.company_id)
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'No such join request.';
  end if;
  if request.status <> 'pending' then
    raise exception using errcode = '55000', message = 'That join request has already been decided.';
  end if;

  update public.join_requests j
  set status = 'denied', decided_by = caller, decided_at = pg_catalog.now()
  where j.id = request.id;

  if coalesce(deny_join_request.bar, false) then
    insert into public.join_holds (company_id, user_id, kind)
    values (request.company_id, request.user_id, 'barred')
    on conflict (company_id, user_id, kind) do update set created_at = pg_catalog.now();
  end if;
end;
$$;

revoke all on function public.deny_join_request(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.deny_join_request(uuid, boolean) to authenticated;

-- 5. The active rows a typed name is. The exact match is looked for over every
-- row of the company, active or not; only its active rows are returned. The
-- looser fallback runs only when no row is the name exactly and no inactive row
-- fits it either, so neither typing a removed person's name exactly nor typing
-- it the looser way stands in for a different, still-active person. An inactive
-- row is never returned or claimed.
create or replace function public.find_on_roster(company_id uuid, first_name text, last_name text)
returns setof public.roster
language sql
stable
set search_path = pg_catalog, pg_temp
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
    and not exists (
      select 1
      from company_rows i
      where not i.active
        and public.name_fits(i.first_name, i.last_name, find_on_roster.first_name, find_on_roster.last_name)
    )
    and public.name_fits(a.first_name, a.last_name, find_on_roster.first_name, find_on_roster.last_name);
$$;

revoke all on function public.find_on_roster(uuid, text, text) from public, anon, authenticated, service_role;

-- Join a company with its join code and the name the person goes by.
--
-- Returns {status, company_name?, role?, reason?}:
--   no_company      no company has that code
--   already_member  the caller already holds an active row there (with role)
--   denied          a supervisor denied this account with a bar: nothing is
--                   recorded, until a supervisor lifts the bar
--   joined          the name is one active unclaimed employee row: it is now
--                   the caller's (with role), and the supervisors are told
--   ambiguous       the name fits several rows and none exactly: nothing is
--                   recorded, and the app asks for the name as it is on the roster
--   pending         a request is waiting for a supervisor, with reason:
--                     not_on_roster   no row fits the name
--                     already_claimed the one row it fits is another account's
--                     supervisor_row  the one row it fits is a supervisor row
--                     removed         the caller was taken off this roster
--                     released        a supervisor released the caller's claim
--                                     here, or deleted the caller's row
--                     ambiguous       the name is written the same for several
--                                     people, so no typing can single one out
--
-- Refuses (22023) a typed name that only looks like a name on the roster, and
-- (42501) an anonymous sign-in or an account that can no longer sign in.
-- Joining settles the caller's own pending request there as 'withdrawn'; it is
-- kept, with its notification, as a record of what the account typed first.
create or replace function public.join_company(code text, first_name text, last_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  caller uuid := auth.uid();
  typed_first text := public.clean_text(join_company.first_name);
  typed_last text := public.clean_text(join_company.last_name);
  found_company public.companies;
  own_row public.roster;
  holds_own_row boolean;
  barred boolean;
  released boolean;
  match_ids uuid[];
  now_ids uuid[];
  claimed public.roster;
  locked boolean;
  why text;
  waiting public.join_requests;
  member_role text;
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
  if public.mixes_alphabets(typed_first || ' ' || typed_last) then
    raise exception using
      errcode = '22023',
      message = 'A name cannot mix letters of different alphabets, such as Latin and Cyrillic.',
      hint = 'Type the whole name in one alphabet.';
  end if;

  -- Calls by one account to one company take turns, with each other and with a
  -- supervisor deciding that account's request.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('join_company ' || caller::text || ' ' || found_company.id::text, 0)
  );

  -- The caller's own row here, locked before anything else about the caller is
  -- read. A supervisor's change to it (releasing it, deleting it, handing it to
  -- someone else, taking the person back) holds that row's lock until it
  -- commits: this waits for it, and the statements below, each with a new
  -- snapshot, see the whole change. One that starts later waits for this call.
  select r.* into own_row
  from public.roster r
  where r.company_id = found_company.id and r.user_id = caller
  for no key update;
  holds_own_row := found;

  if holds_own_row and own_row.active then
    return pg_catalog.jsonb_build_object('status', 'already_member', 'company_name', found_company.name, 'role', own_row.role);
  end if;

  select coalesce(pg_catalog.bool_or(h.kind = 'barred'), false), coalesce(pg_catalog.bool_or(h.kind = 'released'), false)
  into barred, released
  from public.join_holds h
  where h.company_id = found_company.id and h.user_id = caller;
  if barred then
    return pg_catalog.jsonb_build_object('status', 'denied', 'company_name', found_company.name);
  end if;

  if holds_own_row then
    -- The caller was taken off this roster: only a supervisor lets them back.
    why := 'removed';
  elsif released then
    -- A supervisor let go of the caller's claim here: only a supervisor lets them back.
    why := 'released';
  else
    for attempt in 1 .. 3 loop
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
        exit;
      elsif pg_catalog.cardinality(match_ids) = 0 then
        why := 'not_on_roster';
        exit;
      end if;

      select r.* into claimed
      from public.roster r
      where r.id = match_ids[1] and r.user_id is null and r.active
      for update;
      locked := found;

      -- Waiting for the row's lock re-checks its claim and its active flag, not
      -- its name. Now that nobody can change the row, match the name again.
      select coalesce(pg_catalog.array_agg(f.id), '{}') into now_ids
      from public.find_on_roster(found_company.id, typed_first, typed_last) f;

      if locked and now_ids = array[claimed.id] then
        if claimed.role = 'supervisor' then
          -- A supervisor row is never handed out by a typed name.
          why := 'supervisor_row';
          exit;
        end if;

        update public.roster r
        set user_id = caller, claimed_at = pg_catalog.now()
        where r.id = claimed.id;

        -- A request this account left while it waited is settled by the join,
        -- and kept, so the supervisors still see what it typed first.
        update public.join_requests j
        set status = 'withdrawn', decided_at = pg_catalog.now()
        where j.company_id = found_company.id and j.user_id = caller and j.status = 'pending';

        insert into public.notifications (company_id, kind, roster_id)
        values (found_company.id, 'joined', claimed.id);

        return pg_catalog.jsonb_build_object('status', 'joined', 'company_name', found_company.name, 'role', claimed.role);
      elsif not locked and match_ids[1] = any (now_ids) then
        -- Still the name typed, and another account holds it.
        why := 'already_claimed';
        exit;
      end if;
      -- The roster changed while this waited for the row: match afresh.
    end loop;
    why := coalesce(why, 'not_on_roster');
  end if;

  select j.* into waiting
  from public.join_requests j
  where j.company_id = found_company.id and j.user_id = caller and j.status = 'pending';
  if not found then
    if public.poses_as_roster_name(found_company.id, typed_first, typed_last) then
      raise exception using
        errcode = '22023',
        message = 'Type your name the way it is written on the roster.',
        hint = 'That name looks like a name on the roster but is written with other characters.';
    end if;

    -- Written only while the caller holds no active row here.
    insert into public.join_requests (company_id, user_id, first_name, last_name, reason)
    select found_company.id, caller, typed_first, typed_last, why
    where not exists (
      select 1 from public.roster r
      where r.company_id = found_company.id and r.user_id = caller and r.active
    )
    returning * into waiting;
    if not found then
      select r.role into member_role
      from public.roster r
      where r.company_id = found_company.id and r.user_id = caller and r.active;
      return pg_catalog.jsonb_build_object('status', 'already_member', 'company_name', found_company.name, 'role', member_role);
    end if;

    insert into public.notifications (company_id, kind, request_id)
    values (found_company.id, 'join_request', waiting.id);
  end if;

  return pg_catalog.jsonb_build_object('status', 'pending', 'company_name', found_company.name, 'reason', waiting.reason);
end;
$$;

revoke all on function public.join_company(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.join_company(text, text, text) to authenticated;
