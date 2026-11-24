-- MineMuster, step 1: who may read and change what through the API.
--
-- Row level security has been on for every table since it was made, with
-- nothing granted. This migration grants what each role may do and adds the
-- policies that pick the rows.
--
--  * anon (nobody signed in) reads and writes nothing. It can only call
--    company_by_code.
--  * authenticated (a signed-in account) reaches a company's rows only as a
--    member of that company, and changes them only as its supervisor.
--  * Joining, claiming, requests, notifications and the join code are written
--    only by the functions.
--  * service_role keeps the access a Supabase project gives it. It is the
--    server's key, never the app's, and bypasses row level security.
--
-- Column privileges keep the fields only the functions may write out of
-- reach: a statement that names one fails with "permission denied".

-- Companies ------------------------------------------------------------------
-- Members read their companies. Supervisors change the settings. join_code
-- changes only through rotate_join_code, and id, created_by, created_at and
-- updated_at never through the API. Companies are made by create_company and
-- never inserted or deleted through the API.

grant select on table public.companies to authenticated;
grant update (name, state, timezone, logo_path, pay_period) on table public.companies to authenticated;

create policy companies_select_members
  on public.companies for select
  to authenticated
  using (public.is_member(id));

create policy companies_update_supervisors
  on public.companies for update
  to authenticated
  using (public.is_supervisor(id))
  with check (public.is_supervisor(id));

-- Roster ---------------------------------------------------------------------
-- Members read their company's roster. Supervisors add, change and remove
-- rows. Nobody writes user_id or claimed_at through the API, and a row never
-- moves to another company. A supervisor may give a row the supervisor role.

grant select on table public.roster to authenticated;
grant insert (company_id, first_name, last_name, title, role, active) on table public.roster to authenticated;
grant update (first_name, last_name, title, role, active) on table public.roster to authenticated;
grant delete on table public.roster to authenticated;

create policy roster_select_members
  on public.roster for select
  to authenticated
  using (public.is_member(company_id));

create policy roster_insert_supervisors
  on public.roster for insert
  to authenticated
  with check (public.is_supervisor(company_id));

create policy roster_update_supervisors
  on public.roster for update
  to authenticated
  using (public.is_supervisor(company_id))
  with check (public.is_supervisor(company_id));

create policy roster_delete_supervisors
  on public.roster for delete
  to authenticated
  using (public.is_supervisor(company_id));

-- Join requests --------------------------------------------------------------
-- A person reads their own requests, and a supervisor reads the company's.
-- Requests are made by join_company and decided by approve_join_request and
-- deny_join_request, never written through the API.

grant select on table public.join_requests to authenticated;

create policy join_requests_select_own_or_supervisors
  on public.join_requests for select
  to authenticated
  using (user_id = (select auth.uid()) or public.is_supervisor(company_id));

-- Notifications --------------------------------------------------------------
-- A company's supervisors read its notifications and mark them read. Nothing
-- else is written through the API.

grant select on table public.notifications to authenticated;
grant update (read_at) on table public.notifications to authenticated;

create policy notifications_select_supervisors
  on public.notifications for select
  to authenticated
  using (public.is_supervisor(company_id));

create policy notifications_update_supervisors
  on public.notifications for update
  to authenticated
  using (public.is_supervisor(company_id))
  with check (public.is_supervisor(company_id));
