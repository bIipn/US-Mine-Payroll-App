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
-- dashboard's Roster page) or, when nobody else can take over, closes the
-- company:
--
--  account_deletion_check()  For each company the caller is an active member
--      of: its id and name, the caller's role, whether the caller is the last
--      supervisor who can sign in there (as the guard counts them), who could
--      take over now (the other active rows whose account can still sign in,
--      named only to a supervisor), whether the caller may close it
--      (can_close) and, when only people who left lately stop that, from when
--      (close_from), and for a supervisor how many of the company's
--      subscriptions Stripe still charges (billing_standing's running). An
--      account Supabase Auth has banned or soft-deleted is a member of nothing,
--      so it gets an empty list.
--
--  close_company(p_company_id, p_company_name)  A supervisor of the company,
--      with its name typed as it is (capitals and spacing aside) and their
--      password typed in the last ten minutes, deletes it, and with it
--      everything that is the company's: its roster, requests, notifications,
--      holds, records and their history, counters and billing rows, by the
--      cascade the README documents. It deletes no account.
--
-- Closing is never a way around handing over. One supervisor can take every
-- other row off the roster, or delete it, and release any claim, so who could
-- take over is not only who is active now. Closing waits while anyone else
-- could still take over or come back (closing_waits_until):
--   - another row of the company holds an account that can still sign in (one
--     Supabase Auth has neither banned nor soft-deleted), and is active or was
--     taken off the roster in the last 30 days. Taking a row off keeps its
--     account; roster.inactive_since, written by a trigger and by no client,
--     says when;
--   - such an account was released from a row, or its row deleted, in the last
--     30 days (a 'released' join hold, which only approving that account's own
--     request removes).
-- So one supervisor acting alone cannot close a company others still use: the
-- people taken off have 30 days to notice and ask MineMuster to stop it. A
-- supervisor whose crew has truly gone can close it once they have been gone
-- for 30 days. Closing also waits while a subscription is still charged, so it
-- is cancelled in Stripe first.
--
-- The password: close_company needs a password sign-in in the token's amr
-- claim, made in the last ten minutes (password_typed_lately), as the edge
-- function needs of the token it is given. Supabase Auth keeps each sign-in
-- method's time there, and a refreshed token keeps the first one's, so a
-- token on a lost phone or a browser left open closes nothing.
--
-- A refusal of close_company carries a hint saying which it is, for the edge
-- function to read: password_needed (42501), wrong_name (22023),
-- someone_can_take_over and subscription_running (both PT409). Not a supervisor
-- of the company, or no such company, is PT404 with no hint, as from every
-- supervisor function.
--
-- Neither takes an account id: each answers for the signed-in caller only.
-- Both are security definer, search pg_catalog first and the temporary schema
-- last, and are callable by authenticated alone. The helpers are callable by
-- no API role.

-- When a row was taken off the roster: set when it is, cleared when it is put
-- back. No client writes it (the roster's insert and update grants name their
-- columns), and closing reads it.
alter table public.roster add column inactive_since timestamptz;

-- Rows taken off before now: from now, the later it could be.
update public.roster set inactive_since = pg_catalog.now() where not active;

alter table public.roster add constraint roster_inactive_since_check check (active = (inactive_since is null));

-- Like every column of the roster, it keeps no planner statistics (migration
-- 20261116002200): an estimate says nothing about another company's rows.
alter table public.roster alter column inactive_since set statistics 0;

create function public.roster_note_inactive_since()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.active then
    new.inactive_since := null;
  elsif tg_op = 'INSERT' or old.active then
    new.inactive_since := pg_catalog.now();
  else
    new.inactive_since := old.inactive_since;
  end if;
  return new;
end;
$$;

revoke all on function public.roster_note_inactive_since() from public, anon, authenticated, service_role;

create trigger roster_note_inactive_since
  before insert or update on public.roster
  for each row execute function public.roster_note_inactive_since();

-- Until when someone other than the caller could still take over the company
-- or come back to it, so closing it waits: 'infinity' while another row is
-- active with an account that can sign in, the end of the 30 days when only
-- people who left lately are left, and null when nobody could.
create function public.closing_waits_until(p_company_id uuid, p_caller uuid)
returns timestamptz
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.max(waits.until)
  from (
    select case when r.active then 'infinity'::timestamptz else r.inactive_since + interval '30 days' end as until
    from public.roster r
    join auth.users u on u.id = r.user_id
    where r.company_id = p_company_id
      and r.user_id <> p_caller
      and (r.active or r.inactive_since > pg_catalog.now() - interval '30 days')
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
    union all
    select h.created_at + interval '30 days'
    from public.join_holds h
    join auth.users u on u.id = h.user_id
    where h.company_id = p_company_id
      and h.kind = 'released'
      and h.user_id <> p_caller
      and h.created_at > pg_catalog.now() - interval '30 days'
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
  ) waits
$$;

revoke all on function public.closing_waits_until(uuid, uuid) from public, anon, authenticated, service_role;

-- The caller typed their password in the last ten minutes: a password entry in
-- the token's amr claim, with its time (Unix seconds) no older than 600 s and
-- no more than a minute ahead of the server's clock.
create function public.password_typed_lately()
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof((select auth.jwt()) -> 'amr') = 'array'
        then (select auth.jwt()) -> 'amr'
        else '[]'::jsonb
      end
    ) a
    where pg_catalog.jsonb_typeof(a) = 'object'
      and a ->> 'method' = 'password'
      and pg_catalog.jsonb_typeof(a -> 'timestamp') = 'number'
      and (a ->> 'timestamp')::numeric
        between pg_catalog.date_part('epoch', pg_catalog.now())::numeric - 600
            and pg_catalog.date_part('epoch', pg_catalog.now())::numeric + 60
  )
$$;

revoke all on function public.password_typed_lately() from public, anon, authenticated, service_role;

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
      -- As roster_keeps_a_supervisor counts them: the admin delete is refused
      -- exactly when this is true.
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
      'can_close', mine.role = 'supervisor' and waits.until is null,
      'close_from', case when waits.until < 'infinity'::timestamptz then waits.until end,
      'running', case when mine.role = 'supervisor'
        then (public.billing_standing(c.id) ->> 'running')::integer end
    ) order by c.name, c.id)
    from public.roster mine
    join public.companies c on c.id = mine.company_id
    cross join lateral (
      select case when mine.role = 'supervisor' then public.closing_waits_until(c.id, caller) end as until
    ) waits
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
  if not public.password_typed_lately() then
    raise exception using errcode = '42501', message = 'Type your password again to close a company.', hint = 'password_needed';
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

  if public.closing_waits_until(p_company_id, caller) is not null then
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
