-- MineMuster: crew sign-in with the company's code, a name and a passcode.
--
-- This migration is new; it never edits an applied one. A crew member gets
-- into the app with their company's code, their first and last name and a
-- passcode of 6 to 12 digits, and no email. Each crew member is an ordinary
-- Supabase Auth user that the server makes (the crew-auth edge function, with
-- the server key): a hidden address on crew.minemuster.com, which receives no
-- mail, and a long password the server works out from that address and a key
-- of its own. Nobody, the person included, ever sees either. A crew account is
-- one with a crew_logins row; nothing is decided from the address.
--
-- The passcode itself is never kept, only its digest: SHA-256 of a key of this
-- server's own, a salt of the account's own and the passcode, in a table no
-- API role can read:
--
--   crew_key     The key, made at random here, once, in a one-row table no API
--                role can read (as contact_sender_key in migration
--                20261117000500). Without it a digest cannot be matched by
--                trying every passcode.
--   crew_logins  A row for each crew account, which goes with the account: its
--                salt and digest, its wrong tries in a row and its lock, a
--                supervisor's reset code kept the same way (reset_digest,
--                reset_until, reset_tries), and when the account was made and
--                its passcode last set.
--
-- Wrong tries: 5 wrong in a row lock the account for 15 minutes, and 10 lock it
-- until a supervisor's reset code, against the right passcode as well. The
-- right passcode clears the count. The check reads the account's row for
-- update before its counts, so guesses sent at once are counted one by one.
--
-- The functions of this part:
--
--   crew_passcode_problem(passcode)  The app's passcode rule, giving the same
--       answer for every string: null, or not_digits, too_short, too_long or
--       easy. No API role.
--   crew_login_password(email)  A crew account's sign-in password, worked out
--       from its hidden address. No API role.
--   crew_keep_passcode(p_user, p_passcode)  Keeps a passcode for an account
--       and starts its counts afresh. The server key alone.
--   crew_check_passcode(p_user, p_passcode)  Checks a passcode and counts it.
--       No API role: the sign-in functions call it inside the database.
--
-- Each is security definer and searches pg_catalog first and the temporary
-- schema last.

-- ---- The key and the logins -------------------------------------------------------------------------

-- The key of every digest and sign-in password here: two random uuids (244
-- random bits) as text, as the contact form's key is made.
create table public.crew_key (
  one boolean primary key default true,
  key bytea not null,
  constraint crew_key_one check (one)
);

insert into public.crew_key (key)
values (pg_catalog.convert_to(pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, 'UTF8'));

-- A digest is 32 bytes and a salt 16, so a passcode or a reset code as typed
-- (6 to 12 digits) can never be kept in either.
create table public.crew_logins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  salt bytea not null,
  digest bytea not null,
  wrong_in_a_row integer not null default 0,
  locked_until timestamptz,
  reset_digest bytea,
  reset_until timestamptz,
  reset_tries integer not null default 0,
  created_at timestamptz not null default now(),
  passcode_set_at timestamptz not null default now(),
  constraint crew_logins_salt_check check (pg_catalog.octet_length(salt) = 16),
  constraint crew_logins_digest_check check (pg_catalog.octet_length(digest) = 32),
  constraint crew_logins_reset_digest_check check (reset_digest is null or pg_catalog.octet_length(reset_digest) = 32),
  constraint crew_logins_counts_check check (wrong_in_a_row >= 0 and reset_tries >= 0)
);

-- ---- Who reads and writes them ----------------------------------------------------------------------

alter table public.crew_key enable row level security;
alter table public.crew_logins enable row level security;

-- No API role at all, the server key included. Supabase grants every API role
-- on a new table in public, so it is taken back here. The functions below keep
-- both, as their owner.
revoke all on table public.crew_key from public, anon, authenticated, service_role;
revoke all on table public.crew_logins from public, anon, authenticated, service_role;

-- No planner statistics, before either holds data (see migration
-- 20261116002200 and the README).
do $$
declare
  col record;
begin
  for col in
    select c.oid::pg_catalog.regclass as tbl, a.attname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relname in ('crew_key', 'crew_logins')
      and a.attnum > 0
      and not a.attisdropped
    order by c.relname, a.attnum
  loop
    execute pg_catalog.format('alter table %s alter column %I set statistics 0', col.tbl, col.attname);
  end loop;
end;
$$;

-- ---- The passcode rule ------------------------------------------------------------------------------

-- The app's passcode rule (passcodeProblem in src/domain/passcode.ts), so the
-- server refuses what the app refuses: the same answer for every string, as
-- crew_passcodes.db.mjs checks over a few hundred of them. Change the two
-- together. In this order:
--   not_digits  anything but the ASCII digits 0 to 9, an empty passcode too;
--   too_short   fewer than 6 digits;
--   too_long    more than 12;
--   easy        one of the most common 6-digit passcodes in published PIN
--               studies (EASY_PASSCODES in the app); a run, each digit one
--               more, or one less, than the last; one block of 2 digits or
--               more, up to half the passcode, repeated to fill it; three or
--               more doubled digits counting up or down by one (112233,
--               332211); or a palindrome, which takes in every digit the same
--               (111111).
create function public.crew_passcode_problem(passcode text)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  up constant text := '0123456789';
  down constant text := '9876543210';
  n integer;
  firsts text;
  doubled text;
begin
  if coalesce(passcode, '') !~ '^[0-9]+$' then
    return 'not_digits';
  end if;
  n := pg_catalog.char_length(passcode);
  if n < 6 then
    return 'too_short';
  elsif n > 12 then
    return 'too_long';
  end if;

  -- The most common ones.
  if passcode = any (array[
    '123456', '111111', '000000', '121212', '654321', '666666', '112233', '123123', '159753',
    '147258', '696969', '520520', '789456', '101010', '102030', '123654', '456789', '987654'
  ]) then
    return 'easy';
  end if;

  -- A run: a piece of 0123456789, or of 9876543210.
  if pg_catalog.strpos(up, passcode) > 0 or pg_catalog.strpos(down, passcode) > 0 then
    return 'easy';
  end if;

  -- One block repeated: a size from 2 to half the length that divides it.
  if exists (
    select 1
    from pg_catalog.generate_series(2, n / 2) as b(size)
    where n % b.size = 0
      and pg_catalog.repeat(pg_catalog.substr(passcode, 1, b.size), n / b.size) = passcode
  ) then
    return 'easy';
  end if;

  -- Doubled digits counting by one: the first digit of each pair, doubled,
  -- gives the passcode back, and those digits are a run.
  if n % 2 = 0 then
    select pg_catalog.string_agg(pg_catalog.substr(passcode, g.i, 1), '' order by g.i),
           pg_catalog.string_agg(pg_catalog.repeat(pg_catalog.substr(passcode, g.i, 1), 2), '' order by g.i)
      into firsts, doubled
    from pg_catalog.generate_series(1, n, 2) as g(i);
    if doubled = passcode and (pg_catalog.strpos(up, firsts) > 0 or pg_catalog.strpos(down, firsts) > 0) then
      return 'easy';
    end if;
  end if;

  -- The same read backwards.
  if pg_catalog.reverse(passcode) = passcode then
    return 'easy';
  end if;

  return null;
end;
$$;

revoke all on function public.crew_passcode_problem(text) from public, anon, authenticated, service_role;

-- ---- The sign-in password ---------------------------------------------------------------------------

-- A crew account's sign-in password, which only the server ever uses: base64
-- of SHA-256 of the key, 'login:' and the account's hidden address in lower
-- case. It is worked out from the address, not the account's id, because the
-- account is made with it, before it has an id. Without the key nobody can
-- work it out.
create function public.crew_login_password(email text)
returns text
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(k.key || pg_catalog.convert_to('login:' || pg_catalog.lower(email), 'UTF8')),
    'base64'
  )
  from public.crew_key k
$$;

revoke all on function public.crew_login_password(text) from public, anon, authenticated, service_role;

-- ---- Keeping and checking a passcode ----------------------------------------------------------------

-- Keep a passcode for a crew account, for the server key: when crew-auth has
-- made the account, and when a reset sets a new passcode. A passcode the rule
-- refuses is refused (22023) with the problem as the hint: not_digits,
-- too_short, too_long or easy. Keeping one gives the account a new salt and
-- digest and clears its counts: no wrong tries, no lock, and no reset code
-- left to use.
--
-- The salt is 16 random bytes, the first half of SHA-256 of two random uuids
-- (244 random bits), so no extension is needed, pgcrypto included. With no
-- key the digest is null and the insert is refused, never kept without one.
create function public.crew_keep_passcode(p_user uuid, p_passcode text)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  problem text := public.crew_passcode_problem(p_passcode);
  new_salt bytea;
begin
  if problem is not null then
    raise exception using errcode = '22023', message = 'Pick a passcode of 6 to 12 digits that is not a pattern.', hint = problem;
  end if;

  new_salt := pg_catalog.substr(
    pg_catalog.sha256(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()) || pg_catalog.uuid_send(pg_catalog.gen_random_uuid())),
    1, 16);

  insert into public.crew_logins (user_id, salt, digest)
  values (
    p_user,
    new_salt,
    (select pg_catalog.sha256(k.key || new_salt || pg_catalog.convert_to(p_passcode, 'UTF8')) from public.crew_key k)
  )
  on conflict (user_id) do update
  set salt = excluded.salt,
      digest = excluded.digest,
      wrong_in_a_row = 0,
      locked_until = null,
      reset_digest = null,
      reset_until = null,
      reset_tries = 0,
      passcode_set_at = pg_catalog.now();
end;
$$;

revoke all on function public.crew_keep_passcode(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.crew_keep_passcode(uuid, text) to service_role;

-- Check a passcode for a crew account, and count it. No API role calls it: the
-- sign-in functions do, inside the database. It answers
--   {status: 'ok'}                 the right passcode, which clears the count;
--   {status: 'wrong', tries_left}  a wrong one, counted, with the tries left
--                                  before the account locks: from 5, and once
--                                  a 15-minute lock has passed, from 10;
--   {status: 'locked', until}      5 wrong in a row lock the account for 15
--                                  minutes (until is when the lock ends) and
--                                  10 until a reset (until is null). The answer
--                                  to the try that locks it, and to every try
--                                  while it is locked, the right passcode
--                                  included, which is then neither compared
--                                  nor counted;
--   {status: 'no_account'}         no passcode is kept for the account.
--
-- It reads the account's row for update before its counts: a guess sent at the
-- same time as another waits for that one to commit, then reads the count it
-- left, so each is counted.
create function public.crew_check_passcode(p_user uuid, p_passcode text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  kept record;
  in_a_row integer;
  lock_ends timestamptz;
begin
  select l.salt, l.digest, l.wrong_in_a_row, l.locked_until into kept
  from public.crew_logins l
  where l.user_id = p_user
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'no_account');
  end if;

  if kept.wrong_in_a_row >= 10 then
    return pg_catalog.jsonb_build_object('status', 'locked', 'until', null);
  elsif kept.locked_until > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('status', 'locked', 'until', kept.locked_until);
  end if;

  if kept.digest = (
    select pg_catalog.sha256(k.key || kept.salt || pg_catalog.convert_to(coalesce(p_passcode, ''), 'UTF8'))
    from public.crew_key k
  ) then
    update public.crew_logins set wrong_in_a_row = 0, locked_until = null where user_id = p_user;
    return pg_catalog.jsonb_build_object('status', 'ok');
  end if;

  -- Wrong. The fifth in a row starts a 15-minute lock; a lock that has passed
  -- is cleared; the tenth locks the account until a reset, by its count alone.
  in_a_row := kept.wrong_in_a_row + 1;
  update public.crew_logins
  set wrong_in_a_row = in_a_row,
      locked_until = case when in_a_row = 5 then pg_catalog.now() + interval '15 minutes' end
  where user_id = p_user
  returning locked_until into lock_ends;

  if in_a_row >= 10 then
    return pg_catalog.jsonb_build_object('status', 'locked', 'until', null);
  elsif lock_ends is not null then
    return pg_catalog.jsonb_build_object('status', 'locked', 'until', lock_ends);
  end if;
  return pg_catalog.jsonb_build_object('status', 'wrong', 'tries_left', case when in_a_row < 5 then 5 else 10 end - in_a_row);
end;
$$;

revoke all on function public.crew_check_passcode(uuid, text) from public, anon, authenticated, service_role;

-- ==== Signing up and signing in ======================================================================
--
-- What the crew-auth edge function asks, with the server key, before it talks
-- to Supabase Auth itself:
--
--   crew_lookup(p_code, p_address)  The company a code is for, which the app
--       shows as the code is typed.
--   crew_sign_up_check(p_code, p_first, p_last, p_passcode, p_address)
--       Whether a sign-up may go ahead, and the hidden address and password
--       to make the account with. It makes nothing.
--   crew_sign_in_check(p_code, p_first, p_last, p_passcode, p_address)
--       The person found by name the way joining finds them, their passcode
--       checked and counted, and the login to sign in with.
--   crew_confirm_check(p_user, p_passcode)  The passcode of the account
--       signed in on the phone, before it is deleted.
--
-- They read no request headers: crew-auth hands each the phone's network
-- address (p_address), and each that takes one counts the request first
-- (crew_try_counted), against at most 30 from that address in 10 minutes.
-- Every outcome is an answer in jsonb, never a raise: crew_check_passcode
-- counts a wrong try in the caller's transaction, and a raise after it would
-- roll the count back and give a guesser a free try. They write (a try, a
-- count), so they are volatile, and PostgREST runs them by POST, in a
-- transaction that can write. All four are for the server key alone, and
-- company_by_code is no longer open to anyone signed out.

-- ---- Too many tries from one place ------------------------------------------------------------------

-- The crew-auth requests let through from each network address in the last
-- 10 minutes, one row each, for the limit: a digest of the address made with
-- the crew key (SHA-256 of the key and the address), never the address, so
-- the rows cannot be turned back into addresses by trying every address. The
-- next request deletes a row once it is 10 minutes old.
create table public.crew_sign_in_tries (
  sender bytea not null,
  at timestamptz not null default now(),
  constraint crew_sign_in_tries_sender_check check (pg_catalog.octet_length(sender) = 32)
);

create index crew_sign_in_tries_sender_idx on public.crew_sign_in_tries (sender, at);
create index crew_sign_in_tries_at_idx on public.crew_sign_in_tries (at);

alter table public.crew_sign_in_tries enable row level security;

-- No API role at all, the server key included, as crew_logins.
revoke all on table public.crew_sign_in_tries from public, anon, authenticated, service_role;

-- No planner statistics (see migration 20261116002200 and the README).
alter table public.crew_sign_in_tries alter column sender set statistics 0;
alter table public.crew_sign_in_tries alter column at set statistics 0;

-- Count a crew-auth request from a network address, and say whether it may go
-- on: false, with nothing counted, once 30 from that address have gone on in
-- the last 10 minutes. The address is trimmed and read in lower case, as the
-- contact form reads X-Forwarded-For. Requests with no address all count as
-- one sender, so sending none gets nobody past the limit. A request turned
-- away is not counted: a crew trying again while it waits (a whole crew
-- behind one address, on a training day) does not keep itself waiting longer,
-- and a flood from one address keeps 30 rows for it, not one for each request.
--
-- Requests from one address take turns from the count to the commit, so two
-- at once cannot both slip under the limit. What is older than the 10 minutes
-- is deleted, whoever it came from, as the contact form deletes its senders.
-- With no key the digest is null and the insert is refused, before any
-- passcode is checked. No API role: the checks below call it.
create function public.crew_try_counted(p_address text)
returns boolean
language plpgsql
volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  who bytea;
begin
  select pg_catalog.sha256(k.key || pg_catalog.convert_to(coalesce(pg_catalog.lower(pg_catalog.btrim(p_address)), ''), 'UTF8'))
  into who
  from public.crew_key k;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crew_sign_in_tries ' || pg_catalog.encode(who, 'hex'), 0));

  delete from public.crew_sign_in_tries t where t.at <= pg_catalog.now() - interval '10 minutes';

  if (select pg_catalog.count(*)
      from public.crew_sign_in_tries t
      where t.sender = who
        and t.at > pg_catalog.now() - interval '10 minutes') >= 30 then
    return false;
  end if;

  insert into public.crew_sign_in_tries (sender) values (who);
  return true;
end;
$$;

revoke all on function public.crew_try_counted(text) from public, anon, authenticated, service_role;

-- ---- Whom a name signs in ---------------------------------------------------------------------------

-- The crew account a typed name finds in a company, the way joining finds a
-- person, tried in this order:
--
--   1. The active rows find_on_roster gives for the name, as join_company
--      matches it. One row is the person: a supervisor's row, or a row held by
--      an account that is not a crew account, is for the email sign-in
--      (use_email), and a row held by a crew account is that account. A row
--      nobody holds yet is nobody's, unless a crew account's request waits
--      under that name (3), as one does when a supervisor puts the name on the
--      roster before letting the request in. Several rows are ambiguous.
--   2. Else an inactive row with exactly that name held by a crew account:
--      someone taken off the roster, who may still sign in, only to delete
--      their account. A row held by any other account is passed over.
--   3. Else a pending join request with exactly that name, left by a crew
--      account: someone a supervisor has yet to let in.
--
-- Exactly is as same_name reads a name: capitals and runs of spaces aside. A
-- crew account is an account with a crew_logins row; nothing is decided from
-- its address. It answers
--   {status: 'found', user_id, waiting}  waiting is true when a request (3)
--                                       found the person;
--   {status: 'use_email'};
--   {status: 'ambiguous', signed_up}    signed_up is true when the several
--                                       are crew accounts that signed up with
--                                       exactly that name (2 or 3), and false
--                                       when they are rows the name fits (1);
--   {status: 'no_account'}.
-- No API role: the checks below call it.
create function public.crew_find_person(p_company uuid, p_first text, p_last text)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  matched uuid[];
  row_found public.roster;
  accounts uuid[];
begin
  select coalesce(pg_catalog.array_agg(f.id), '{}') into matched
  from public.find_on_roster(p_company, p_first, p_last) f;

  if pg_catalog.cardinality(matched) > 1 then
    return pg_catalog.jsonb_build_object('status', 'ambiguous', 'signed_up', false);
  elsif pg_catalog.cardinality(matched) = 1 then
    select r.* into row_found from public.roster r where r.id = matched[1];
    if row_found.role = 'supervisor'
       or (row_found.user_id is not null
           and not exists (select 1 from public.crew_logins l where l.user_id = row_found.user_id)) then
      return pg_catalog.jsonb_build_object('status', 'use_email');
    elsif row_found.user_id is not null then
      return pg_catalog.jsonb_build_object('status', 'found', 'user_id', row_found.user_id, 'waiting', false);
    end if;
    -- Nobody holds the row yet: only a request can say who signed up with the name.
  else
    select coalesce(pg_catalog.array_agg(r.user_id), '{}') into accounts
    from public.roster r
    where r.company_id = p_company
      and not r.active
      and public.same_name(r.first_name, r.last_name, p_first, p_last)
      and exists (select 1 from public.crew_logins l where l.user_id = r.user_id);
    if pg_catalog.cardinality(accounts) = 1 then
      return pg_catalog.jsonb_build_object('status', 'found', 'user_id', accounts[1], 'waiting', false);
    elsif pg_catalog.cardinality(accounts) > 1 then
      return pg_catalog.jsonb_build_object('status', 'ambiguous', 'signed_up', true);
    end if;
  end if;

  select coalesce(pg_catalog.array_agg(j.user_id), '{}') into accounts
  from public.join_requests j
  where j.company_id = p_company
    and j.status = 'pending'
    and public.same_name(j.first_name, j.last_name, p_first, p_last)
    and exists (select 1 from public.crew_logins l where l.user_id = j.user_id);
  if pg_catalog.cardinality(accounts) = 1 then
    return pg_catalog.jsonb_build_object('status', 'found', 'user_id', accounts[1], 'waiting', true);
  elsif pg_catalog.cardinality(accounts) > 1 then
    return pg_catalog.jsonb_build_object('status', 'ambiguous', 'signed_up', true);
  end if;
  return pg_catalog.jsonb_build_object('status', 'no_account');
end;
$$;

revoke all on function public.crew_find_person(uuid, text, text) from public, anon, authenticated, service_role;

-- ---- Looking up a code ------------------------------------------------------------------------------

-- The company a code is for, for the server key: what company_by_code gives,
-- the code read as joining reads it (capitals, spaces and dashes aside), with
-- the request counted against the limit. The app shows it as the code is
-- typed, so a wrong code is caught first. It answers {status: 'company',
-- name, state}, {status: 'no_company'} or {status: 'busy'}.
create function public.crew_lookup(p_code text, p_address text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  company record;
begin
  if not public.crew_try_counted(p_address) then
    return pg_catalog.jsonb_build_object('status', 'busy');
  end if;

  select b.name, b.state into company from public.company_by_code(p_code) b;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'no_company');
  end if;
  return pg_catalog.jsonb_build_object('status', 'company', 'name', company.name, 'state', company.state);
end;
$$;

-- ---- Signing up -------------------------------------------------------------------------------------

-- Whether a crew sign-up may go ahead, for the server key, and the address and
-- password crew-auth then makes the account with. It makes nothing: no
-- account, no passcode, no request. It answers, in the order it checks,
--   {status: 'busy'}                    30 requests from that address in the
--                                       last 10 minutes;
--   {status: 'no_company'}              no company has that code;
--   {status: 'easy_passcode', problem}  a passcode the rule refuses: problem
--                                       is not_digits, too_short, too_long or
--                                       easy;
--   {status: 'bad_name', message}       a name join_company refuses (22023)
--                                       for what it is, with its words:
--                                       missing or over 100 characters, an
--                                       invisible character, two alphabets,
--                                       or one that only looks like a name on
--                                       the roster. No account is made for a
--                                       name that cannot join;
--   {status: 'already_signed_up'}       a name crew_sign_in_check finds a
--                                       crew account for, or several crew
--                                       accounts signed up with: sign in, or
--                                       ask a supervisor for a reset code. A
--                                       second account would only be a stray;
--   {status: 'use_email'}               a supervisor's row, or a row held by
--                                       an email account;
--   {status: 'ok', company_id, company_name, login_email, login_password}
--                                       a hidden address on
--                                       crew.minemuster.com, which receives no
--                                       mail, from 16 random bytes in hex, and
--                                       the password worked out from it.
-- The rest is joining's to decide, as the new account: a name on no row leaves
-- a request for a supervisor, and a name that fits several rows is answered by
-- join_company itself.
create function public.crew_sign_up_check(p_code text, p_first text, p_last text, p_passcode text, p_address text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  company public.companies;
  typed_first text;
  typed_last text;
  problem text;
  person jsonb;
  hidden_address text;
begin
  if not public.crew_try_counted(p_address) then
    return pg_catalog.jsonb_build_object('status', 'busy');
  end if;

  select c.* into company from public.companies c where c.join_code = public.normalize_join_code(p_code);
  if not found then
    return pg_catalog.jsonb_build_object('status', 'no_company');
  end if;

  problem := public.crew_passcode_problem(p_passcode);
  if problem is not null then
    return pg_catalog.jsonb_build_object('status', 'easy_passcode', 'problem', problem);
  end if;

  -- What join_company (migration 20261116002600) refuses with 22023, in its
  -- order and with its words; crew_sign_in.db.mjs holds the two together. It
  -- asks poses_as_roster_name only of a name it would leave a request for,
  -- which for a new account is every name it is asked of: the question is
  -- false for a name any row is or fits.
  typed_first := public.clean_text(p_first);
  typed_last := public.clean_text(p_last);
  if coalesce(pg_catalog.char_length(typed_first), 0) not between 1 and 100
     or coalesce(pg_catalog.char_length(typed_last), 0) not between 1 and 100
     or public.has_hidden_characters(typed_first)
     or public.has_hidden_characters(typed_last) then
    return pg_catalog.jsonb_build_object('status', 'bad_name', 'message', 'Type your first and last name, up to 100 characters each.');
  end if;
  if public.mixes_alphabets(typed_first || ' ' || typed_last) then
    return pg_catalog.jsonb_build_object('status', 'bad_name', 'message', 'A name cannot mix letters of different alphabets, such as Latin and Cyrillic.');
  end if;
  if public.poses_as_roster_name(company.id, typed_first, typed_last) then
    return pg_catalog.jsonb_build_object('status', 'bad_name', 'message', 'Type your name the way it is written on the roster.');
  end if;

  person := public.crew_find_person(company.id, typed_first, typed_last);
  if person ->> 'status' = 'found' or (person ->> 'status' = 'ambiguous' and (person ->> 'signed_up')::boolean) then
    return pg_catalog.jsonb_build_object('status', 'already_signed_up');
  elsif person ->> 'status' = 'use_email' then
    return pg_catalog.jsonb_build_object('status', 'use_email');
  end if;

  -- 16 random bytes: the first half of SHA-256 of two random uuids (244
  -- random bits), as a salt is made, with no extension.
  hidden_address := 'crew-'
    || pg_catalog.encode(
         pg_catalog.substr(pg_catalog.sha256(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()) || pg_catalog.uuid_send(pg_catalog.gen_random_uuid())), 1, 16),
         'hex')
    || '@crew.minemuster.com';
  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'company_id', company.id,
    'company_name', company.name,
    'login_email', hidden_address,
    'login_password', public.crew_login_password(hidden_address)
  );
end;
$$;

-- ---- Signing in -------------------------------------------------------------------------------------

-- A crew sign-in, for the server key: the company's code, the name the person
-- goes by and their passcode. It answers
--   {status: 'busy'}            30 requests from that address in the last 10
--                               minutes;
--   {status: 'no_company'}      no company has that code;
--   {status: 'ambiguous'}       the name fits several people, or several crew
--                               accounts signed up with it. No passcode is
--                               checked, so no try is counted against anyone;
--   {status: 'use_email'}       a supervisor's row, or a row held by an email
--                               account: email and password sign them in;
--   {status: 'no_account'}      nobody has signed up with that name;
--   {status: 'wrong', tries_left} or {status: 'locked', until}
--                               from crew_check_passcode, which counted the
--                               try;
--   {status: 'ok', company_id, company_name, login_email, login_password, waiting}
--                               the account's own address and the password
--                               to sign it in with, and waiting true when a
--                               request that waits for a supervisor found the
--                               person.
-- Someone taken off the roster is signed in too, only to delete the account:
-- row level security keeps an account with no active row out of the company's
-- records, and the app shows its off-the-roster screen.
create function public.crew_sign_in_check(p_code text, p_first text, p_last text, p_passcode text, p_address text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  company public.companies;
  person jsonb;
  verdict jsonb;
  hidden_address text;
begin
  if not public.crew_try_counted(p_address) then
    return pg_catalog.jsonb_build_object('status', 'busy');
  end if;

  select c.* into company from public.companies c where c.join_code = public.normalize_join_code(p_code);
  if not found then
    return pg_catalog.jsonb_build_object('status', 'no_company');
  end if;

  person := public.crew_find_person(company.id, public.clean_text(p_first), public.clean_text(p_last));
  if person ->> 'status' <> 'found' then
    return pg_catalog.jsonb_build_object('status', person ->> 'status');
  end if;

  -- Nothing below raises: a wrong try is counted in this transaction, and must
  -- stay counted.
  verdict := public.crew_check_passcode((person ->> 'user_id')::uuid, p_passcode);
  if verdict ->> 'status' <> 'ok' then
    return verdict;
  end if;

  select u.email into hidden_address from auth.users u where u.id = (person ->> 'user_id')::uuid;
  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'company_id', company.id,
    'company_name', company.name,
    'login_email', hidden_address,
    'login_password', public.crew_login_password(hidden_address),
    'waiting', (person ->> 'waiting')::boolean
  );
end;
$$;

-- ---- Confirming the account signed in ---------------------------------------------------------------

-- The passcode of the crew account signed in on the phone, for the server
-- key, before the account is deleted (a fresh sign-in, as for an email
-- account's password). crew-auth reads the account from the phone's own
-- session, so this goes by the account, not by a code or a name: the phone
-- keeps no code, and a supervisor can change the code or correct the name. It
-- answers wrong (tries_left), locked (until) or no_account from
-- crew_check_passcode, which counted the try, or {status: 'ok', login_email,
-- login_password}. Nothing after the check raises, as in crew_sign_in_check.
create function public.crew_confirm_check(p_user uuid, p_passcode text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  verdict jsonb;
  hidden_address text;
begin
  verdict := public.crew_check_passcode(p_user, p_passcode);
  if verdict ->> 'status' <> 'ok' then
    return verdict;
  end if;

  select u.email into hidden_address from auth.users u where u.id = p_user;
  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'login_email', hidden_address,
    'login_password', public.crew_login_password(hidden_address)
  );
end;
$$;

-- ---- Who may call them ------------------------------------------------------------------------------

revoke all on function public.crew_lookup(text, text) from public, anon, authenticated, service_role;
revoke all on function public.crew_sign_up_check(text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.crew_sign_in_check(text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.crew_confirm_check(uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.crew_lookup(text, text) to service_role;
grant execute on function public.crew_sign_up_check(text, text, text, text, text) to service_role;
grant execute on function public.crew_sign_in_check(text, text, text, text, text) to service_role;
grant execute on function public.crew_confirm_check(uuid, text) to service_role;

-- company_by_code answered anyone signed out, with no limit on how often codes
-- are tried (the README asked for one before launch). Signed out, the app now
-- looks a code up through crew-auth, under the limit above (crew_lookup); the
-- dashboard calls company_by_code signed in, and keeps it.
revoke execute on function public.company_by_code(text) from anon;
