-- MineMuster, step 1: what a supervisor does with join requests, the join
-- code and claims.
--
-- Each works only for a supervisor of the company the request, row or company
-- belongs to. Anything else (a company the caller does not supervise, a
-- request or row of another company, or an id that does not exist) gets the
-- same "not found" error, so nothing about another company leaks out.
--
-- Errors carry a SQLSTATE the app can act on:
--   42501  not signed in
--   P0002  not found (or not the caller's to act on)
--   55000  not in a state to do that (already decided, already claimed, ...)
--   22023  something typed is missing or not allowed
--   23514  it would leave the company without an active supervisor

-- Approve a join request. With roster_id, the requester claims that row: it
-- must be an active, unclaimed row of the same company, and it keeps its own
-- role and title (role and title here are for a new row only). Without it, a
-- new row is made from the name on the request, with role and title, and the
-- requester claims it. Returns the roster row's id.
create function public.approve_join_request(
  request_id uuid,
  roster_id uuid default null,
  role text default 'employee',
  title text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
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

  select j.* into request
  from public.join_requests j
  where j.id = approve_join_request.request_id
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
      raise exception using
        errcode = '55000',
        message = 'That roster row is already claimed.',
        hint = 'Release it first if it belongs to this person.';
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

  update public.join_requests j
  set status = 'approved', roster_id = target.id, decided_by = caller, decided_at = pg_catalog.now()
  where j.id = request.id;

  return target.id;
end;
$$;

-- Deny a join request that is still pending.
create function public.deny_join_request(request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
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
  where j.id = deny_join_request.request_id
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
end;
$$;

-- Give the company a new join code and return it. The old code stops working
-- at once.
create function public.rotate_join_code(company_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  caller uuid := auth.uid();
  fresh text;
  attempts integer := 0;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;
  if not public.is_supervisor(rotate_join_code.company_id) then
    raise exception using errcode = 'P0002', message = 'No such company.';
  end if;

  loop
    begin
      update public.companies c
      set join_code = public.new_join_code()
      where c.id = rotate_join_code.company_id
      returning c.join_code into fresh;
      exit;
    exception
      -- Two companies drew the same new code at the same moment: draw again.
      when unique_violation then
        attempts := attempts + 1;
        if attempts >= 5 then
          raise;
        end if;
    end;
  end loop;

  return fresh;
end;
$$;

-- Let go of the account on a roster row, so the right person can claim it.
-- Nothing changes for a row nobody has claimed. The last active supervisor
-- with an account cannot be released.
create function public.release_roster_claim(roster_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
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
  if target.role = 'supervisor' and target.active and not exists (
    select 1 from public.roster r
    where r.company_id = target.company_id
      and r.id <> target.id
      and r.role = 'supervisor'
      and r.active
      and r.user_id is not null
  ) then
    raise exception using
      errcode = '23514',
      message = 'A company must keep at least one active supervisor with an account.',
      hint = 'Make someone else a supervisor first.';
  end if;

  update public.roster r
  set user_id = null
  where r.id = target.id;
end;
$$;

revoke all on function public.approve_join_request(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.deny_join_request(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rotate_join_code(uuid) from public, anon, authenticated, service_role;
revoke all on function public.release_roster_claim(uuid) from public, anon, authenticated, service_role;

grant execute on function public.approve_join_request(uuid, uuid, text, text) to authenticated;
grant execute on function public.deny_join_request(uuid) to authenticated;
grant execute on function public.rotate_join_code(uuid) to authenticated;
grant execute on function public.release_roster_claim(uuid) to authenticated;
