-- MineMuster, step 1 hardening: a supervisor's decision about an account holds.
--
-- This migration is new; it never edits an applied one. It closes five things
-- found in review, all in the join flow:
--
--  1. Releasing a claim forgot the account. The only mark on an account was
--     its user_id on a roster row, and release_roster_claim cleared it, so the
--     wrong account the claim was taken from typed the same name and held the
--     row again before the right person could be approved onto it. Deleting a
--     removed person's row, or releasing it, likewise let them back in by
--     typing an unclaimed coworker's name. An account whose claim a supervisor
--     released, or whose row a supervisor deleted, is now held (join_holds):
--     it can no longer take a row by typing a name, and leaves a request with
--     reason 'released' instead. Approving one of its requests lifts the hold.
--     approve_join_request also takes replace_claim, which hands a claimed row
--     to the request's account in one step, so nobody with the code can take
--     the row between a release and an approval.
--  2. Taking someone back on their old row (making it active again) left the
--     'removed' request they made while they were off pending, to be approved
--     after a later removal. Making a claimed row active again now settles
--     that account's pending request, as joining does.
--  3. Joining deleted the account's pending request and, through the cascade,
--     its notification: an account could type a claimed coworker's name
--     (an 'already_claimed' request) and then an unclaimed one, and leave no
--     sign of the first. Joining now settles the request as 'withdrawn' and
--     keeps it, with its notification. A withdrawn request is decided: it can
--     be neither approved nor denied.
--  4. A denial held for nothing: the account asked again at once, or typed an
--     unclaimed coworker's name and joined. deny_join_request now takes bar:
--     a barred account's join_company answers 'denied' and records nothing,
--     until a supervisor lifts the bar (lift_join_bar). A plain denial still
--     lets the person ask again, as before.
--  5. approve_join_request and deny_join_request now take the per-account lock
--     join_company takes, before they lock the request, in the same order, so
--     a person who types a name while a supervisor approves their request is
--     told 'already_member' rather than given a duplicate-key error.
--
-- join_company also refuses a typed name that mixes alphabets (migration
-- 20261116001800 explains why), as the roster does.

-- A request's reason may be 'released', and a request may be 'withdrawn'.
alter table public.join_requests drop constraint join_requests_reason_check;
alter table public.join_requests add constraint join_requests_reason_check
  check (reason in ('not_on_roster', 'already_claimed', 'removed', 'supervisor_row', 'ambiguous', 'released'));
alter table public.join_requests drop constraint join_requests_status_check;
alter table public.join_requests add constraint join_requests_status_check
  check (status in ('pending', 'approved', 'denied', 'withdrawn'));

-- Accounts a supervisor has acted on, per company:
--   released  its claim was released or its row deleted: it joins only by a
--             supervisor approving a request
--   barred    a supervisor denied it with a bar: join_company turns it away
-- Written and read only by the functions and triggers below. It goes with the
-- company and with the account.
create table public.join_holds (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default now(),

  constraint join_holds_pkey primary key (company_id, user_id),
  constraint join_holds_kind_check check (kind in ('released', 'barred'))
);

create index join_holds_user_id_idx on public.join_holds (user_id);

alter table public.join_holds enable row level security;
revoke all on table public.join_holds from public, anon, authenticated;
revoke truncate on table public.join_holds from service_role;

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

  -- A bar already there stays a bar.
  insert into public.join_holds (company_id, user_id, kind)
  values (target.company_id, target.user_id, 'released')
  on conflict (company_id, user_id) do nothing;

  update public.roster r
  set user_id = null
  where r.id = target.id;
end;
$$;

revoke all on function public.release_roster_claim(uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_roster_claim(uuid) to authenticated;

-- Deleting a claimed row holds its account, as releasing the claim does. Not
-- when the company itself is being deleted: its rows go by cascade, with it.
create function public.roster_before_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.user_id is not null and exists (select 1 from public.companies c where c.id = old.company_id) then
    insert into public.join_holds (company_id, user_id, kind)
    values (old.company_id, old.user_id, 'released')
    on conflict (company_id, user_id) do nothing;
  end if;
  return old;
end;
$$;

revoke all on function public.roster_before_delete() from public, anon, authenticated, service_role;

create trigger roster_before_delete
  before delete on public.roster
  for each row execute function public.roster_before_delete();

-- Making a claimed row active again takes its account back: the request it
-- left while it was off is settled, as joining settles it, and any hold on it
-- in that company is lifted, as approving does. Only on a change of active, so
-- a claim being written never settles the request being approved.
create function public.roster_after_reactivate()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update public.join_requests j
  set status = 'withdrawn', decided_at = pg_catalog.now()
  where j.company_id = new.company_id and j.user_id = new.user_id and j.status = 'pending';

  delete from public.join_holds h
  where h.company_id = new.company_id and h.user_id = new.user_id;
  return null;
end;
$$;

revoke all on function public.roster_after_reactivate() from public, anon, authenticated, service_role;

create trigger roster_after_reactivate
  after update of active on public.roster
  for each row
  when (new.active and not old.active and new.user_id is not null)
  execute function public.roster_after_reactivate();

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
  held_as text;
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

  select r.* into own_row
  from public.roster r
  where r.company_id = found_company.id and r.user_id = caller and r.active;
  if found then
    return pg_catalog.jsonb_build_object('status', 'already_member', 'company_name', found_company.name, 'role', own_row.role);
  end if;

  select h.kind into held_as
  from public.join_holds h
  where h.company_id = found_company.id and h.user_id = caller;
  if held_as = 'barred' then
    return pg_catalog.jsonb_build_object('status', 'denied', 'company_name', found_company.name);
  end if;

  if exists (
    select 1 from public.roster r
    where r.company_id = found_company.id and r.user_id = caller and not r.active
  ) then
    -- The caller was taken off this roster: only a supervisor lets them back.
    why := 'removed';
  elsif held_as = 'released' then
    -- A supervisor let go of the caller's claim here: only a supervisor lets them back.
    why := 'released';
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

        -- A request this account left while it waited is settled by the join,
        -- and kept, so the supervisors still see what it typed first.
        update public.join_requests j
        set status = 'withdrawn', decided_at = pg_catalog.now()
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

-- Approve a join request. With roster_id, the requester claims that row: it
-- must be an active row of the same company, and it keeps its own role and
-- title (role and title here are for a new row only). If another account holds
-- it, the approval is refused unless replace_claim is true, which lets go of
-- that account (holding it, as release_roster_claim does) and hands the row to
-- the requester in the same step. Without roster_id, a new row is made from the
-- name on the request, with role and title. Approving lifts any hold on the
-- requester in that company. Returns the roster row's id.
drop function public.approve_join_request(uuid, uuid, text, text);

create function public.approve_join_request(
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
      on conflict (company_id, user_id) do nothing;
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

-- Deny a join request that is still pending. With bar, the account is also
-- turned away from the company from then on: join_company answers 'denied' and
-- records nothing, until a supervisor calls lift_join_bar.
drop function public.deny_join_request(uuid);

create function public.deny_join_request(request_id uuid, bar boolean default false)
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
    on conflict (company_id, user_id) do update set kind = 'barred', created_at = pg_catalog.now();
  end if;
end;
$$;

revoke all on function public.deny_join_request(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.deny_join_request(uuid, boolean) to authenticated;

-- Lift the bar on the account that made this request, in the request's
-- company. The account may then ask again. Nothing changes if there is no bar.
create function public.lift_join_bar(request_id uuid)
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

  select j.* into request
  from public.join_requests j
  where j.id = lift_join_bar.request_id
    and public.is_supervisor(j.company_id);
  if not found then
    raise exception using errcode = 'P0002', message = 'No such join request.';
  end if;

  delete from public.join_holds h
  where h.company_id = request.company_id and h.user_id = request.user_id and h.kind = 'barred';
end;
$$;

revoke all on function public.lift_join_bar(uuid) from public, anon, authenticated, service_role;
grant execute on function public.lift_join_bar(uuid) to authenticated;
