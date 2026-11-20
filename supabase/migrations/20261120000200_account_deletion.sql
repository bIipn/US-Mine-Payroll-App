-- MineMuster: deleting an account.
--
-- This migration is new; it never edits an applied one. A person deletes their
-- MineMuster sign-in in the app (More, then Delete my account) or on the office
-- dashboard. The delete itself is Supabase Auth's admin delete, a hard delete,
-- made by the delete-account edge function with the server key: the auth.users
-- row goes, and the foreign keys already in place do the rest. Their join
-- requests (with their notifications), their join holds and their send counts
-- (record_usage) are deleted with the account; their roster rows, the records
-- they sent and every version of those stay with the company, with only the
-- link to the account cleared (roster.user_id and claimed_at, companies
-- .created_by, records.created_by and updated_by, record_history.by and
-- join_requests.decided_by). The records are the company's, and the law has a
-- mine keep some of them: its pre shift exam records for at least a year (30
-- CFR 56.18002(d)).
--
-- A company always keeps a supervisor who can sign in
-- (roster_keeps_a_supervisor), and the hard delete of the last one is refused
-- by that guard through the foreign key, atomically. So the edge function asks
-- first, and the last supervisor either makes someone else a supervisor (the
-- dashboard's Roster page) or, when nobody else on the roster can sign in,
-- closes the company:
--
--  account_deletion_check()  For each company the caller is an active member
--      of: its id and name, the caller's role, whether the caller is the last
--      supervisor who can sign in there, who could take over (the other active
--      rows whose account can still sign in, named only to a supervisor), and
--      for a supervisor how many of the company's subscriptions Stripe still
--      charges (billing_standing's running). An account Supabase Auth has
--      banned or soft-deleted is a member of nothing, so it gets an empty list.
--
--  close_company(p_company_id, p_company_name)  A supervisor of the company,
--      with its name typed as it is (capitals and spacing aside), deletes it,
--      and with it everything that is the company's: its roster, requests,
--      notifications, holds, records and their history, counters and billing
--      rows, by the cascade the README documents. Only when nobody else on its
--      roster can sign in (an active row with an account Supabase Auth has
--      neither banned nor soft-deleted), so it is never a way around handing
--      over; and only when nothing is being charged, so a subscription is
--      cancelled in Stripe first. It deletes no account.
--
-- A refusal of close_company carries a hint saying which it is, for the edge
-- function to read: wrong_name (22023), someone_can_take_over and
-- subscription_running (both PT409). Not a supervisor of the company, or no
-- such company, is PT404 with no hint, as from every supervisor function.
--
-- Neither takes an account id: each answers for the signed-in caller only.
-- Both are security definer, search pg_catalog first and the temporary schema
-- last, and are callable by authenticated alone.

create function public.account_deletion_check()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'role', mine.role,
      'last_supervisor', mine.role = 'supervisor' and not exists (
        select 1
        from public.roster r
        join auth.users u on u.id = r.user_id
        where r.company_id = c.id
          and r.id <> mine.id
          and r.role = 'supervisor'
          and r.active
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= pg_catalog.now())
      ),
      'successors', case when mine.role = 'supervisor' then coalesce((
        select pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object('roster_id', r.id, 'first_name', r.first_name, 'last_name', r.last_name)
                 order by r.last_name, r.first_name, r.id)
        from public.roster r
        join auth.users u on u.id = r.user_id
        where r.company_id = c.id
          and r.id <> mine.id
          and r.user_id <> caller
          and r.active
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= pg_catalog.now())
      ), '[]'::jsonb) else '[]'::jsonb end,
      'running', case when mine.role = 'supervisor'
        then (public.billing_standing(c.id) ->> 'running')::integer end
    ) order by c.name, c.id)
    from public.roster mine
    join public.companies c on c.id = mine.company_id
    where mine.user_id = caller
      and mine.active
      and c.id = any ((select public.member_company_ids())::uuid[])
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.account_deletion_check() from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_check() to authenticated;

create function public.close_company(p_company_id uuid, p_company_name text)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  caller uuid := (select auth.uid());
  held text;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;
  if p_company_id is null or not public.is_supervisor(p_company_id) then
    raise exception using errcode = 'PT404', message = 'No such company.';
  end if;

  -- Hold the company and its roster still until the commit: no claim, release,
  -- role change or new row in between.
  select c.name into held from public.companies c where c.id = p_company_id for update;
  perform 1 from public.roster r where r.company_id = p_company_id for update;
  if not public.is_supervisor(p_company_id) then
    raise exception using errcode = 'PT404', message = 'No such company.';
  end if;

  if public.fold_name(public.clean_text(coalesce(p_company_name, ''))) is distinct from public.fold_name(held) then
    raise exception using errcode = '22023', message = 'Type the company''s name as it is to close it.', hint = 'wrong_name';
  end if;

  if exists (
    select 1
    from public.roster r
    join auth.users u on u.id = r.user_id
    where r.company_id = p_company_id
      and r.active
      and r.user_id <> caller
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
  ) then
    raise exception using errcode = 'PT409', message = 'Someone else can take over this company. Make them a supervisor instead.', hint = 'someone_can_take_over';
  end if;

  if (public.billing_standing(p_company_id) ->> 'running')::integer > 0 then
    raise exception using errcode = 'PT409', message = 'The company''s subscription is still running. Cancel it first.', hint = 'subscription_running';
  end if;

  -- The cascade takes its roster, requests, notifications, holds, guard row,
  -- records and their history, counters and billing rows with it.
  delete from public.companies c where c.id = p_company_id;
end;
$$;

revoke all on function public.close_company(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.close_company(uuid, text) to authenticated;
