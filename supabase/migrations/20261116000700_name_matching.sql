-- MineMuster, step 1: matching a typed name to the roster.
--
-- The same rules as findOnRoster in src/domain/roster.ts, and the tests hold
-- the two together (supabase/tests/names.db.mjs):
--
--  * A name typed exactly as it is on the roster (trimmed, runs of spaces
--    closed up, whatever its capitals) is that person.
--  * Otherwise the last names have to agree, give or take a suffix
--    (jr, sr, ii, iii, iv, v), and every word of the typed first name has to
--    be one of the words of the roster's first name. Words are in lower case,
--    without quote marks, full stops, commas or hyphens. A typed first name
--    made only of single letters (an initial) is not a name.
--  * Only active rows are matched.
--  * When a name is typed exactly as on the roster, only the exact rows count.
--    When it fits several rows and none exactly, it is ambiguous.
--
-- None of these is part of the API: they run inside join_company.

-- The words of a name: lower case, with quote marks (straight and curly),
-- full stops, commas and hyphens taken as spaces.
create function public.name_words(value text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(w.word order by w.n), '{}')
  from pg_catalog.unnest(
    pg_catalog.string_to_array(
      public.clean_text(pg_catalog.regexp_replace(pg_catalog.lower(value), '["\x201c\x201d''\x2018\x2019.,-]', ' ', 'g')),
      ' '
    )
  ) with ordinality as w(word, n)
  where w.word <> '';
$$;

-- The "Jr" or "III" at the end of a last name, as a word, or '' when there is none.
-- A one-word last name is never a suffix ("V" alone is a last name).
create function public.last_name_suffix(last_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when pg_catalog.cardinality(w) > 1
      and w[pg_catalog.cardinality(w)] = any (array['jr', 'sr', 'ii', 'iii', 'iv', 'v'])
    then w[pg_catalog.cardinality(w)]
    else ''
  end
  from (select public.name_words(last_name) as w) words;
$$;

-- A last name as its letters run together, without its suffix:
-- "De La Cruz" is "delacruz" and "Vance III" is "vance".
create function public.last_name_core(last_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.array_to_string(
    case
      when public.last_name_suffix(last_name) <> '' then w[1:pg_catalog.cardinality(w) - 1]
      else w
    end,
    ''
  )
  from (select public.name_words(last_name) as w) words;
$$;

-- Typed exactly as on the roster: sameName in src/domain/roster.ts.
create function public.same_name(roster_first text, roster_last text, typed_first text, typed_last text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    pg_catalog.lower(public.clean_text(roster_first)) = pg_catalog.lower(public.clean_text(typed_first))
    and pg_catalog.lower(public.clean_text(roster_last)) = pg_catalog.lower(public.clean_text(typed_last)),
    false
  );
$$;

-- Typed the way people type their own name: fits in src/domain/roster.ts.
create function public.name_fits(roster_first text, roster_last text, typed_first text, typed_last text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  typed_core text := public.last_name_core(typed_last);
  typed_suffix text := public.last_name_suffix(typed_last);
  typed_words text[] := public.name_words(typed_first);
begin
  if typed_core = ''
     or typed_core <> public.last_name_core(roster_last)
     or (typed_suffix <> '' and typed_suffix <> public.last_name_suffix(roster_last)) then
    return false;
  end if;
  return exists (select 1 from pg_catalog.unnest(typed_words) as t(word) where pg_catalog.char_length(t.word) > 1)
    and typed_words operator(pg_catalog.<@) public.name_words(roster_first);
end;
$$;

-- The active rows of a company a typed name is: the rows it is exactly, if
-- there are any, or else every row it fits. None, one, or several.
create function public.find_on_roster(company_id uuid, first_name text, last_name text)
returns setof public.roster
language sql
stable
set search_path = ''
as $$
  with active_rows as (
    select r.*
    from public.roster r
    where r.company_id = find_on_roster.company_id
      and r.active
  ),
  exact as (
    select a.*
    from active_rows a
    where public.same_name(a.first_name, a.last_name, find_on_roster.first_name, find_on_roster.last_name)
  )
  select * from exact
  union all
  select a.*
  from active_rows a
  where not exists (select 1 from exact)
    and public.name_fits(a.first_name, a.last_name, find_on_roster.first_name, find_on_roster.last_name);
$$;

revoke all on function public.name_words(text) from public, anon, authenticated, service_role;
revoke all on function public.last_name_suffix(text) from public, anon, authenticated, service_role;
revoke all on function public.last_name_core(text) from public, anon, authenticated, service_role;
revoke all on function public.same_name(text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.name_fits(text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.find_on_roster(uuid, text, text) from public, anon, authenticated, service_role;
