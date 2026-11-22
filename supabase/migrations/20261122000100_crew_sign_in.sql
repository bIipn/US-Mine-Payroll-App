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
