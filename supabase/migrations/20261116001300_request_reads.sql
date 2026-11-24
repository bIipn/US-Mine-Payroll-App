-- MineMuster, step 1 hardening: how a person reads their own join requests.
--
-- The old join_requests select policy let an account read every column of its
-- own requests forever, in any company, even after it was denied or taken off
-- that company's roster. Those columns include decided_by (the Auth id of the
-- supervisor who decided) and roster_id (a roster row's id). So a non-member
-- kept reading ids of another company's people.
--
-- The policy now lets only a company's supervisors read its requests through
-- the table. A requester reads their own requests through my_join_requests(),
-- which returns just what they need and never decided_by or roster_id.

drop policy join_requests_select_own_or_supervisors on public.join_requests;

create policy join_requests_select_supervisors
  on public.join_requests for select
  to authenticated
  using (public.is_supervisor(company_id));

-- The caller's own join requests, without the ids of the people who decided
-- them or the rows they were approved onto. Security definer so it reads past
-- the supervisors-only policy, and only ever for auth.uid().
create function public.my_join_requests()
returns table (
  id uuid,
  company_id uuid,
  first_name text,
  last_name text,
  reason text,
  status text,
  created_at timestamptz,
  decided_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.company_id, j.first_name, j.last_name, j.reason, j.status, j.created_at, j.decided_at
  from public.join_requests j
  where j.user_id = auth.uid()
  order by j.created_at, j.id;
$$;

revoke all on function public.my_join_requests() from public, anon, authenticated, service_role;
grant execute on function public.my_join_requests() to authenticated;
