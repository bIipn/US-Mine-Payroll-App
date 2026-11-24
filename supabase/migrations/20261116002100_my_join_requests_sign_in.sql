-- MineMuster, step 1 hardening: my_join_requests refuses when nobody is signed in.
--
-- This migration is new; it never edits an applied one. The README promises
-- that every API function but company_by_code refuses (42501) when nobody is
-- signed in. my_join_requests answered an empty list instead. It now refuses,
-- like the others. It still returns only the caller's own requests, without
-- decided_by or roster_id, and now includes requests settled as 'withdrawn'.
--
-- is_member and is_supervisor are the exception, on purpose: the row level
-- security policies call them, so they answer false when nobody is signed in
-- rather than raise.

create or replace function public.my_join_requests()
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
    select j.id, j.company_id, j.first_name, j.last_name, j.reason, j.status, j.created_at, j.decided_at
    from public.join_requests j
    where j.user_id = caller
    order by j.created_at, j.id;
end;
$$;

revoke all on function public.my_join_requests() from public, anon, authenticated, service_role;
grant execute on function public.my_join_requests() to authenticated;
