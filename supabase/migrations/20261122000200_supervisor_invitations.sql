-- MineMuster: supervisor invitations, and the roster's sign-in states.
--
-- This migration is new; it never edits an applied one. A supervisor invites
-- another supervisor to the dashboard by email, from the Roster page, onto a
-- row of the company's roster: a supervisor's row nobody holds yet, a crew row
-- nobody holds yet, or a crew row a passcode account holds (a crew member made
-- a supervisor: supervisors sign in with email). Nobody is put on the row
-- until the invited person accepts, signed in with that same address, as
-- Supabase Auth has confirmed it. Until then the keep-a-supervisor guard
-- counts nobody for it: it counts accounts on rows, and an invitation puts
-- none on one. The supervisor-tools edge function sends the invite email
-- through Supabase Auth; this is the database's side.
--
--   supervisor_invitations  One row for each invitation: the company, the row,
--       the address, who sent it and when, until when it is good (7 days), and
--       when it was accepted, and by whom, or cancelled. No API role reads or
--       writes it, the server key included.
--
-- An invitation is open until it is accepted or cancelled, and a row has at
-- most one open invitation: a new one cancels the one before. An open one past
-- its 7 days is neither sent again nor accepted; inviting again replaces it.
--
-- The functions, each security definer, searching pg_catalog first and the
-- temporary schema last:
--
--   invite_supervisor(p_roster_id, p_email)  For a supervisor of the row's
--       company: an invitation onto an active row no email account holds.
--   resend_supervisor_invitation(p_invitation_id)  For a supervisor: 7 days
--       more for an open invitation that has not expired, so the email can go
--       again.
--   cancel_supervisor_invitation(p_invitation_id)  For a supervisor.
--   account_for_email(p_email)  For the server key: the account an address
--       belongs to, if any, so supervisor-tools asks Supabase Auth to send an
--       invite email only to an address with no account.
--   my_supervisor_invitations()  The open, unexpired invitations to the
--       caller's confirmed address.
--   accept_supervisor_invitation(p_invitation_id)  The invited person takes
--       the row: a passcode account on it is let go of, the row is made a
--       supervisor's and the caller's account is put on it.
--   roster_sign_ins(p_company_id)  For a supervisor of the company: each row's
--       sign-in, its lock and its open invitation, for the Roster page.
--
-- They refuse as release_roster_claim does: 42501 only when nobody is signed
-- in; PT404 for a row or an invitation that is not there, or is of a company
-- the caller does not supervise, word for word the same either way, so a
-- refusal never tells a real id from a made-up one (and roster_sign_ins as
-- company_billing does, for a company); and PT409, with a hint, for one in a
-- state that will not do:
--   row_taken          the row is taken off the roster, or an email account
--                      holds it;
--   invitation_closed  the invitation expired, was cancelled or was accepted;
--   wrong_email        the accepting account's confirmed address is not the
--                      invited one, or it has none;
--   already_on_roster  the accepting account already holds a row of that
--                      company, on the roster or taken off it.
-- Something that is not an email address is refused with 22023, hint
-- email_invalid. Addresses are kept and compared trimmed and in lower case
-- (email_key).

-- ---- The invitations --------------------------------------------------------------------------------

create table public.supervisor_invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  roster_id uuid not null,
  -- The address as typed, trimmed and in lower case (email_key).
  email text not null,
  -- The supervisor who sent it. Cleared if that account is deleted.
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Good for 7 days, and for 7 more from when it is sent again.
  expires_at timestamptz not null default now() + interval '7 days',
  -- When it was accepted, and the account that accepted it (cleared if that
  -- account is deleted); or when it was cancelled.
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  cancelled_at timestamptz,

  -- The row is one of the same company's, and its invitations go with it.
  constraint supervisor_invitations_row_same_company foreign key (company_id, roster_id)
    references public.roster (company_id, id) on delete cascade,
  constraint supervisor_invitations_email_length check (pg_catalog.char_length(email) between 3 and 254),
  -- Accepted or cancelled, never both.
  constraint supervisor_invitations_closed_once check (accepted_at is null or cancelled_at is null)
);

-- One open invitation per row.
create unique index supervisor_invitations_one_open on public.supervisor_invitations (roster_id)
  where accepted_at is null and cancelled_at is null;
-- A row's invitations, for when the row or its company is deleted.
create index supervisor_invitations_row_idx on public.supervisor_invitations (company_id, roster_id);
-- The open invitations to an address, for my_supervisor_invitations.
create index supervisor_invitations_email_idx on public.supervisor_invitations (email)
  where accepted_at is null and cancelled_at is null;
-- An account's invitations, for when the account is deleted.
create index supervisor_invitations_invited_by_idx on public.supervisor_invitations (invited_by)
  where invited_by is not null;
create index supervisor_invitations_accepted_by_idx on public.supervisor_invitations (accepted_by)
  where accepted_by is not null;

alter table public.supervisor_invitations enable row level security;

-- No API role at all, the server key included, as crew_logins. Supabase grants
-- every API role on a new table in public, so it is taken back here. The
-- functions below keep it, as its owner.
revoke all on table public.supervisor_invitations from public, anon, authenticated, service_role;

-- No planner statistics, before it holds data (see migration 20261116002200
-- and the README).
do $$
declare
  col record;
begin
  for col in
    select a.attname
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.supervisor_invitations'::pg_catalog.regclass
      and a.attnum > 0
      and not a.attisdropped
    order by a.attnum
  loop
    execute pg_catalog.format('alter table public.supervisor_invitations alter column %I set statistics 0', col.attname);
  end loop;
end;
$$;

-- ---- What the functions share -----------------------------------------------------------------------

-- An email address as it is kept and compared: trimmed, with its runs of
-- spaces closed up as a name's are (clean_text), and in lower case. However
-- Supabase Auth keeps an address, and however a supervisor typed it, the two
-- read the same. No API role.
create function public.email_key(p_email text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.lower(public.clean_text(p_email))
$$;

revoke all on function public.email_key(text) from public, anon, authenticated, service_role;

-- An account's confirmed address, as email_key keeps it: the address of its
-- auth.users row once Supabase Auth has confirmed it, while the account can
-- still sign in, neither soft-deleted nor banned. That is how the
-- keep-a-supervisor guard and membership count an account: one banned or
-- soft-deleted has no powers left, though a token it holds still works. Null
-- for an account with no address, one not confirmed yet, an anonymous sign-in
-- and an account that can no longer sign in. No API role.
create function public.confirmed_email_of(p_user uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select public.email_key(u.email)
  from auth.users u
  where u.id = p_user
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.now())
$$;

revoke all on function public.confirmed_email_of(uuid) from public, anon, authenticated, service_role;

-- Whether a roster row can be given to an invited supervisor: it is on the
-- roster, and nobody holds it, or a passcode account (one with a crew_logins
-- row) holds it, to be let go of when the invitation is accepted. A row an
-- email account holds is that person's already: a supervisor makes them a
-- supervisor with a role change, and no invitation. No API role.
create function public.row_open_to_invitation(p_active boolean, p_user uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(p_active, false)
     and (p_user is null or exists (select 1 from public.crew_logins l where l.user_id = p_user))
$$;

revoke all on function public.row_open_to_invitation(boolean, uuid) from public, anon, authenticated, service_role;

-- ---- Inviting ---------------------------------------------------------------------------------------

-- An invitation onto a roster row, for a supervisor of the row's company: the
-- row must be on the roster with no email account on it
-- (row_open_to_invitation). The row's open invitation, if it has one, is
-- cancelled, and a new one is made, good for 7 days. Nobody is put on the row.
-- It answers {invitation_id, email, company_name}: the address as kept, for
-- the supervisor-tools function to send the invite email to. The answer is
-- the same whatever account the address belongs to, or none, so the dashboard
-- never tells whether an address has an account.
--
-- It refuses, in this order:
--   42501  nobody signed in;
--   22023  (hint email_invalid) something that is not an email address. One
--          far over what an address can be is not cleaned at all, so a huge
--          one costs nothing. Cleaned (email_key), it must be at most 254
--          characters with no control or invisible character, and be a part
--          of 1 to 64 characters before an @ and a domain with a dot, as the
--          contact form reads an address;
--   PT404  no such row among the companies the caller supervises;
--   PT409  row_taken.
--
-- It locks the row's open invitation, then the row, the order accepting takes
-- them in: an invitation and an acceptance onto one row take turns, and never
-- each hold what the other waits for.
create function public.invite_supervisor(p_roster_id uuid, p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  caller uuid := auth.uid();
  address text;
  target public.roster;
  made public.supervisor_invitations;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  address := case when pg_catalog.octet_length(p_email) <= 1500 then public.email_key(p_email) end;
  if address is null
     or pg_catalog.char_length(address) > 254
     or public.has_hidden_characters(address)
     or address !~ '^[^@ ]{1,64}@[^@ .]+(\.[^@ .]+)+$' then
    raise exception using
      errcode = '22023',
      message = 'Type the email address to send the invitation to.',
      hint = 'email_invalid';
  end if;

  perform 1
  from public.supervisor_invitations i
  where i.roster_id = p_roster_id
    and i.accepted_at is null
    and i.cancelled_at is null
    and public.is_supervisor(i.company_id)
  for update;

  select r.* into target
  from public.roster r
  where r.id = p_roster_id
    and public.is_supervisor(r.company_id)
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'No such roster row.';
  end if;
  if not public.row_open_to_invitation(target.active, target.user_id) then
    raise exception using
      errcode = 'PT409',
      message = 'That roster row is taken off the roster or held by an email sign-in.',
      hint = 'row_taken';
  end if;

  update public.supervisor_invitations i
  set cancelled_at = pg_catalog.now()
  where i.roster_id = target.id
    and i.accepted_at is null
    and i.cancelled_at is null;

  insert into public.supervisor_invitations (company_id, roster_id, email, invited_by)
  values (target.company_id, target.id, address, caller)
  returning * into made;

  return pg_catalog.jsonb_build_object(
    'invitation_id', made.id,
    'email', made.email,
    'company_name', (select c.name from public.companies c where c.id = made.company_id)
  );
end;
$$;

-- ---- Sending again ----------------------------------------------------------------------------------

-- 7 days more for an invitation, from now, for a supervisor of its company,
-- so the email can go again. It answers {email, company_name}, for the
-- supervisor-tools function to send it. The invitation must be open and
-- unexpired (one that has expired is replaced by inviting again), and its row
-- still open to an invitation. It refuses, in this order:
--   42501  nobody signed in;
--   PT404  no such invitation among the companies the caller supervises;
--   PT409  invitation_closed;
--   PT409  row_taken.
-- The invitation, then its row, are locked, as accepting locks them.
create function public.resend_supervisor_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  caller uuid := auth.uid();
  invitation public.supervisor_invitations;
  target public.roster;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  select i.* into invitation
  from public.supervisor_invitations i
  where i.id = p_invitation_id
    and public.is_supervisor(i.company_id)
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'No such invitation.';
  end if;
  if invitation.accepted_at is not null
     or invitation.cancelled_at is not null
     or invitation.expires_at <= pg_catalog.now() then
    raise exception using
      errcode = 'PT409',
      message = 'That invitation has expired, or was cancelled or accepted.',
      hint = 'invitation_closed';
  end if;

  select r.* into target
  from public.roster r
  where r.company_id = invitation.company_id
    and r.id = invitation.roster_id
  for update;
  if not public.row_open_to_invitation(target.active, target.user_id) then
    raise exception using
      errcode = 'PT409',
      message = 'That roster row is taken off the roster or held by an email sign-in.',
      hint = 'row_taken';
  end if;

  update public.supervisor_invitations i
  set expires_at = pg_catalog.now() + interval '7 days'
  where i.id = invitation.id;

  return pg_catalog.jsonb_build_object(
    'email', invitation.email,
    'company_name', (select c.name from public.companies c where c.id = invitation.company_id)
  );
end;
$$;

-- ---- Cancelling -------------------------------------------------------------------------------------

-- Cancel an invitation, for a supervisor of its company. One cancelled already
-- stays as it was, with the time it was first cancelled, and one that has
-- expired is cancelled like any open one. It refuses, in this order:
--   42501  nobody signed in;
--   PT404  no such invitation among the companies the caller supervises;
--   PT409  invitation_closed, for one already accepted: the person is on the
--          row, and a supervisor changes the row instead.
create function public.cancel_supervisor_invitation(p_invitation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  caller uuid := auth.uid();
  invitation public.supervisor_invitations;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  select i.* into invitation
  from public.supervisor_invitations i
  where i.id = p_invitation_id
    and public.is_supervisor(i.company_id)
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'No such invitation.';
  end if;
  if invitation.accepted_at is not null then
    raise exception using
      errcode = 'PT409',
      message = 'That invitation has been accepted.',
      hint = 'invitation_closed';
  end if;

  update public.supervisor_invitations i
  set cancelled_at = pg_catalog.now()
  where i.id = invitation.id
    and i.cancelled_at is null;
end;
$$;

-- ---- An address's account ---------------------------------------------------------------------------

-- The account an address belongs to, confirmed or not, or null, for the
-- server key. The supervisor-tools function asks it after invite_supervisor
-- or resend_supervisor_invitation, and asks Supabase Auth to send an invite
-- email only when there is none: an address with an account gets no new
-- account and no email, and its invitation waits on the dashboard until that
-- account signs in. Addresses are compared as email_key reads them.
create function public.account_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select u.id
  from auth.users u
  where public.email_key(p_email) <> ''
    and public.email_key(u.email) = public.email_key(p_email)
  order by u.id
  limit 1
$$;

-- ---- The invited person's side ----------------------------------------------------------------------

-- The open, unexpired invitations to the caller's confirmed address
-- (confirmed_email_of), oldest first: the company, the name on the row it is
-- for, and until when it is good. None for an account with no confirmed
-- address. 42501 when nobody is signed in.
create function public.my_supervisor_invitations()
returns table (
  id uuid,
  company_id uuid,
  company_name text,
  first_name text,
  last_name text,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  caller uuid := auth.uid();
  mine text;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  mine := public.confirmed_email_of(caller);
  return query
    select i.id, i.company_id, c.name, r.first_name, r.last_name, i.expires_at
    from public.supervisor_invitations i
    join public.companies c on c.id = i.company_id
    join public.roster r on r.company_id = i.company_id and r.id = i.roster_id
    where i.email = mine
      and i.accepted_at is null
      and i.cancelled_at is null
      and i.expires_at > pg_catalog.now()
    order by i.created_at, i.id;
end;
$$;

-- Accept an invitation: the invited person, signed in with the invited
-- address, confirmed, takes the row. It answers {company_id, company_name}.
--
-- The invitation is locked, then the row, before anything about either is
-- looked at, and every condition is checked under those locks: two
-- acceptances of one invitation, or an acceptance and a new invitation onto
-- the row, take turns, and the second sees what the first did. The caller's
-- calls to the company take turns with join_company's too (its lock), so a
-- name typed in the app at the same moment never puts the account on a
-- second row there. It refuses, in this order:
--   42501  nobody signed in;
--   PT404  no such invitation;
--   PT409  wrong_email: the caller's confirmed address (confirmed_email_of) is
--          not the invited one, or it has none. Asked first, so only the
--          invited person learns more about the invitation;
--   PT409  invitation_closed;
--   PT409  already_on_roster: the caller holds a row of the company, on the
--          roster or taken off it (an account holds one row per company);
--   PT409  row_taken.
--
-- It then writes the row three times, in this order, as the roster's write
-- trigger needs. A passcode account on the row is let go of first, with a
-- released hold, as release_roster_claim lets go of a claim, so it cannot
-- take the row back by typing the name: the trigger never hands a claim
-- straight to another account. Then the row is made a supervisor's: the
-- trigger never lets a passcode account hold one. Then the caller's account
-- is put on it. The trigger still has its say on that last write: a passcode
-- account accepting is refused (supervisor_needs_email), and all of it is
-- undone. From then on the keep-a-supervisor guard counts the caller.
create function public.accept_supervisor_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  caller uuid := auth.uid();
  invitation public.supervisor_invitations;
  target public.roster;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  select i.* into invitation
  from public.supervisor_invitations i
  where i.id = p_invitation_id
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'No such invitation.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('join_company ' || caller::text || ' ' || invitation.company_id::text, 0)
  );

  select r.* into target
  from public.roster r
  where r.company_id = invitation.company_id
    and r.id = invitation.roster_id
  for update;

  if public.confirmed_email_of(caller) is distinct from invitation.email then
    raise exception using
      errcode = 'PT409',
      message = 'Sign in with the confirmed email address the invitation was sent to.',
      hint = 'wrong_email';
  end if;
  if invitation.accepted_at is not null
     or invitation.cancelled_at is not null
     or invitation.expires_at <= pg_catalog.now() then
    raise exception using
      errcode = 'PT409',
      message = 'That invitation has expired, or was cancelled or accepted.',
      hint = 'invitation_closed';
  end if;
  if exists (
    select 1 from public.roster r
    where r.company_id = invitation.company_id and r.user_id = caller
  ) then
    raise exception using
      errcode = 'PT409',
      message = 'This account is already on that company''s roster.',
      hint = 'already_on_roster';
  end if;
  if not public.row_open_to_invitation(target.active, target.user_id) then
    raise exception using
      errcode = 'PT409',
      message = 'That roster row is taken off the roster or held by an email sign-in.',
      hint = 'row_taken';
  end if;

  if target.user_id is not null then
    -- Kept beside a bar, if the account has one.
    insert into public.join_holds (company_id, user_id, kind)
    values (target.company_id, target.user_id, 'released')
    on conflict (company_id, user_id, kind) do nothing;

    update public.roster r
    set user_id = null
    where r.id = target.id;
  end if;

  update public.roster r
  set role = 'supervisor'
  where r.id = target.id
    and r.role <> 'supervisor';

  update public.roster r
  set user_id = caller, claimed_at = pg_catalog.now()
  where r.id = target.id;

  update public.supervisor_invitations i
  set accepted_at = pg_catalog.now(), accepted_by = caller
  where i.id = invitation.id;

  return pg_catalog.jsonb_build_object(
    'company_id', invitation.company_id,
    'company_name', (select c.name from public.companies c where c.id = invitation.company_id)
  );
end;
$$;

-- ---- The roster's sign-ins --------------------------------------------------------------------------

-- Each row of a company's roster, on the roster or taken off it, for a
-- supervisor of the company, for the Roster page's Account column:
--   sign_in       none (nobody holds the row), passcode (a passcode account,
--                 one with a crew_logins row, holds it) or email (any other
--                 account does);
--   locked_until  when the 15 minutes end, while 5 wrong tries in a row keep a
--                 passcode account locked; else null;
--   needs_reset   whether 10 wrong in a row lock it until a reset code;
--   invitation_id, invited_email, invited_at
--                 the row's open, unexpired invitation, if it has one: its id,
--                 its address and when it was made.
-- It refuses as company_billing does: 42501 when nobody is signed in, and
-- PT404 for a company the caller does not supervise, or none.
create function public.roster_sign_ins(p_company_id uuid)
returns table (
  roster_id uuid,
  sign_in text,
  locked_until timestamptz,
  needs_reset boolean,
  invitation_id uuid,
  invited_email text,
  invited_at timestamptz
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
  if p_company_id is null or not public.is_supervisor(p_company_id) then
    raise exception using errcode = 'PT404', message = 'No such company.';
  end if;

  return query
    select r.id,
           case
             when r.user_id is null then 'none'
             when l.user_id is not null then 'passcode'
             else 'email'
           end,
           case when l.locked_until > pg_catalog.now() then l.locked_until end,
           coalesce(l.wrong_in_a_row >= 10, false),
           i.id,
           i.email,
           i.created_at
    from public.roster r
    left join public.crew_logins l on l.user_id = r.user_id
    left join public.supervisor_invitations i
      on i.company_id = r.company_id
     and i.roster_id = r.id
     and i.accepted_at is null
     and i.cancelled_at is null
     and i.expires_at > pg_catalog.now()
    where r.company_id = p_company_id
    order by r.id;
end;
$$;

-- ---- Who may call them ------------------------------------------------------------------------------

revoke all on function public.invite_supervisor(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.resend_supervisor_invitation(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cancel_supervisor_invitation(uuid) from public, anon, authenticated, service_role;
revoke all on function public.account_for_email(text) from public, anon, authenticated, service_role;
revoke all on function public.my_supervisor_invitations() from public, anon, authenticated, service_role;
revoke all on function public.accept_supervisor_invitation(uuid) from public, anon, authenticated, service_role;
revoke all on function public.roster_sign_ins(uuid) from public, anon, authenticated, service_role;

-- A supervisor signed in, with their own token: the supervisor-tools function
-- to invite and send again, and the dashboard to cancel and to read the
-- sign-ins. The invited person, on the dashboard, to list and accept theirs.
-- The server key, for the account an address belongs to.
grant execute on function public.invite_supervisor(uuid, text) to authenticated;
grant execute on function public.resend_supervisor_invitation(uuid) to authenticated;
grant execute on function public.cancel_supervisor_invitation(uuid) to authenticated;
grant execute on function public.my_supervisor_invitations() to authenticated;
grant execute on function public.accept_supervisor_invitation(uuid) to authenticated;
grant execute on function public.roster_sign_ins(uuid) to authenticated;
grant execute on function public.account_for_email(text) to service_role;
