-- MineMuster, step 1: who belongs to a company.
--
-- A member of a company is an account that holds an active row on its roster.
-- A supervisor is a member whose row has the supervisor role. Both helpers go
-- by auth.uid(), so with nobody signed in they are false. They are security
-- definer so the row level security policies can call them without the
-- roster's own policies getting in the way, and they say nothing about any
-- company but whether the caller belongs to it.

create function public.is_member(company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.roster r
    where r.company_id = is_member.company_id
      and r.user_id = auth.uid()
      and r.active
  );
$$;

create function public.is_supervisor(company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.roster r
    where r.company_id = is_supervisor.company_id
      and r.user_id = auth.uid()
      and r.active
      and r.role = 'supervisor'
  );
$$;

revoke all on function public.is_member(uuid) from public, anon, authenticated, service_role;
revoke all on function public.is_supervisor(uuid) from public, anon, authenticated, service_role;
-- The policies run them as the signed-in user.
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_supervisor(uuid) to authenticated;
