-- MineMuster: a refusal is answered 404 or 409, not 500.
--
-- This migration is new; it never edits an applied one. PostgREST answers a
-- function's error with an HTTP status chosen by its SQLSTATE, and it answers
-- P0002 and 55000, like every code of the classes P0 and 55, with 500 Internal
-- Server Error. The functions below raise those two on purpose, to say no:
--
--   P0002  not found, or not the caller's to act on (the two look the same on
--          purpose, so a refusal never tells a real id from a made-up one)
--   55000  not in a state to do that: a request already decided, a row already
--          claimed or taken off, a person already on the roster
--
-- A 500 says the server failed. A security scan reported each as an error page
-- (StackHawk, Application Error Disclosure), and a client cannot tell them from
-- a real failure by the status. PostgREST answers a code PTnnn with HTTP nnn,
-- keeping the message and the hint in the body, as PT429 already is for the
-- contact form. So each refusal is now:
--
--   PT404  for every P0002 (ten raises)      HTTP 404 Not Found
--   PT409  for every 55000 (six raises)      HTTP 409 Conflict
--
-- 404 and not 403 for "not found, or not yours": a 403 would answer a real id
-- of another company differently from a made-up one. The message, the hint and
-- everything else about each function stay as they were: each is re-created
-- from its latest definition (named above it), with security definer, its
-- search path and its grants, and only the errcode changed. rotate_join_code
-- was made with `set search_path = ''` and given `pg_catalog, pg_temp` by
-- 20261116001600_search_path_hardening.sql, which is what it is given here.
--
-- PostgREST also writes a PTnnn code's message into the HTTP status line
-- ("HTTP/1.1 404 No such company."). A line break in it would end that line
-- and start a header, so a PT-coded message is always a constant on one line,
-- never text from the request (security.db.mjs checks every one).
--
-- The phone and the office dashboard read the new codes and still read the
-- old ones, for a server where this migration has not run yet. The 40001 that
-- push_records raises when two calls overlap at REPEATABLE READ or
-- SERIALIZABLE is not a refusal (the second call is told to try again) and is
-- left as it is.

-- 1. The join flow.

-- As in 20261116002600_join_holds_and_races.sql: "No such roster row." is PT404.
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
    raise exception using errcode = 'PT404', message = 'No such roster row.';
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

-- As in 20261116002600_join_holds_and_races.sql: "No such join request." and
-- "No such roster row." are PT404; "already decided", "already on the roster",
-- "not active" and "already claimed" are PT409.
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
    raise exception using errcode = 'PT404', message = 'No such join request.';
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
    raise exception using errcode = 'PT404', message = 'No such join request.';
  end if;

  if request.status <> 'pending' then
    raise exception using errcode = 'PT409', message = 'That join request has already been decided.';
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
      errcode = 'PT409',
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
      raise exception using errcode = 'PT404', message = 'No such roster row.';
    end if;
    if not target.active then
      raise exception using errcode = 'PT409', message = 'That roster row is not active.';
    end if;
    if target.user_id is not null then
      if not coalesce(approve_join_request.replace_claim, false) then
        raise exception using
          errcode = 'PT409',
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

-- As in 20261116002600_join_holds_and_races.sql: "No such join request." is
-- PT404 and "already decided" PT409.
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
    raise exception using errcode = 'PT404', message = 'No such join request.';
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
    raise exception using errcode = 'PT404', message = 'No such join request.';
  end if;
  if request.status <> 'pending' then
    raise exception using errcode = 'PT409', message = 'That join request has already been decided.';
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

-- As in 20261116002000_join_holds.sql: "No such join request." is PT404.
create or replace function public.lift_join_bar(request_id uuid)
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
    raise exception using errcode = 'PT404', message = 'No such join request.';
  end if;

  delete from public.join_holds h
  where h.company_id = request.company_id and h.user_id = request.user_id and h.kind = 'barred';
end;
$$;

revoke all on function public.lift_join_bar(uuid) from public, anon, authenticated, service_role;
grant execute on function public.lift_join_bar(uuid) to authenticated;

-- As in 20261116001000_supervisor_functions.sql, with the search path of
-- 20261116001600_search_path_hardening.sql: "No such company." is PT404.
create or replace function public.rotate_join_code(company_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
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
    raise exception using errcode = 'PT404', message = 'No such company.';
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

revoke all on function public.rotate_join_code(uuid) from public, anon, authenticated, service_role;
grant execute on function public.rotate_join_code(uuid) to authenticated;

-- The roster trigger, as in 20261116001800_name_hygiene.sql: a row claimed by
-- another account is PT409. It stays bound to roster as it was.
create or replace function public.roster_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  name_written boolean := true;
  title_written boolean := true;
begin
  if tg_op = 'UPDATE' then
    name_written := new.first_name is distinct from old.first_name or new.last_name is distinct from old.last_name;
    title_written := new.title is distinct from old.title;
  end if;

  new.first_name := public.clean_text(new.first_name);
  new.last_name := public.clean_text(new.last_name);
  new.title := nullif(public.clean_text(new.title), '');

  if (name_written and (public.has_hidden_characters(new.first_name) or public.has_hidden_characters(new.last_name)))
     or (title_written and public.has_hidden_characters(new.title)) then
    raise exception using
      errcode = '22023',
      message = 'A name cannot hold control or invisible characters.';
  end if;
  if name_written and public.mixes_alphabets(new.first_name || ' ' || new.last_name) then
    raise exception using
      errcode = '22023',
      message = 'A name cannot mix letters of different alphabets, such as Latin and Cyrillic.',
      hint = 'Write the whole name in one alphabet.';
  end if;

  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id then
      raise exception using
        errcode = '42501',
        message = 'A roster row cannot move to another company.';
    end if;
    if old.user_id is not null and new.user_id is not null and new.user_id <> old.user_id then
      raise exception using
        errcode = 'PT409',
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

-- 2. The records, as in 20261117000300_push_records.sql: "No such company." is
-- PT404. The 40001 near its end stays as it is (above).
create or replace function public.push_records(company_id uuid, changes jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  -- The bounds (see the top of this file and migration 20261117000100).
  max_record_size constant integer := 1048576;
  max_record_text constant integer := 262144;
  max_call_text constant bigint := 8388608;
  max_day_versions constant integer := 20000;
  max_day_text constant bigint := 67108864;
  -- Kinds every phone of a build starts with a copy of.
  seeded constant text[] := array['settings', 'employee', 'equipment', 'areaSheet'];

  caller uuid := auth.uid();
  supervisor boolean;
  today date := (pg_catalog.now() at time zone 'UTC')::date;
  item jsonb;
  pos bigint;

  -- One change, and what becomes of it.
  c_kind text;
  c_id text;
  c_key text;
  c_rev text;
  c_base text;
  c_record jsonb;
  c_text integer;
  removing boolean;
  list text;
  reason text;
  problem text;
  conflict boolean;
  entry jsonb;

  stored public.records;
  mine_rev text;
  mine_base text;
  mine_found boolean;
  own boolean;

  -- The call as a whole.
  next_seq bigint;
  counted boolean := false;
  spent public.record_usage;
  metered boolean := false;
  call_text bigint := 0;
  holding text;
  seen jsonb := '{}'::jsonb;
  accepted jsonb := '[]'::jsonb;
  ignored jsonb := '[]'::jsonb;
  deferred jsonb := '[]'::jsonb;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;
  if push_records.company_id is null or not public.is_member(push_records.company_id) then
    raise exception using errcode = 'PT404', message = 'No such company.';
  end if;
  supervisor := public.is_supervisor(push_records.company_id);

  if push_records.changes is null or pg_catalog.jsonb_typeof(push_records.changes) <> 'array' then
    raise exception using errcode = '22023', message = 'Changes are sent as a list.';
  end if;
  if pg_catalog.jsonb_array_length(push_records.changes) > 200 then
    raise exception using
      errcode = '22023',
      message = 'Send at most 200 changes at a time.',
      hint = 'Send the rest in another call.';
  end if;

  for item, pos in
    select e.change, e.n
    from pg_catalog.jsonb_array_elements(push_records.changes) with ordinality as e(change, n)
    order by e.n
  loop
    list := 'ignored';
    reason := null;
    problem := null;
    conflict := false;
    entry := null;
    c_key := case when pg_catalog.jsonb_typeof(item -> 'key') = 'string' then item ->> 'key' end;
    c_rev := case when pg_catalog.jsonb_typeof(item -> 'rev') = 'string' then item ->> 'rev' end;

    <<decide>>
    loop
      if holding is not null then
        list := 'deferred';
        reason := holding;
        exit decide;
      end if;

      -- 1. The shape of the change.
      reason := 'malformed';
      if pg_catalog.jsonb_typeof(item) is distinct from 'object' then
        problem := 'is not an object';
      elsif pg_catalog.jsonb_typeof(item -> 'kind') is distinct from 'string'
         or (item ->> 'kind') not in ('settings', 'employee', 'equipment', 'areaSheet', 'shift', 'denied',
                                      'leave', 'inspection', 'opLog', 'exam', 'mrf') then
        reason := 'unknown_kind';
        problem := 'has a kind the server does not keep';
      elsif pg_catalog.jsonb_typeof(item -> 'id') is distinct from 'string'
         or pg_catalog.char_length(item ->> 'id') not between 1 and 120
         or (item ->> 'id') ~ '[\x01-\x1f\x7f-\x9f]' then
        problem := 'needs an id of 1 to 120 characters with no control characters';
      elsif c_key is null or c_key <> (item ->> 'kind') || ':' || (item ->> 'id') then
        problem := 'has a key that is not its kind and id';
      elsif (item ->> 'kind') = 'settings' and (item ->> 'id') <> 'company' then
        problem := 'is settings with an id other than company';
      elsif c_rev is null
         or pg_catalog.char_length(c_rev) not between 1 and 64
         or c_rev ~ '[\x01-\x1f\x7f-\x9f]' then
        problem := 'needs a rev of 1 to 64 characters with no control characters';
      elsif coalesce(pg_catalog.jsonb_typeof(item -> 'base'), 'null') <> 'null'
         and (pg_catalog.jsonb_typeof(item -> 'base') <> 'string'
              or pg_catalog.char_length(item ->> 'base') not between 1 and 64
              or (item ->> 'base') ~ '[\x01-\x1f\x7f-\x9f]') then
        problem := 'has a base that is not a rev';
      elsif c_rev = 'deleted' and coalesce(pg_catalog.jsonb_typeof(item -> 'record'), 'null') <> 'null' then
        problem := 'is a deletion that carries a record';
      elsif c_rev <> 'deleted' and pg_catalog.jsonb_typeof(item -> 'record') is distinct from 'object' then
        problem := 'needs a record that is a JSON object';
      end if;
      if problem is not null then
        problem := pg_catalog.format('Change %s %s.', pos, problem);
        exit decide;
      end if;
      reason := null;

      c_kind := item ->> 'kind';
      c_id := item ->> 'id';
      c_base := case when pg_catalog.jsonb_typeof(item -> 'base') = 'string' then item ->> 'base' end;
      removing := c_rev = 'deleted';
      c_record := case when removing then null else item -> 'record' end;

      -- 2. The same record again in this call.
      if seen ? c_key then
        if (seen -> c_key ->> 'rev') = c_rev then
          list := seen -> c_key ->> 'list';
          entry := seen -> c_key -> 'entry';
        else
          reason := 'duplicate';
        end if;
        exit decide;
      end if;

      -- 3 and 4. Size, without writing the record out as text; what never
      -- leaves a phone.
      if not removing then
        if pg_catalog.pg_column_size(c_record) > max_record_size then
          reason := 'too_large';
          exit decide;
        end if;
        if pg_catalog.jsonb_path_exists(c_record, 'strict $.** ? (@.type() == "number" && (@ > 1.8e308 || @ < -1.8e308 || (@ != 0 && @ < 4.9e-324 && @ > -4.9e-324)))') then
          reason := 'malformed';
          problem := pg_catalog.format('Change %s holds a number no phone sends.', pos);
          exit decide;
        end if;
        if pg_catalog.jsonb_path_exists(c_record, 'strict $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(payrates?|passwordhash|salt|(hourly)?rate)$" flag "i")')
           or (c_kind = 'settings' and exists (
             select 1
             from pg_catalog.jsonb_object_keys(c_record) as k(field)
             where k.field not in ('company', 'site', 'workweekStartsOn', 'allowSectionAllOk')
           )) then
          reason := 'private';
          exit decide;
        end if;
      end if;

      -- 5. What only a supervisor sends.
      if not supervisor and (removing or c_kind in ('settings', 'employee', 'areaSheet', 'leave')) then
        reason := 'supervisor_only';
        exit decide;
      end if;

      c_text := 0;
      if not removing then
        c_text := pg_catalog.octet_length(c_record::text);
        if c_text > max_record_text then
          reason := 'too_large';
          exit decide;
        end if;
      end if;

      -- 6. This call's share.
      if call_text + c_text > max_call_text then
        holding := 'call_size';
        list := 'deferred';
        reason := holding;
        exit decide;
      end if;
      call_text := call_text + c_text;

      -- 7. The company's counter first, then the record, both held to commit.
      if not counted then
        insert into public.record_counters (company_id) values (push_records.company_id)
        on conflict (company_id) do nothing;
        select rc.seq into next_seq
        from public.record_counters rc
        where rc.company_id = push_records.company_id
        for update;
        counted := true;
      end if;

      select r.* into stored
      from public.records r
      where r.company_id = push_records.company_id
        and r.kind = c_kind
        and r.id = c_id
      for update;

      if not found then
        if removing then
          -- A supervisor deleting a record the server does not have.
          list := 'accepted';
          exit decide;
        end if;
        if not supervisor and (c_kind = 'equipment' or (c_kind = 'mrf' and coalesce(c_record -> 'assignedTo', 'null'::jsonb) <> 'null'::jsonb)) then
          reason := 'supervisor_only';
          exit decide;
        end if;
      else
        if stored.rev = c_rev then
          list := 'accepted';
          exit decide;
        end if;

        -- The caller's own latest change to it, sent again.
        select h.rev, h.base into mine_rev, mine_base
        from public.record_history h
        where h.company_id = push_records.company_id
          and h.kind = c_kind
          and h.id = c_id
          and h."by" = caller
        order by h.version desc
        limit 1;
        mine_found := found;
        if mine_found and mine_rev = c_rev and mine_base is not distinct from c_base then
          list := 'accepted';
          exit decide;
        end if;

        if stored.deleted then
          if not supervisor then
            reason := 'deleted';
            exit decide;
          end if;
        elsif not removing and c_base is null
              and (c_kind = any (seeded) or stored.updated_by is distinct from caller) then
          reason := case
            when c_kind = any (seeded) then 'copy'
            when stored.created_by is distinct from caller then 'taken'
            else 'superseded'
          end;
          exit decide;
        elsif not supervisor and c_base is distinct from stored.rev and stored.updated_by is distinct from caller then
          reason := 'superseded';
          exit decide;
        end if;

        -- 8. What a member may change.
        if not supervisor then
          own := stored.created_by is not distinct from caller and not stored.created_by_supervisor;
          reason := public.member_change_refusal(c_kind, stored.data, c_record, own);
          if reason is not null then
            exit decide;
          end if;
        end if;
      end if;

      -- 6, again: today's share for this account, counted only for what is written.
      if not metered then
        insert into public.record_usage (user_id, day) values (caller, today)
        on conflict (user_id) do nothing;
        select u.* into spent from public.record_usage u where u.user_id = caller for update;
        if spent.day is distinct from today then
          spent.day := today;
          spent.versions := 0;
          spent.bytes := 0;
        end if;
        metered := true;
      end if;
      if spent.versions + 1 > max_day_versions or spent.bytes + c_text > max_day_text then
        holding := 'daily_limit';
        list := 'deferred';
        reason := holding;
        exit decide;
      end if;

      -- 9. Written.
      next_seq := next_seq + 1;
      spent.versions := spent.versions + 1;
      spent.bytes := spent.bytes + c_text;
      list := 'accepted';

      if stored is null or stored.company_id is null then
        insert into public.records (company_id, kind, id, rev, data, seq, created_by, created_by_supervisor, updated_by)
        values (push_records.company_id, c_kind, c_id, c_rev, c_record, next_seq, caller, supervisor, caller)
        on conflict (company_id, kind, id) do nothing;
        if not found then
          raise exception using errcode = '40001', message = 'Another phone was sending the same record. Try again.';
        end if;
        insert into public.record_history (company_id, kind, id, version, rev, base, data, deleted, seq, by)
        values (push_records.company_id, c_kind, c_id, 1, c_rev, c_base, c_record, false, next_seq, caller);
        -- The phone had seen a version of it, and the server has none.
        conflict := c_base is not null;
        exit decide;
      end if;

      update public.records r
      set rev = c_rev,
          data = coalesce(c_record, '{}'::jsonb),
          deleted = removing,
          version = stored.version + 1,
          seq = next_seq,
          updated_by = caller,
          updated_at = pg_catalog.now()
      where r.company_id = push_records.company_id
        and r.kind = c_kind
        and r.id = c_id;

      insert into public.record_history (company_id, kind, id, version, rev, base, data, deleted, seq, by)
      values (push_records.company_id, c_kind, c_id, stored.version + 1, c_rev, c_base, c_record, removing, next_seq, caller);

      -- Made from a version other than the one the server had.
      conflict := c_base is distinct from stored.rev;
      exit decide;
    end loop;

    if entry is null then
      entry := pg_catalog.jsonb_build_object('key', c_key, 'rev', c_rev);
      if list <> 'accepted' then
        entry := entry || pg_catalog.jsonb_build_object('reason', reason);
      end if;
      if problem is not null then
        entry := entry || pg_catalog.jsonb_build_object('problem', problem);
      end if;
      if conflict then
        entry := entry || pg_catalog.jsonb_build_object('conflict', true);
      end if;
    end if;

    if list = 'accepted' then
      accepted := accepted || pg_catalog.jsonb_build_array(entry);
    elsif list = 'ignored' then
      ignored := ignored || pg_catalog.jsonb_build_array(entry);
    else
      deferred := deferred || pg_catalog.jsonb_build_array(entry);
    end if;
    if c_key is not null and reason is distinct from 'malformed' and reason is distinct from 'unknown_kind' and not seen ? c_key then
      seen := seen || pg_catalog.jsonb_build_object(c_key, pg_catalog.jsonb_build_object('rev', c_rev, 'list', list, 'entry', entry));
    end if;
    stored := null;
  end loop;

  if counted then
    update public.record_counters rc set seq = next_seq where rc.company_id = push_records.company_id;
  end if;
  if metered then
    update public.record_usage u
    set day = spent.day, versions = spent.versions, bytes = spent.bytes
    where u.user_id = caller;
  end if;

  return pg_catalog.jsonb_build_object('accepted', accepted, 'ignored', ignored)
    || case when pg_catalog.jsonb_array_length(deferred) > 0 then pg_catalog.jsonb_build_object('deferred', deferred) else '{}'::jsonb end;
end;
$$;

revoke all on function public.push_records(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.push_records(uuid, jsonb) to authenticated;

-- 3. Billing, as in 20261117000500_billing.sql: "No such company." is PT404.
create or replace function public.company_billing(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;
  if p_company_id is null or not public.is_supervisor(p_company_id) then
    raise exception using errcode = 'PT404', message = 'No such company.';
  end if;
  return public.billing_standing(p_company_id);
end;
$$;

revoke all on function public.company_billing(uuid) from public, anon, authenticated, service_role;
grant execute on function public.company_billing(uuid) to authenticated;
