-- MineMuster, step 2: who reads the records.
--
-- Nobody writes records or record_history through the API: push_records does
-- (next migration). Reading them, through the table or PostgREST:
--
--  * A supervisor reads every record of the company, and every version of each.
--  * Any member reads what the whole crew works from: the company's settings,
--    its roster (employee), the fleet (equipment), the area sheets, the
--    equipment checklists (inspection), operating logs (opLog), pre shift
--    exams and maintenance requests (mrf), and every version of those.
--  * A member reads the shifts and denied punches their own account sent
--    first, and every version of those, and no one else's. Not what the
--    account sent while it was a supervisor (created_by_supervisor): an
--    account made an employee no longer reads the shifts it entered for other
--    people. Paid leave is a supervisor's to enter, so a member reads none.
--  * Nobody reads another company's records, whatever their role there. A
--    deleted record is read like any other, so a phone learns it is gone.
--  * anon reads nothing. The server key reads everything, as Supabase gives it,
--    and writes neither table (previous migration). Nobody reads
--    record_counters or record_usage through the API but the server key.
--
-- my_companies() lists the companies the caller belongs to, with their role in
-- each, for the app and the office dashboard to pick one.

grant select on table public.records to authenticated;
grant select on table public.record_history to authenticated;

-- As every policy here does (migration 20261116002300), each compares the
-- row's company with the caller's own companies, worked out once per
-- statement, and calls no function on the row: the comparison is an index
-- condition, so a request reads no row of another company and takes no longer
-- for one with more records. Supervisors are members, so the first test holds
-- for both, and what a member may not read is filtered from their own
-- company's rows only.
create policy records_select_members
  on public.records for select
  to authenticated
  using (
    company_id = any ((select public.member_company_ids())::uuid[])
    and (
      company_id = any ((select public.supervisor_company_ids())::uuid[])
      or kind in ('settings', 'employee', 'equipment', 'areaSheet', 'inspection', 'opLog', 'exam', 'mrf')
      or (kind in ('shift', 'denied') and created_by = (select auth.uid()) and not created_by_supervisor)
    )
  );

-- A version is read by whoever reads its record. The record's own policy
-- applies inside the subquery too, so it can only find the caller's own.
create policy record_history_select_members
  on public.record_history for select
  to authenticated
  using (
    company_id = any ((select public.member_company_ids())::uuid[])
    and (
      company_id = any ((select public.supervisor_company_ids())::uuid[])
      or kind in ('settings', 'employee', 'equipment', 'areaSheet', 'inspection', 'opLog', 'exam', 'mrf')
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

-- The companies the caller is a member of: the id, name and state of each,
-- the caller's role there, and the join code where the caller is a supervisor
-- (null where they are not), ordered by name. Membership is is_member's: an
-- active row, held by an account Supabase Auth has not banned or soft-deleted
-- (migration 20261116002300).
create function public.my_companies()
returns table (
  id uuid,
  name text,
  state text,
  role text,
  join_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  return query
    select c.id, c.name, c.state, r.role,
           case when r.role = 'supervisor' then c.join_code end
    from public.roster r
    join public.companies c on c.id = r.company_id
    join auth.users u on u.id = r.user_id
    where r.user_id = caller
      and r.active
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
    order by c.name, c.id;
end;
$$;

revoke all on function public.my_companies() from public, anon, authenticated, service_role;
grant execute on function public.my_companies() to authenticated;
