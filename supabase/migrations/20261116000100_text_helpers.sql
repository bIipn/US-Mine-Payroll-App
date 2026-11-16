-- MineMuster, step 1: small text helpers the later migrations share.
--
-- None of these is part of the API. EXECUTE is taken away from every API role,
-- so they run only inside the security definer functions and triggers that use
-- them. (PostgreSQL checks EXECUTE against the role doing the write, even for a
-- function called from a CHECK constraint or from inside a trigger function, so
-- constraints use built-in functions only, and the triggers that call these
-- helpers are security definer.)

-- Whitespace, the same characters JavaScript's \s and String.prototype.trim()
-- treat as space. Spelled out rather than written \s so the result does not
-- depend on the database's locale.
--   tab, line feed, vertical tab, form feed, carriage return, space, no-break
--   space, ogham space, the en quad to hair space run, line and paragraph
--   separators, narrow no-break space, medium math space, ideographic space,
--   byte order mark.

-- Trim, and close up any run of spaces: cleanText in src/domain/roster.ts.
create function public.clean_text(value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(
      value,
      '^[\t\n\v\f\r \x00a0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+|[\t\n\v\f\r \x00a0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+$',
      '',
      'g'
    ),
    '[\t\n\v\f\r \x00a0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+',
    ' ',
    'g'
  );
$$;

-- A join code as typed, the way it is stored: capitals, with every space and
-- dash taken out ("abcd-2345", "ABCD 2345" and "abcd2345" are all ABCD2345).
-- Phones turn a typed hyphen into an en or em dash, so those count as dashes too.
create function public.normalize_join_code(code text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.upper(
    pg_catalog.regexp_replace(
      coalesce(code, ''),
      '[\t\n\v\f\r \x00a0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff\x2010-\x2015\x2212-]',
      '',
      'g'
    )
  );
$$;

revoke all on function public.clean_text(text) from public, anon, authenticated, service_role;
revoke all on function public.normalize_join_code(text) from public, anon, authenticated, service_role;
