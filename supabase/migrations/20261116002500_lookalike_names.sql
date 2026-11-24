-- MineMuster, step 1 hardening: a typed name cannot pass for a coworker's by
-- looking like it.
--
-- This migration is new; it never edits an applied one. Migration
-- 20261116001800 refused a name that mixes Latin, Greek and Cyrillic letters,
-- so a request could not pose as a claimed coworker's name with a look-alike
-- letter in it: what should be 'already_claimed' turned into an
-- ordinary-looking 'not_on_roster' request that displays as the coworker and,
-- once approved, a second roster row that reads the same. A mix of alphabets
-- is only one way to write a look-alike. These all got through:
--  * a name wholly in Cyrillic look-alikes (Cyrillic J, o, e and C, o, x for
--    "Joe Cox"), which mixes nothing;
--  * Latin letters outside the ranges counted as Latin: a small capital O for
--    o, a small Roman numeral fifty for l;
--  * mathematical letters, such as a sans-serif K;
--  * plain ASCII: a capital I for a lower-case l, "rn" for m;
--  * and look-alikes from every other script.
--
-- Names are now also compared by what they look like. name_skeleton reduces a
-- name to the characters it can be mistaken for, after Unicode's confusables
-- (UTS #39): compatibility forms folded (NFKC), each character that looks like
-- a Latin letter or a quote mark, apostrophe, hyphen, full stop or comma
-- replaced by it (from the table below), "rn" read as m, and then capitals
-- ignored, as names are compared. The table was made by
-- supabase/tools/make_name_skeleton_table.py from confusables.txt of Unicode
-- 16.0.0 (the copy carried by the unicode-security 0.1.2 crate): never edit it
-- by hand. A capital L is kept apart from a small l first, so the capital I
-- that looks like a small l does not make "Ian" and "Lan" the same.
--  * join_company refuses a typed name (22023) that no row of the company,
--    active or not, is or fits, but that one is or fits once both are reduced
--    to their skeletons (poses_as_roster_name, called from join_company in
--    migration 20261116002600). Nothing is recorded.
--  * The roster refuses a name (22023), when it is written, that looks the
--    same as another row of the company without being written the same, so
--    approving such a request cannot put a second row on the roster that reads
--    the same. Two rows written exactly the same stay allowed, as before.
--
-- Kept ASCII with escape strings, like the other helpers. All private.

-- What a name looks like, for comparing names that are written differently.
-- Never shown or stored.
create function public.name_skeleton(value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select public.fold_name(
    pg_catalog.translate(
      pg_catalog.regexp_replace(
        pg_catalog.translate(
          public.clean_text(pg_catalog.normalize(public.clean_text(value), 'NFKC')),
          -- 478 characters, from confusables.txt version 16.0.0,
          -- by supabase/tools/make_name_skeleton_table.py (NFKC of Python unicodedata 15.1.0).
          -- These characters,
          E'01I\u0060\u007c\u00d7\u0131\u0184\u018d\u0196\u01a6\u01bd\u01c0\u0251\u0261\u0263\u0269\u026a\u026f\u028b\u028f\u02b9\u02ba\u02bb'
          '\u02bc\u02bd\u02be\u02c8\u02ca\u02cb\u02d7\u02ee\u02f4\u02f6\u037f\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5'
          '\u03a7\u03b1\u03b3\u03b9\u03bd\u03bf\u03c1\u03c3\u03c5\u03dc\u03f3\u03fa\u0405\u0406\u0408\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421'
          '\u0422\u0423\u0425\u042c\u0430\u0433\u0435\u043e\u0440\u0441\u0443\u0445\u0455\u0456\u0458\u0461\u0474\u0475\u04ae\u04af\u04bb\u04bd\u04c0\u04cf'
          '\u0501\u050c\u051b\u051c\u051d\u054d\u054f\u0555\u055a\u055d\u0561\u0563\u0566\u0570\u0578\u057c\u057d\u0581\u0584\u0585\u05c0\u05d5\u05d8\u05d9'
          '\u05df\u05e1\u05f2\u05f3\u05f4\u060d\u0627\u0647\u0660\u0661\u0665\u0667\u066b\u06be\u06c1\u06d4\u06d5\u06f0\u06f1\u06f5\u06f7\u0701\u0702\u07c0'
          '\u07ca\u07f4\u07f5\u0966\u09e6\u0a66\u0ae6\u0b20\u0b66\u0be6\u0c02\u0c66\u0c82\u0ce6\u0d02\u0d20\u0d66\u0d82\u0e50\u0ed0\u101d\u1040\u10e7\u10ff'
          '\u1200\u12d0\u13a0\u13a1\u13a2\u13a5\u13a9\u13aa\u13ab\u13ac\u13b3\u13b7\u13bb\u13bd\u13c0\u13c2\u13c3\u13cf\u13d2\u13d4\u13d5\u13d9\u13da\u13de'
          '\u13df\u13e2\u13e6\u13e7\u13f3\u13f4\u142f\u144a\u144c\u146d\u146f\u1472\u148d\u14aa\u1541\u157c\u157d\u1587\u15af\u15b4\u15c5\u15de\u15ea\u15f0'
          '\u15f7\u166d\u166e\u16b7\u16c1\u16cc\u16d5\u16d6\u1cd3\u1d04\u1d0f\u1d11\u1d1c\u1d20\u1d21\u1d22\u1d26\u1d83\u1d8c\u1e9d\u1eff\u2010\u2012\u2013'
          '\u2018\u2019\u201a\u201b\u201c\u201d\u201f\u2032\u2035\u2043\u212e\u2212\u2223\u2228\u222a\u22a4\u22c1\u22c3\u22ff\u2373\u2374\u237a\u23fd\u2573'
          '\u2796\u27d9\u292b\u292c\u2a2f\u2c85\u2c8e\u2c92\u2c94\u2c98\u2c9a\u2c9e\u2c9f\u2ca2\u2ca3\u2ca4\u2ca5\u2ca6\u2ca8\u2cac\u2cba\u2cd0\u2d38\u2d39'
          '\u2d4f\u2d54\u2d55\u2d5d\u3003\u3007\ua4d0\ua4d1\ua4d2\ua4d3\ua4d4\ua4d6\ua4d7\ua4d9\ua4da\ua4dc\ua4dd\ua4df\ua4e0\ua4e1\ua4e2\ua4e3\ua4e6\ua4e7'
          '\ua4ea\ua4eb\ua4ec\ua4ee\ua4f0\ua4f2\ua4f3\ua4f4\ua4f8\ua4f9\ua60e\ua647\ua6df\ua731\ua78c\ua798\ua799\ua79f\ua7b2\ua7b3\ua7b4\uab32\uab35\uab3d'
          '\uab47\uab48\uab4e\uab52\uab5a\uab75\uab81\uab83\uab93\uaba9\uabaa\uabaf\U00010282\U00010286\U00010287\U0001028a\U00010290\U00010292\U00010295\U00010296\U00010297\U000102a0\U000102a1\U000102a2'
          '\U000102a5\U000102ab\U000102b0\U000102b1\U000102b2\U000102b4\U000102cf\U000102f5\U00010301\U00010302\U00010309\U00010311\U00010315\U00010317\U00010320\U00010322\U00010404\U00010415\U0001041b\U00010420\U0001042c\U0001043d\U00010448\U000104b4'
          '\U000104c2\U000104ce\U000104ea\U000104f6\U00010513\U00010516\U00010518\U0001051c\U0001051d\U00010525\U00010526\U00010527\U00010a50\U000114d0\U00011700\U00011706\U0001170a\U0001170e\U0001170f\U000118a0\U000118a2\U000118a3\U000118a4\U000118a6'
          '\U000118a9\U000118ae\U000118b2\U000118b5\U000118b8\U000118bc\U000118c0\U000118c1\U000118c2\U000118c3\U000118c4\U000118c8\U000118d7\U000118d8\U000118dc\U000118e0\U000118e3\U000118e5\U000118e6\U000118e9\U000118ec\U000118ef\U000118f2\U00016f08'
          '\U00016f0a\U00016f16\U00016f28\U00016f35\U00016f3a\U00016f40\U00016f42\U00016f43\U00016f51\U00016f52\U0001ccd6\U0001ccd7\U0001ccd8\U0001ccd9\U0001ccda\U0001ccdb\U0001ccdc\U0001ccdd\U0001ccde\U0001ccdf\U0001cce0\U0001cce1\U0001cce2\U0001cce3'
          '\U0001cce4\U0001cce5\U0001cce6\U0001cce7\U0001cce8\U0001cce9\U0001ccea\U0001cceb\U0001ccec\U0001cced\U0001ccee\U0001ccef\U0001ccf0\U0001ccf1\U0001d16d\U0001d20d\U0001d213\U0001d216\U0001d22a\U0001e8c7\U0001f74c\U0001f768',
          -- each become the one in the same place here.
          E'Oll\u0027lxibglRslagyiiwuy\u0027\u0022\u0027'
          '\u0027\u0027\u0027\u0027\u0027\u0027\u002d\u0022\u0027\u0022JABEZHlKMNOPTY'
          'XayivopouFjMSlJABEKMHOPC'
          'TYXbareopcyxsijwVvYyheli'
          'dGqWwUSO\u0027\u0027wqqhnnugfollv\u0027'
          'lo\u0022\u0027\u0022\u002clo\u002eloV\u002coo\u002do\u002eloV\u002e\u002eO'
          'l\u0027\u0027oOooOOoooooooooooooyo'
          'UODRTiYAJEWMHYGhZbRWSVSL'
          'CPKdGBV\u0027UPdbJLxHxRbFADDM'
          'BXxXl\u0027KM\u0022coouvwzrgyfy\u002d\u002d\u002d'
          '\u0027\u0027\u002c\u0027\u0022\u0022\u0022\u0027\u0027\u002de\u002dlvUTvUEipalX'
          '\u002dTxxxrHlKMNOoPpCcTYX\u002dLVE'
          'lOQX\u0022OBPdDTGKJCZFMNLSRVH'
          'WXYAElOU\u002e\u002c\u002eiVs\u0027FfuJXBefo'
          'rruuyirwzvscBEFlXOPSTABC'
          'FOMTYXHZBClMTXlXOCLSocsR'
          'OUouNOKCVFLX\u002eOmvwwwVFLYE'
          'ZELOUTvsFizoouyOmZWCXWCV'
          'TLlRSAUY\u0027\u0027ABCDEFGHlJKLMN'
          'OPQRSTUVWXYZOl\u002eVFRLlCT'
        ),
        'rn', 'm', 'g'
      ),
      -- A capital L stays apart from the small l that I, 1 and | look like.
      'L', pg_catalog.chr(1)
    )
  );
$$;

revoke all on function public.name_skeleton(text) from public, anon, authenticated, service_role;

-- Whether a typed name would pass for someone on the company's roster without
-- being them: no row of the company, active or not, is that name or fits it,
-- but one is or fits it once both are reduced to what they look like.
create function public.poses_as_roster_name(company_id uuid, first_name text, last_name text)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  typed_first_key text := public.name_skeleton(poses_as_roster_name.first_name);
  typed_last_key text := public.name_skeleton(poses_as_roster_name.last_name);
begin
  if exists (
    select 1
    from public.roster r
    where r.company_id = poses_as_roster_name.company_id
      and (public.same_name(r.first_name, r.last_name, poses_as_roster_name.first_name, poses_as_roster_name.last_name)
           or public.name_fits(r.first_name, r.last_name, poses_as_roster_name.first_name, poses_as_roster_name.last_name))
  ) then
    return false;
  end if;

  return exists (
    select 1
    from public.roster r
    cross join lateral (
      select public.name_skeleton(r.first_name) as first_key, public.name_skeleton(r.last_name) as last_key
    ) k
    where r.company_id = poses_as_roster_name.company_id
      and (public.same_name(k.first_key, k.last_key, typed_first_key, typed_last_key)
           or public.name_fits(k.first_key, k.last_key, typed_first_key, typed_last_key))
  );
end;
$$;

revoke all on function public.poses_as_roster_name(uuid, text, text) from public, anon, authenticated, service_role;

-- A roster name, when it is written, may not look the same as another row's in
-- the company without being written the same. Checked once per statement, over
-- the rows whose names the statement wrote, so a statement that writes many
-- rows reduces each row of the company to its skeleton once. Security definer
-- so it can call the private helpers whoever is writing.
create function public.roster_names_look_apart()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  written uuid[];
  clash record;
begin
  if tg_op = 'INSERT' then
    select pg_catalog.array_agg(n.id) into written from new_rows n;
  else
    select pg_catalog.array_agg(n.id) into written
    from new_rows n
    join old_rows o on o.id = n.id
    where n.first_name is distinct from o.first_name or n.last_name is distinct from o.last_name;
  end if;
  if written is null then
    return null;
  end if;

  with keyed as materialized (
    select r.id, r.company_id, r.first_name, r.last_name,
           public.name_skeleton(r.first_name) as first_key,
           public.name_skeleton(r.last_name) as last_key
    from public.roster r
    where r.company_id in (select w.company_id from public.roster w where w.id = any (written))
  )
  select a.first_name || ' ' || a.last_name as name, b.first_name || ' ' || b.last_name as other
  into clash
  from keyed a
  join keyed b
    on b.company_id = a.company_id
   and b.first_key = a.first_key
   and b.last_key = a.last_key
   and b.id <> a.id
  where a.id = any (written)
    and not public.same_name(b.first_name, b.last_name, a.first_name, a.last_name)
  limit 1;

  if found then
    raise exception using
      errcode = '22023',
      message = pg_catalog.format('The name %s looks the same as %s on the roster, but is written differently.', clash.name, clash.other),
      hint = 'If it is the same person, use that row. If not, write the name so the two can be told apart, with a middle initial for instance.';
  end if;
  return null;
end;
$$;

revoke all on function public.roster_names_look_apart() from public, anon, authenticated, service_role;

create trigger roster_names_look_apart_on_insert
  after insert on public.roster
  referencing new table as new_rows
  for each statement execute function public.roster_names_look_apart();

create trigger roster_names_look_apart_on_update
  after update on public.roster
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.roster_names_look_apart();
