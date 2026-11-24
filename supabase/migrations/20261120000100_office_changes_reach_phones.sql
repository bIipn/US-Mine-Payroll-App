-- MineMuster: the company's roster, fleet, area sheets and settings reach the
-- phones.
--
-- This migration is new; it never edits an applied one. Until now a phone only
-- sent. From here a phone also reads the four kinds of record every phone
-- works from (settings, employee, equipment, areaSheet; the list push_records
-- calls `seeded`), so what the office changes on the dashboard reaches the
-- crew. What that takes on the server:
--
--  1. The read. read_shared_records hands a member the four kinds of their
--     company, in seq order after the cursor the phone saved, at most 500 rows
--     a call, deletions included. A person's payroll ID goes only to a
--     supervisor of the company. Members can no longer read people's records
--     through the table: records_select_members and
--     record_history_select_members are made again without 'employee' in the
--     members' list. Supervisors read everything, as before.
--  2. Two indexes: the phones' read, and a unit's open requests.
--  3. Every record of the four kinds, from anyone, the dashboard included, has
--     the shape the phones read (shared_record_problem; readRecord in
--     src/domain/receive.ts), or is set aside as 'malformed'. A phone passes
--     over a row it cannot read, so the server never keeps one.
--  4. A version name names one content: a change that names an earlier
--     version of the record with other content is 'malformed'.
--  5. The four kinds are written only on top of the version a change was made
--     from, from anyone, a deletion too ('superseded'); a change made from a
--     copy the phone had before the record was taken out is 'deleted'. A
--     supervisor adding back a record the phone saw taken out (no base) is
--     still taken. For these kinds a version is the whole record and every
--     phone takes the company's version before it sends its own, so the
--     version a change was made from is enough to tell a stale change.
--  6. A unit's status is never better than the company's open maintenance
--     requests on it, from anyone: an open request that red-tagged it keeps
--     it out of service, any other open request keeps it marked for a defect
--     ('open_request', with the floor in the answer). Once phones receive, one
--     write that took a red tag off would reach every phone.
--
-- push_records is re-created from 20261117000900_request_completion.sql with
-- those checks and nothing else, its security settings, search path and
-- grants as they were, and every refusal still a 4xx.

-- ---- 1. The read ---------------------------------------------------------------------------------------

drop policy records_select_members on public.records;
drop policy record_history_select_members on public.record_history;

-- As in 20261117000200_record_reads.sql, with 'employee' taken out of what any
-- member reads: a crew member gets the roster through read_shared_records,
-- without payroll IDs.
create policy records_select_members
  on public.records for select
  to authenticated
  using (
    company_id = any ((select public.member_company_ids())::uuid[])
    and (
      company_id = any ((select public.supervisor_company_ids())::uuid[])
      or kind in ('settings', 'equipment', 'areaSheet', 'inspection', 'opLog', 'exam', 'mrf')
      or (kind in ('shift', 'denied') and created_by = (select auth.uid()) and not created_by_supervisor)
    )
  );

create policy record_history_select_members
  on public.record_history for select
  to authenticated
  using (
    company_id = any ((select public.member_company_ids())::uuid[])
    and (
      company_id = any ((select public.supervisor_company_ids())::uuid[])
      or kind in ('settings', 'equipment', 'areaSheet', 'inspection', 'opLog', 'exam', 'mrf')
      or (
        kind in ('shift', 'denied')
        and exists (
          select 1
          from public.records r
          where r.company_id = record_history.company_id
            and r.kind = record_history.kind
            and r.id = record_history.id
            and r.created_by = (select auth.uid())
            and not r.created_by_supervisor
        )
      )
    )
  );

-- The four kinds of record every phone works from, after a phone's cursor, in
-- seq order. push_records holds the company's counter row from before it
-- looks at a record until it commits, and nothing else writes records, so the
-- versions a reader sees are always a prefix in seq order and one cursor is
-- enough. A page shorter than max is not the end; only an empty page is.
--
-- A caller who is not a member of the company is refused as push_records
-- refuses one. A supervisor of a company that does not have MineMuster is told
-- so (PT402, "Payment Required"), so the phone says it rather than take
-- nothing for "caught up"; a crew member of one reads as before
-- (records_open_company_ids, 20261117000700). A person's payroll ID goes only
-- to a supervisor of the company.
create function public.read_shared_records(company_id uuid, after bigint, max integer)
returns table (kind text, id text, rev text, seq bigint, deleted boolean, data jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  supervisor boolean;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;
  if read_shared_records.company_id is null or not public.is_member(read_shared_records.company_id) then
    raise exception using errcode = 'PT404', message = 'No such company.';
  end if;
  supervisor := public.is_supervisor(read_shared_records.company_id);
  if not (read_shared_records.company_id = any ((select public.records_open_company_ids())::uuid[])) then
    if supervisor then
      raise exception using errcode = 'PT402', message = 'MineMuster is not active for this company.';
    end if;
    return;
  end if;
  return query
    select r.kind, r.id, r.rev, r.seq, r.deleted,
           case when r.kind = 'employee' and not supervisor then r.data - 'payrollId' else r.data end
    from public.records r
    where r.company_id = read_shared_records.company_id
      and r.kind in ('settings', 'employee', 'equipment', 'areaSheet')
      and r.seq > coalesce(read_shared_records.after, 0)
    order by r.seq
    limit least(greatest(coalesce(read_shared_records.max, 200), 1), 500);
end;
$$;

revoke all on function public.read_shared_records(uuid, bigint, integer) from public, anon, authenticated, service_role;
grant execute on function public.read_shared_records(uuid, bigint, integer) to authenticated;

-- ---- 2. Two indexes ------------------------------------------------------------------------------------

-- The phones' read: the four kinds of one company by seq. The function names
-- the kinds as constants, so the planner can use this partial index.
create index records_shared_seq on public.records (company_id, seq)
  where kind in ('settings', 'employee', 'equipment', 'areaSheet');

-- A unit's open requests, for the floor of its status.
create index records_mrf_unit on public.records (company_id, (data ->> 'equipmentId'))
  where kind = 'mrf' and not deleted;

-- ---- 3. The shape the phones read, and a unit's floor ---------------------------------------------------

-- What is wrong with a record of the four kinds for a phone to read it, said
-- the way push_records says a problem ("Change 3 ..."), or null when it reads.
-- The same checks as readRecord in src/domain/receive.ts, which the phones run
-- on every row they take; one fixture file of good and bad records
-- (src/domain/__tests__/fixtures/sharedRecords.json) holds both to them. Of a
-- company, the server checks the name and the state; the pay schedule, the
-- mine ID and the earning codes are checked by the phones and by the
-- dashboard's own save. Text is blank when it holds nothing but spaces, tabs
-- and line breaks.
create function public.shared_record_problem(kind text, id text, data jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  site jsonb;
  point jsonb;
  n numeric;
begin
  if pg_catalog.jsonb_typeof(data) is distinct from 'object' then
    return 'is not an object';
  end if;
  if kind <> 'settings'
     and (pg_catalog.jsonb_typeof(data -> 'id') is distinct from 'string' or (data ->> 'id') <> id) then
    return 'holds a record whose id is not the change''s';
  end if;

  if kind = 'employee' then
    if pg_catalog.jsonb_typeof(data -> 'firstName') is distinct from 'string'
       or (data ->> 'firstName') !~ '[^ \t\n\r\f\v]'
       or pg_catalog.jsonb_typeof(data -> 'lastName') is distinct from 'string'
       or (data ->> 'lastName') !~ '[^ \t\n\r\f\v]' then
      return 'is a person with no first or last name';
    end if;
    if pg_catalog.jsonb_typeof(data -> 'role') is distinct from 'string'
       or (data ->> 'role') not in ('employee', 'supervisor') then
      return 'is a person with no role the app has';
    end if;
    if pg_catalog.jsonb_typeof(data -> 'active') is distinct from 'boolean' then
      return 'is a person not marked on or off the roster';
    end if;
    if (data ? 'title' and pg_catalog.jsonb_typeof(data -> 'title') <> 'string')
       or (data ? 'payrollId' and pg_catalog.jsonb_typeof(data -> 'payrollId') <> 'string') then
      return 'is a person whose job title or payroll ID is not text';
    end if;
    return null;
  end if;

  if kind = 'equipment' then
    if pg_catalog.jsonb_typeof(data -> 'unit') is distinct from 'string'
       or pg_catalog.jsonb_typeof(data -> 'make') is distinct from 'string'
       or pg_catalog.jsonb_typeof(data -> 'model') is distinct from 'string' then
      return 'is a unit with no unit number, make or model';
    end if;
    if pg_catalog.jsonb_typeof(data -> 'category') is distinct from 'string'
       or (data ->> 'category') not in ('loader', 'haul_truck', 'excavator', 'dozer', 'grader',
                                       'water_truck', 'skid_steer', 'forklift', 'light_vehicle') then
      return 'is a unit with no type of machine the app has';
    end if;
    if pg_catalog.jsonb_typeof(data -> 'status') is distinct from 'string'
       or (data ->> 'status') not in ('ready', 'defect', 'out_of_service') then
      return 'is a unit with no status the app has';
    end if;
    if pg_catalog.jsonb_typeof(data -> 'meter') is distinct from 'number'
       or (data ->> 'meter')::numeric not between 0 and 10000000 then
      return 'is a unit whose equipment hours are not a number from 0 to 10,000,000';
    end if;
    if pg_catalog.jsonb_typeof(data -> 'meterUnit') is distinct from 'string'
       or (data ->> 'meterUnit') not in ('hrs', 'mi') then
      return 'is a unit counted in neither hours nor miles';
    end if;
    return null;
  end if;

  if kind = 'areaSheet' then
    if pg_catalog.jsonb_typeof(data -> 'title') is distinct from 'string'
       or (data ->> 'title') !~ '[^ \t\n\r\f\v]' then
      return 'is a sheet with no name';
    end if;
    if pg_catalog.jsonb_typeof(data -> 'rows') is distinct from 'array'
       or pg_catalog.jsonb_array_length(data -> 'rows') = 0 then
      return 'is a sheet with no lines';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(data -> 'rows') as e(line)
      where pg_catalog.jsonb_typeof(e.line) <> 'object'
         or pg_catalog.jsonb_typeof(e.line -> 'id') is distinct from 'string'
         or pg_catalog.jsonb_typeof(e.line -> 'label') is distinct from 'string'
    ) then
      return 'is a sheet with a line that has no id or words';
    end if;
    if (select pg_catalog.count(distinct e.line ->> 'id') from pg_catalog.jsonb_array_elements(data -> 'rows') as e(line))
       <> pg_catalog.jsonb_array_length(data -> 'rows') then
      return 'is a sheet with two lines of one id';
    end if;
    if pg_catalog.jsonb_typeof(data -> 'active') is distinct from 'boolean'
       or (data ? 'single' and pg_catalog.jsonb_typeof(data -> 'single') <> 'boolean') then
      return 'is a sheet whose switches are not on or off';
    end if;
    return null;
  end if;

  if kind = 'settings' then
    if pg_catalog.jsonb_typeof(data -> 'company') is distinct from 'object'
       or pg_catalog.jsonb_typeof(data -> 'company' -> 'name') is distinct from 'string'
       or (data -> 'company' ->> 'name') !~ '[^ \t\n\r\f\v]' then
      return 'holds a company with no name';
    end if;
    if pg_catalog.jsonb_typeof(data -> 'company' -> 'state') is distinct from 'string'
       or (data -> 'company' ->> 'state') not in (
         'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL',
         'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
         'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
         'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
         'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI',
         'WY') then
      return 'holds a company with no state the app has';
    end if;

    -- Every phone sends all four fields; a site of none is null, not left out.
    if not (data ? 'site') then
      return 'holds no clock-in site, not even none';
    end if;
    site := data -> 'site';
    if pg_catalog.jsonb_typeof(site) <> 'null' then
      if pg_catalog.jsonb_typeof(site) <> 'object'
         or pg_catalog.jsonb_typeof(site -> 'name') is distinct from 'string'
         or pg_catalog.jsonb_typeof(site -> 'radiusM') is distinct from 'number'
         or (site ->> 'radiusM')::numeric <= 0 then
        return 'holds a clock-in site with no name or boundary';
      end if;
      -- The centre, every point of the boundary, and the town's centre.
      for point in
        select site -> 'center'
        union all
        select p.value from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(site -> 'polygon') = 'array' then site -> 'polygon' else '[]'::jsonb end) as p
        union all
        select site -> 'town' -> 'center' where site ? 'town'
      loop
        if pg_catalog.jsonb_typeof(point) is distinct from 'object'
           or pg_catalog.jsonb_typeof(point -> 'lat') is distinct from 'number'
           or pg_catalog.jsonb_typeof(point -> 'lng') is distinct from 'number'
           or pg_catalog.abs((point ->> 'lat')::numeric) > 90
           or pg_catalog.abs((point ->> 'lng')::numeric) > 180 then
          return 'holds a clock-in site with a point that is not a latitude and longitude';
        end if;
      end loop;
      if (site ? 'polygon' and pg_catalog.jsonb_typeof(site -> 'polygon') <> 'array')
         or (site ? 'town' and (pg_catalog.jsonb_typeof(site -> 'town') <> 'object'
                                or pg_catalog.jsonb_typeof(site -> 'town' -> 'name') is distinct from 'string')) then
        return 'holds a clock-in site whose boundary or town is not the shape the app writes';
      end if;
    end if;

    if pg_catalog.jsonb_typeof(data -> 'workweekStartsOn') is distinct from 'number' then
      return 'holds a workweek that starts on no day';
    end if;
    n := (data ->> 'workweekStartsOn')::numeric;
    if n <> pg_catalog.trunc(n) or n not between 0 and 6 then
      return 'holds a workweek that starts on no day';
    end if;
    if pg_catalog.jsonb_typeof(data -> 'allowSectionAllOk') is distinct from 'boolean' then
      return 'holds a "Rest are OK" switch that is not on or off';
    end if;
    return null;
  end if;

  return null;
end;
$$;

revoke all on function public.shared_record_problem(text, text, jsonb) from public, anon, authenticated, service_role;

-- The best status a unit may have, from the company's open maintenance
-- requests on it as the server holds them: 'out_of_service' for an open
-- request that red-tagged it (taggedOut), 'defect' for any other open request,
-- else 'ready'. statusFromMrfs in src/store/useStore.ts says the same from a
-- phone's own requests. Read inside push_records, after the call's earlier
-- changes, so a request completed earlier in the same call counts as
-- completed.
create function public.unit_status_floor(company_id uuid, unit_id text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when pg_catalog.bool_or(coalesce(r.data -> 'taggedOut', 'false'::jsonb) = 'true'::jsonb) then 'out_of_service'
    when pg_catalog.count(*) > 0 then 'defect'
    else 'ready'
  end
  from public.records r
  where r.company_id = unit_status_floor.company_id
    and r.kind = 'mrf'
    and not r.deleted
    and (r.data ->> 'equipmentId') = unit_status_floor.unit_id
    and (r.data ->> 'status') is distinct from 'completed';
$$;

revoke all on function public.unit_status_floor(uuid, text) from public, anon, authenticated, service_role;

-- ---- 4. push_records, with checks 3 to 6 ---------------------------------------------------------------

-- As in 20261117000900_request_completion.sql, with the shape of the four
-- kinds checked after the private keys, the version name and the version a
-- change of them was made from checked once the record is found, and a unit's
-- floor checked last. The answer's entry for 'open_request' carries the floor.
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
  unit_floor text;
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
    unit_floor := null;
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

      -- 4, again: the four kinds every phone reads in the shape the phones read
      -- them (readRecord in src/domain/receive.ts), from anyone, the office
      -- dashboard included. A phone passes over a row it cannot read.
      if c_kind = any (seeded) and not removing then
        problem := public.shared_record_problem(c_kind, c_id, c_record);
        if problem is not null then
          reason := 'malformed';
          problem := pg_catalog.format('Change %s %s.', pos, problem);
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

        -- A version name names one content: a change of the four kinds that
        -- names an earlier version of the record with other content is refused,
        -- so a phone that matches a version by its name never takes the wrong one.
        if c_kind = any (seeded) and not removing and exists (
             select 1
             from public.record_history h
             where h.company_id = push_records.company_id
               and h.kind = c_kind
               and h.id = c_id
               and h.rev = c_rev
               and h.data is distinct from c_record) then
          reason := 'malformed';
          problem := pg_catalog.format('Change %s names a version that held other content.', pos);
          exit decide;
        end if;

        if stored.deleted then
          -- Of the four kinds, a change made from a copy the phone had before the
          -- record was taken out. A phone that took the deletion has no base for
          -- the record, so a supervisor adding it again is still taken.
          if not supervisor or (c_kind = any (seeded) and c_base is not null) then
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
        -- The four kinds every phone reads are written only on top of the
        -- version a change was made from, from anyone, a deletion too: a phone
        -- takes the company's version before it sends its own.
        elsif c_kind = any (seeded) and c_base is distinct from stored.rev then
          reason := 'superseded';
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

      -- 7, end: a unit's status is never better than the company's open
      -- maintenance requests on it, as the server holds them, after this call's
      -- earlier changes: an open request that red-tagged it keeps it out of
      -- service, any other open request keeps it marked for a defect. Raising
      -- it is always taken.
      if c_kind = 'equipment' and not removing then
        unit_floor := public.unit_status_floor(push_records.company_id, c_id);
        if (case c_record ->> 'status' when 'out_of_service' then 2 when 'defect' then 1 else 0 end)
           < (case unit_floor when 'out_of_service' then 2 when 'defect' then 1 else 0 end) then
          reason := 'open_request';
          exit decide;
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
      if reason = 'open_request' then
        entry := entry || pg_catalog.jsonb_build_object('floor', unit_floor);
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
