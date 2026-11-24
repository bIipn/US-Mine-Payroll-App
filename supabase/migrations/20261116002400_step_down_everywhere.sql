-- MineMuster, step 1 hardening: the server takes an account's supervisor role
-- away before it bans or soft-deletes the account.
--
-- This migration is new; it never edits an applied one. A soft delete or a ban
-- is a change to Supabase's own auth.users, which these migrations never put a
-- trigger on, so the last-supervisor guard cannot refuse it. The README told
-- the server to ask is_last_supervisor(user_id) first and ban only when it is
-- false. That is a check and then an action: the ban is a Supabase Auth call
-- outside the database's transaction, so nothing holds the answer in place in
-- between. Two server requests for the two supervisors of one company (two
-- admins, or a batch job that checks every account before banning any) each
-- got false, both bans went through, and the company was left with nobody who
-- can sign in and let people in.
--
-- step_down_everywhere(user_id) makes the account an employee on every active
-- supervisor row it holds, in one statement, so the guard has its say there:
-- it writes a row per company (company_supervisor_guard) before it counts, so
-- two such calls for the supervisors of one company take turns and the second
-- is refused (23514; 40001 at REPEATABLE READ or SERIALIZABLE). The server
-- bans or soft-deletes an account only once this has returned. Returns how
-- many rows it changed. is_last_supervisor stays, to show which accounts are
-- the last supervisor somewhere.
--
-- Once an account is banned or soft-deleted it is no member and no supervisor
-- anywhere (migration 20261116002300), so a supervisor row it still holds gives
-- it nothing; and it is not counted by the guard, so it cannot be the one the
-- company relies on.

create function public.step_down_everywhere(user_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  stepped integer;
begin
  if step_down_everywhere.user_id is null then
    raise exception using errcode = '22023', message = 'Name the account to step down.';
  end if;

  update public.roster r
  set role = 'employee'
  where r.user_id = step_down_everywhere.user_id
    and r.role = 'supervisor'
    and r.active;
  get diagnostics stepped = row_count;
  return stepped;
end;
$$;

revoke all on function public.step_down_everywhere(uuid) from public, anon, authenticated, service_role;
-- The server's key only, like is_last_supervisor.
grant execute on function public.step_down_everywhere(uuid) to service_role;
