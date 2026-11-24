-- MineMuster: who works a maintenance request, as far as the server can tell
-- today.
--
-- This migration is new; it never edits an applied one. A request is assigned
-- by a supervisor, and worked by a supervisor or the person it is assigned to;
-- "completed by" is the person who closes it, or, from a supervisor closing it
-- out for the person it is assigned to, that person (AGENTS.md; assignMrf,
-- startMrf and completeMrf in src/store/useStore.ts). Until now push_records
-- took from any member the work on any request not yet completed, whoever it
-- was assigned to, and took a member's new request already completed. It now
-- holds the part of the rule it can hold without knowing which person on the
-- roster an account is:
--
--  * A member's new request is open and unassigned, as createMrf makes it:
--    status "open", no assignedTo, nothing that completing it writes
--    (completedAt, completedBy, timeSpent, remarks), and a history that is
--    left out, null, or a list in which every entry is "open" and names
--    nobody as assigned. A field that is null is the same as one left out.
--    Anything else: 'supervisor_only', as a new request that named who it was
--    assigned to already was.
--  * A request nobody is assigned to is worked by a supervisor. A member
--    changes nothing on it: not its status (starting the work, moving it back
--    to open, completing it), not what completing it writes, and adds nothing
--    to its history: 'supervisor_only'.
--  * An entry a member adds to the history of a request assigned to someone
--    never names who it is assigned to, whoever that is: assigning is a
--    supervisor's, and the field itself already was ('supervisor_only').
--
-- Still taken from any member, until the two-way sync work links each server
-- account to the app's employee id: the work on a request that is assigned to
-- someone, completing it included, from an account that is not that person's,
-- with any name as completed by. Every other change a member could make before
-- is taken as it was. 'supervisor_only' is push_records' own answer for a
-- change only a supervisor makes. A phone counts it as sent, as it counts any
-- change the server will not take from its account, and does not send that
-- version again (readPushAnswer in src/domain/serverAnswers.ts).
--
-- The server judges what a phone sends by the account the phone is connected
-- with, not by who is signed in to the app. On a phone connected with a crew
-- account, then, a supervisor signed in to the app can no longer send the
-- start or the completion of a request nobody is assigned to (assigning one
-- was refused already). The server keeps the request as it had it, and the
-- remarks, which are the repair record, stay on that phone. When the request
-- came from a pre shift exam that the same account sent, the date fixed that
-- completing it writes on the exam is still taken, so the server has the line
-- fixed and the request open. And a request made on such a phone and assigned
-- (as before) or completed there before the phone first sends it is set aside
-- whole: the phone sends only its latest version, which is not open and
-- unassigned, so the server never has the request, not even open, and the
-- mrfId on the checklist or exam line it came from names a request the server
-- does not have. The two-way sync work has to carry both: link each account to
-- the app's employee id, and keep a change set aside for its account until it
-- can be sent, rather than counting it as sent.
--
-- Re-created from their latest definitions, with security settings, search
-- path and grants as they were: member_change_refusal from
-- 20261117000300_push_records.sql (the mrf rule, and a variable for it), and
-- push_records from 20261117000600_refusals_are_4xx.sql (the check on a new
-- request, and nothing else). request_is_open_and_unassigned is new, and
-- nobody but push_records calls it.

-- Whether a new maintenance request is open and unassigned, the way createMrf
-- makes one. Never null.
create function public.request_is_open_and_unassigned(request jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    pg_catalog.jsonb_typeof(request) = 'object'
    and (request -> 'status') is not distinct from '"open"'::jsonb
    and coalesce(request -> 'assignedTo', 'null'::jsonb) = 'null'::jsonb
    and coalesce(request -> 'completedAt', 'null'::jsonb) = 'null'::jsonb
    and coalesce(request -> 'completedBy', 'null'::jsonb) = 'null'::jsonb
    and coalesce(request -> 'timeSpent', 'null'::jsonb) = 'null'::jsonb
    and coalesce(request -> 'remarks', 'null'::jsonb) = 'null'::jsonb
    and coalesce(pg_catalog.jsonb_typeof(request -> 'history'), 'null') in ('array', 'null')
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(request -> 'history') = 'array' then request -> 'history' else '[]'::jsonb end
      ) as e(v)
      where (e.v -> 'status') is distinct from '"open"'::jsonb
         or coalesce(e.v -> 'assignedTo', 'null'::jsonb) <> 'null'::jsonb
    ),
    false)
$$;

revoke all on function public.request_is_open_and_unassigned(jsonb) from public, anon, authenticated, service_role;

-- As in 20261117000300_push_records.sql, but for a request (mrf): with nobody
-- assigned, a member changes nothing on it, and a member adds no history
-- entry that names who it is assigned to. The rest of what it says about a
-- request, and everything about the other kinds, is as it was:
--
--  * mrf: the work on a request not yet completed and assigned to someone:
--    status, remarks, time spent, completed by and at, and history added to.
--    Who it is assigned to, and what it is about, are a supervisor's, and so
--    is an added history entry that names who it is assigned to. With nobody
--    assigned (no assignedTo, or one that is not a name), the work on it is a
--    supervisor's too, all of it: starting it, moving it back to open,
--    completing it, what completing it writes, and any entry added to its
--    history. With someone assigned, the server cannot yet tell that person's
--    account from another member's: the work, completing it included, is
--    still taken from any member, until the two-way sync work.
create or replace function public.member_change_refusal(kind text, was jsonb, now_is jsonb, own boolean)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  line jsonb;
  n bigint;
  part text;
  added jsonb;
begin
  if now_is = was then
    return null;
  end if;

  if kind = 'shift' then
    if not own then
      return 'not_yours';
    end if;
    if coalesce(was -> 'clockOut', 'null'::jsonb) <> 'null'::jsonb then
      return 'signed';
    end if;
    if (now_is - array['clockOut', 'mealNote', 'lunches', 'breaks']) is distinct from (was - array['clockOut', 'mealNote', 'lunches', 'breaks'])
       or not public.json_starts_with(now_is -> 'lunches', was -> 'lunches') then
      return 'signed';
    end if;
    -- A break keeps its start, and its end once it has one.
    if pg_catalog.jsonb_typeof(was -> 'breaks') = 'array' then
      for line, n in
        select e.v, e.n from pg_catalog.jsonb_array_elements(was -> 'breaks') with ordinality as e(v, n)
      loop
        if (now_is -> 'breaks' -> (n::integer - 1)) is null
           or (now_is -> 'breaks' -> (n::integer - 1) -> 'start') is distinct from (line -> 'start')
           or (coalesce(line -> 'end', 'null'::jsonb) <> 'null'::jsonb
               and (now_is -> 'breaks' -> (n::integer - 1) -> 'end') is distinct from (line -> 'end')) then
          return 'signed';
        end if;
      end loop;
    end if;
    return null;
  end if;

  if kind = 'denied' then
    return case when own then 'signed' else 'not_yours' end;
  end if;

  if kind = 'inspection' then
    if not own then
      return 'not_yours';
    end if;
    if (now_is - array['decision', 'mrfId']) is distinct from (was - array['decision', 'mrfId'])
       or (coalesce(was -> 'decision', 'null'::jsonb) <> 'null'::jsonb and (now_is -> 'decision') is distinct from (was -> 'decision')) then
      return 'signed';
    end if;
    return null;
  end if;

  if kind = 'exam' then
    if not own then
      return 'not_yours';
    end if;
    if public.exam_as_signed(now_is) is distinct from public.exam_as_signed(was) then
      return 'signed';
    end if;
    -- The first date fixed stands.
    foreach part in array array['rows', 'conditions'] loop
      if pg_catalog.jsonb_typeof(was -> part) = 'array' then
        for line, n in
          select e.v, e.n from pg_catalog.jsonb_array_elements(was -> part) with ordinality as e(v, n)
        loop
          if coalesce(line -> 'fixed', 'null'::jsonb) <> 'null'::jsonb
             and (now_is -> part -> (n::integer - 1) -> 'fixed') is distinct from (line -> 'fixed') then
            return 'signed';
          end if;
        end loop;
      end if;
    end loop;
    return null;
  end if;

  if kind = 'opLog' then
    if coalesce(was -> 'endAt', 'null'::jsonb) <> 'null'::jsonb then
      return case when own then 'signed' else 'not_yours' end;
    end if;
    if own then
      if (now_is -> 'id', now_is -> 'equipmentId', now_is -> 'employeeId', now_is -> 'inspectionId', now_is -> 'startAt', now_is -> 'startMeter')
         is distinct from
         (was -> 'id', was -> 'equipmentId', was -> 'employeeId', was -> 'inspectionId', was -> 'startAt', was -> 'startMeter') then
        return 'signed';
      end if;
      return null;
    end if;
    if (now_is - array['endAt', 'endMeter']) is distinct from (was - array['endAt', 'endMeter'])
       or coalesce(now_is -> 'endAt', 'null'::jsonb) = 'null'::jsonb then
      return 'not_yours';
    end if;
    return null;
  end if;

  if kind = 'mrf' then
    if (was ->> 'status') = 'completed'
       or (now_is - array['status', 'completedAt', 'completedBy', 'timeSpent', 'remarks', 'history'])
          is distinct from (was - array['status', 'completedAt', 'completedBy', 'timeSpent', 'remarks', 'history'])
       or not public.json_starts_with(now_is -> 'history', was -> 'history') then
      return 'supervisor_only';
    end if;
    -- With nobody assigned, the work on it is a supervisor's, all of it: a
    -- member's change to it here is never none (now_is is not was, above).
    if pg_catalog.jsonb_typeof(was -> 'assignedTo') is distinct from 'string' or pg_catalog.btrim(was ->> 'assignedTo') = '' then
      return 'supervisor_only';
    end if;
    -- What the history gains: the entries past the ones it had.
    added := '[]'::jsonb;
    if pg_catalog.jsonb_typeof(now_is -> 'history') = 'array' then
      select coalesce(pg_catalog.jsonb_agg(e.v order by e.n), '[]'::jsonb) into added
      from pg_catalog.jsonb_array_elements(now_is -> 'history') with ordinality as e(v, n)
      where e.n > case when pg_catalog.jsonb_typeof(was -> 'history') = 'array' then pg_catalog.jsonb_array_length(was -> 'history') else 0 end;
    end if;
    -- Assigning it is a supervisor's, in its history as in assignedTo. The
    -- rest of the work on a request assigned to someone is still any member's
    -- for now: the server cannot tell that person's account from another
    -- member's until the two-way sync work links each account to the app's
    -- employee id.
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(added) as e(v)
      where coalesce(e.v -> 'assignedTo', 'null'::jsonb) <> 'null'::jsonb
    ) then
      return 'supervisor_only';
    end if;
    return null;
  end if;

  if kind = 'equipment' then
    if (now_is - array['status', 'meter']) is distinct from (was - array['status', 'meter']) then
      return 'supervisor_only';
    end if;
    if pg_catalog.jsonb_typeof(was -> 'meter') = 'number'
       and (pg_catalog.jsonb_typeof(now_is -> 'meter') is distinct from 'number'
            or (now_is ->> 'meter')::numeric < (was ->> 'meter')::numeric) then
      return 'supervisor_only';
    end if;
    return null;
  end if;

  -- settings, employee, areaSheet, leave: never reach here from a member.
  return 'supervisor_only';
end;
$$;

revoke all on function public.member_change_refusal(text, jsonb, jsonb, boolean) from public, anon, authenticated, service_role;

-- As in 20261117000600_refusals_are_4xx.sql, but a member's new request must
-- be open and unassigned (request_is_open_and_unassigned) where it had only
-- to name nobody as assigned. Its answer is 'supervisor_only', as before.
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
        if not supervisor and (c_kind = 'equipment' or (c_kind = 'mrf' and not public.request_is_open_and_unassigned(c_record))) then
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
