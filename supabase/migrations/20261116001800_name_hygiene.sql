-- MineMuster, step 1 hardening: a typed name cannot pass for a coworker's.
--
-- This migration is new; it never edits an applied one. Migration
-- 20261116001200 refused names with a control or invisible format character,
-- so a request could not pose as a claimed coworker's name with a hidden
-- character in it. Three ways around that remained, each turning what should
-- be 'already_claimed' into an ordinary-looking 'not_on_roster' request that
-- displays as the coworker, and, once approved, a second roster row that
-- reads the same:
--
--  1. Most invisible characters got through. has_hidden_characters now
--     refuses every Default_Ignorable_Code_Point and the remaining format
--     characters (Cf): the combining grapheme joiner, the Hangul fillers,
--     Khmer inherent vowels, Mongolian variation selectors, variation
--     selectors, tags, shorthand and musical format controls, the Arabic,
--     Syriac, Kaithi and Egyptian format marks, the Braille blank, and the
--     reserved specials, along with what it refused before.
--  2. Names were not normalized, so a decomposed spelling ("Jose" and a
--     combining acute) was another string than the composed one. clean_text
--     now composes (NFC) first, so a name is stored, matched and requested
--     composed.
--  3. Look-alike letters from another alphabet (a Cyrillic i for a Latin i).
--     A name, first and last together, may no longer mix Latin, Greek and
--     Cyrillic letters. A name wholly in one of them is fine.
--
-- These checks now run when a name or title is written, not on every later
-- update of the row, so a rule made stricter later never blocks unrelated
-- changes to an older row: a title change, a claim released, or the claim
-- cleared when an account is deleted.
--
-- Two smaller fixes ride along, so the database and the app read capitals the
-- same way (src/domain/roster.ts uses JavaScript's toLowerCase):
--  * a final sigma is the sigma it is: matching folds it to the medial one,
--    so a name typed in Greek capitals finds the person written in lower case;
--  * a capital I with a dot (U+0130) is folded to I before lower case, so the
--    answer does not depend on the database's locale.
--
-- Kept ASCII with regex escapes and chr(), like the other helpers. All private.

-- Every Default_Ignorable_Code_Point and the remaining format characters (Cf),
-- with the C0 and C1 controls. What clean_text treats as space (the no-break
-- spaces, the byte order mark, ...) is closed up before this is asked.
create or replace function public.has_hidden_characters(value text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    value ~ '[\x0001-\x001f\x007f-\x009f\x00ad\x034f\x0600-\x0605\x061c\x06dd\x070f\x0890\x0891\x08e2\x115f\x1160\x17b4\x17b5\x180b-\x180f\x200b-\x200f\x202a-\x202e\x2060-\x206f\x2800\x3164\xfe00-\xfe0f\xfeff\xffa0\xfff0-\xfffb\x110bd\x110cd\x13430-\x1343f\x1bca0-\x1bca3\x1d173-\x1d17a\xe0000-\xe0fff]',
    false
  );
$$;

revoke all on function public.has_hidden_characters(text) from public, anon, authenticated, service_role;

-- Compose (NFC), trim, and close up any run of spaces.
create or replace function public.clean_text(value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(
      pg_catalog.normalize(value, 'NFC'),
      '^[\t\n\v\f\r \x00a0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+|[\t\n\v\f\r \x00a0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+$',
      '',
      'g'
    ),
    '[\t\n\v\f\r \x00a0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+',
    ' ',
    'g'
  );
$$;

revoke all on function public.clean_text(text) from public, anon, authenticated, service_role;

-- A name in lower case, the way names are compared: a capital I with a dot
-- (chr 304) is an I first, and a final sigma (chr 962) is the medial one
-- (chr 963) after.
create function public.fold_name(value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.translate(
    pg_catalog.lower(pg_catalog.translate(value, pg_catalog.chr(304), 'I')),
    pg_catalog.chr(962),
    pg_catalog.chr(963)
  );
$$;

revoke all on function public.fold_name(text) from public, anon, authenticated, service_role;

-- The words of a name, folded, with quote marks (straight and curly), full
-- stops, commas and hyphens taken as spaces.
create or replace function public.name_words(value text)
returns text[]
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(pg_catalog.array_agg(w.word order by w.n), '{}')
  from pg_catalog.unnest(
    pg_catalog.string_to_array(
      public.clean_text(pg_catalog.regexp_replace(public.fold_name(value), '["\x201c\x201d''\x2018\x2019.,-]', ' ', 'g')),
      ' '
    )
  ) with ordinality as w(word, n)
  where w.word <> '';
$$;

revoke all on function public.name_words(text) from public, anon, authenticated, service_role;

-- Typed exactly as on the roster: sameName in src/domain/roster.ts.
create or replace function public.same_name(roster_first text, roster_last text, typed_first text, typed_last text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    public.fold_name(public.clean_text(roster_first)) = public.fold_name(public.clean_text(typed_first))
    and public.fold_name(public.clean_text(roster_last)) = public.fold_name(public.clean_text(typed_last)),
    false
  );
$$;

revoke all on function public.same_name(text, text, text, text) from public, anon, authenticated, service_role;

-- Whether a value holds letters of more than one of the Latin, Greek and
-- Cyrillic alphabets, which have look-alikes of each other.
create function public.mixes_alphabets(value text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    (value ~ '[A-Za-z\x00c0-\x00d6\x00d8-\x00f6\x00f8-\x024f\x1e00-\x1eff\x2c60-\x2c7f\xa720-\xa7ff\xab30-\xab6f\xff21-\xff3a\xff41-\xff5a]')::integer
      + (value ~ '[\x0370-\x03ff\x1f00-\x1fff]')::integer
      + (value ~ '[\x0400-\x052f\x1c80-\x1c8f\x2de0-\x2dff\xa640-\xa69f]')::integer
      > 1,
    false
  );
$$;

revoke all on function public.mixes_alphabets(text) from public, anon, authenticated, service_role;

-- Roster rows: as before, with the name checks made when a name or title is
-- written, and a name that mixes alphabets refused.
create or replace function public.roster_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  name_written boolean := true;
  title_written boolean := true;
begin
  if tg_op = 'UPDATE' then
    name_written := new.first_name is distinct from old.first_name or new.last_name is distinct from old.last_name;
    title_written := new.title is distinct from old.title;
  end if;

  new.first_name := public.clean_text(new.first_name);
  new.last_name := public.clean_text(new.last_name);
  new.title := nullif(public.clean_text(new.title), '');

  if (name_written and (public.has_hidden_characters(new.first_name) or public.has_hidden_characters(new.last_name)))
     or (title_written and public.has_hidden_characters(new.title)) then
    raise exception using
      errcode = '22023',
      message = 'A name cannot hold control or invisible characters.';
  end if;
  if name_written and public.mixes_alphabets(new.first_name || ' ' || new.last_name) then
    raise exception using
      errcode = '22023',
      message = 'A name cannot mix letters of different alphabets, such as Latin and Cyrillic.',
      hint = 'Write the whole name in one alphabet.';
  end if;

  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id then
      raise exception using
        errcode = '42501',
        message = 'A roster row cannot move to another company.';
    end if;
    if old.user_id is not null and new.user_id is not null and new.user_id <> old.user_id then
      raise exception using
        errcode = '55000',
        message = 'That roster row is already claimed by another account.',
        hint = 'A supervisor can release it first.';
    end if;
  end if;

  if new.user_id is null then
    new.claimed_at := null;
  elsif new.claimed_at is null then
    new.claimed_at := pg_catalog.now();
  end if;

  return new;
end;
$$;

revoke all on function public.roster_before_write() from public, anon, authenticated, service_role;

-- Names already stored are composed too. Only rows whose names change are
-- written, and the trigger above composes them.
update public.roster r
set first_name = r.first_name, last_name = r.last_name, title = r.title
where r.first_name <> pg_catalog.normalize(r.first_name, 'NFC')
   or r.last_name <> pg_catalog.normalize(r.last_name, 'NFC')
   or r.title <> pg_catalog.normalize(r.title, 'NFC');

update public.join_requests j
set first_name = public.clean_text(j.first_name), last_name = public.clean_text(j.last_name)
where j.first_name <> pg_catalog.normalize(j.first_name, 'NFC')
   or j.last_name <> pg_catalog.normalize(j.last_name, 'NFC');
