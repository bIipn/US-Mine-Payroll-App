-- MineMuster, step 2: how a phone sends its records.
--
-- push_records(company_id, changes) takes what a phone sends (changesToSend in
-- src/domain/sync.ts), at most 200 changes a call, and answers with the ones
-- it took, the ones it set aside, and, only when there are any, the ones it
-- left for a later call:
--
--   {"accepted": [{"key", "rev"}, ...],
--    "ignored":  [{"key", "rev", "reason"}, ...],
--    "deferred": [{"key", "rev", "reason"}, ...]}
--
-- The phone marks accepted and ignored as sent (markSent, readPushAnswer). An
-- ignored change is one the server will not take from this caller: the phone
-- stops sending it and the server keeps what it had. A deferred change is not
-- in either list, so the phone sends it again in its next round. Phones do not
-- pull yet: a phone knows only the versions the server confirmed to it, which
-- is why several rules below protect what someone else wrote from a phone that
-- has not seen it.
--
-- A change is {key, kind, id, rev, base?, record}, as the phone makes it. The
-- changes are taken in order, in one transaction. A call that is not a list, or
-- has more than 200 changes, is refused whole (22023). Anything else wrong with
-- one change sets aside that change only, so one bad record never stops the
-- rest of a phone's records:
--
--  1. Shape (reason 'malformed', with a 'problem' that says what is wrong, or
--     'unknown_kind'): a change that is not an object, a kind the server does
--     not keep, an id that is not 1 to 120 characters free of control
--     characters, a key that is not kind:id, settings with an id other than
--     'company', a rev that is not 1 to 64 such characters, a base that is not
--     one either, a record that is not an object (or, for a deletion, whose
--     rev is 'deleted', not null), or a record holding a number no phone sends.
--  2. The same key again in one call: the same rev gets the same answer, any
--     other rev is set aside ('duplicate'). One call writes one version of a
--     record.
--  3. Size ('too_large'): a record over 1 MB as stored or 256 KB as JSON text,
--     checked in that order, so nothing is written out as text before it is
--     known to be small (see migration 20261117000100).
--  4. What never leaves a phone ('private'), whoever sends it: a record with a
--     field named payRates, payRate, passwordHash, salt, rate or hourlyRate,
--     in any capitals, at any depth; and settings with any field but the four
--     a company shares (company, site, workweekStartsOn, allowSectionAllOk).
--  5. What only a supervisor sends ('supervisor_only'): the settings, the
--     roster (employee), the area sheets, paid leave, any deletion, a new unit
--     in the fleet, and a new maintenance request that already names who it is
--     assigned to.
--  6. Bounds on a call and a day ('deferred', reason 'call_size' or
--     'daily_limit'): once a call has taken 8 MB of records, or the caller's
--     account has sent 20,000 versions or 64 MB of records today (UTC), the
--     change and every one after it in the call are left for later.
--  7. The record as the server has it, locked. One company's calls take turns
--     from here to commit (record_counters), so seq order is commit order.
--     * The server has this version already, or this is the caller's own
--       latest change to it sent again (same rev and base: a batch retried
--       after its answer was lost): accepted, nothing written.
--     * The record is deleted: only a supervisor brings it back ('deleted').
--     * A change with no base onto a record the server has is a copy, not an
--       edit, whenever the server's version is someone else's, and always for
--       the settings, the roster, the fleet and the area sheets, which every
--       phone of a build starts with: 'copy', or 'taken' when the record is
--       another account's own (a shift, punch, checklist, log, exam, request
--       or leave entry), or 'superseded' when it is the caller's own but
--       someone else changed it since.
--     * A member's change made from a version other than the server's, when
--       someone else wrote the server's: 'superseded'. A phone that has not
--       seen a supervisor's correction does not undo it.
--  8. What a member may change in a record someone sent (member_change_refusal
--     below): their own shift's clock-out, lunches and breaks, never a time
--     already on it; their own checklist's decision, once, and its request;
--     their own exam's dates fixed, once each, and requests; their own
--     operating log until it is checked in; another operator's open log, to
--     end it; a maintenance request's work (status, remarks, time spent,
--     completed by and at, and new history), until it is completed; a unit's
--     status, and its equipment hours, upward. Anything else: 'signed' for a
--     signed record of their own, 'not_yours' for someone else's,
--     'supervisor_only' for a request or a unit. A supervisor changes anything.
--  9. Written: the record, and a new version in record_history, each with the
--     company's next seq. A change made from a version other than the one the
--     server had (a supervisor's, or the caller's own on top of their own) is
--     still written, and its accepted entry carries "conflict": true.
--
-- A deletion keeps the row, marked deleted and emptied; what it held stays in
-- the history. A supervisor's deletion of a record the server does not have
-- writes nothing and is accepted.
--
-- The caller must be a member of the company. A company they are not in gets
-- the same answer as one that does not exist: no such company (P0002).

-- Whether an array begins with every element of another, in order. Null and
-- anything but an array count as an empty list for the prefix, and as no list
-- for the array.
create function public.json_starts_with(list jsonb, prefix jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when prefix is null or pg_catalog.jsonb_typeof(prefix) <> 'array' or pg_catalog.jsonb_array_length(prefix) = 0 then true
    when list is null or pg_catalog.jsonb_typeof(list) <> 'array' then false
    when pg_catalog.jsonb_array_length(list) < pg_catalog.jsonb_array_length(prefix) then false
    else not exists (
      select 1
      from pg_catalog.jsonb_array_elements(prefix) with ordinality as p(v, n)
      where (list -> (p.n::integer - 1)) is distinct from p.v
    )
  end
$$;

-- An exam with the date fixed and the request taken off every line: what the
-- person signed.
create function public.exam_as_signed(exam jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select exam
    || case when pg_catalog.jsonb_typeof(exam -> 'rows') = 'array' then pg_catalog.jsonb_build_object('rows', (
         select coalesce(pg_catalog.jsonb_agg(case when pg_catalog.jsonb_typeof(e.v) = 'object' then e.v - 'fixed' - 'mrfId' else e.v end order by e.n), '[]'::jsonb)
         from pg_catalog.jsonb_array_elements(exam -> 'rows') with ordinality as e(v, n)))
       else '{}'::jsonb end
    || case when pg_catalog.jsonb_typeof(exam -> 'conditions') = 'array' then pg_catalog.jsonb_build_object('conditions', (
         select coalesce(pg_catalog.jsonb_agg(case when pg_catalog.jsonb_typeof(e.v) = 'object' then e.v - 'fixed' - 'mrfId' else e.v end order by e.n), '[]'::jsonb)
         from pg_catalog.jsonb_array_elements(exam -> 'conditions') with ordinality as e(v, n)))
       else '{}'::jsonb end
$$;

-- Why a member may not make this change to a record that is already on the
-- server, or null when they may. `own` is whether the caller's account sent
-- it first, as an employee. The rules are the app's own (src/store/useStore.ts):
--
--  * shift: the person's own, while it is open. Clocking out, a lunch (which
--    ends by itself, 30 minutes on) and a break are added; no time already on
--    it moves, nothing is taken off, and a correction (edits) is a
--    supervisor's. Once clocked out, it does not change.
--  * denied: a turned-down punch does not change.
--  * inspection: the person's own checklist. What they decided after a
--    defect, once, and the request it was sent on.
--  * exam: the person's own exam. A date fixed on a line, once (the first
--    date stands), and the request a line was sent on. A date fixed by
--    completing the request is the request's: its completedAt, completedBy,
--    examId and findingKey say it.
--  * opLog: the operator's own log until it is checked in, with its start
--    left as it was; or another operator's open log, ended (endAt and
--    endMeter and nothing else), as a new operator taking the unit does.
--  * mrf: the work on a request not yet completed: status, remarks, time
--    spent, completed by and at, and history added to. Who it is assigned to,
--    and what it is about, are a supervisor's.
--  * equipment: a unit's status, and its equipment hours, never down.
create function public.member_change_refusal(kind text, was jsonb, now_is jsonb, own boolean)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  line jsonb;
  n bigint;
  part text;
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

revoke all on function public.json_starts_with(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.exam_as_signed(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.member_change_refusal(text, jsonb, jsonb, boolean) from public, anon, authenticated, service_role;

create function public.push_records(company_id uuid, changes jsonb)
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
    raise exception using errcode = 'P0002', message = 'No such company.';
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
