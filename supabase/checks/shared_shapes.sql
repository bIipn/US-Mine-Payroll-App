-- Read-only: the records already on a server that migration
-- 20261120000100_office_changes_reach_phones.sql would refuse the next time
-- they change, and that a phone would pass over. Run it against the live
-- project before that migration is applied there, in the SQL editor or with
-- `psql -f`, and fix every row it names on the dashboard (or decide with the
-- owner) first.
--
-- It changes nothing that lasts: the two functions are made in this session's
-- temporary schema and go when the session ends. They are the migration's own,
-- copied here unchanged (office_changes.db.mjs checks they still match).
--
-- First list: a record of the four kinds every phone reads that is not in the
-- shape the phones read. Second list: a unit whose status is better than the
-- company's open maintenance requests on it.

create function pg_temp.shared_record_problem(kind text, id text, data jsonb)
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

create function pg_temp.unit_status_floor(company_id uuid, unit_id text)
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

select r.company_id, r.kind, r.id, pg_temp.shared_record_problem(r.kind, r.id, r.data) as problem
from public.records r
where r.kind in ('settings', 'employee', 'equipment', 'areaSheet')
  and not r.deleted
  and pg_temp.shared_record_problem(r.kind, r.id, r.data) is not null
order by r.company_id, r.kind, r.id;

select r.company_id, r.id, r.data ->> 'unit' as unit, r.data ->> 'status' as status,
       pg_temp.unit_status_floor(r.company_id, r.id) as floor
from public.records r
where r.kind = 'equipment'
  and not r.deleted
  and (case r.data ->> 'status' when 'out_of_service' then 2 when 'defect' then 1 else 0 end)
      < (case pg_temp.unit_status_floor(r.company_id, r.id) when 'out_of_service' then 2 when 'defect' then 1 else 0 end)
order by r.company_id, r.id;
