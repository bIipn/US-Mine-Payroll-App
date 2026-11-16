-- MineMuster, step 1 hardening: keep the temporary schema out of the functions.
--
-- The functions are created with `set search_path = ''`. With pg_temp not named
-- in search_path, PostgreSQL searches the session's temporary schema FIRST for
-- relation and type names (it is never searched for functions or operators).
-- The plpgsql bodies declare variables and casts with unqualified type names
-- (uuid, text, integer), so a session able to create temporary objects could
-- put its own type in front of pg_catalog's and have its code run as the
-- function owner, past row level security. PostgreSQL's CREATE FUNCTION page
-- asks that pg_temp be searched last for exactly this reason.
--
-- Every function in schema public that these migrations made is set to search
-- pg_catalog first and pg_temp last. The bodies do not change: they already
-- qualify every relation and helper, and now their unqualified type names
-- resolve against pg_catalog before the temporary schema. New functions in
-- later migrations must do the same (see the README).
--
-- Functions this role does not own, and the member functions of an extension,
-- are left alone. On Supabase the migration role (postgres) is not a
-- superuser, and an extension someone put in public (`create extension
-- pg_trgm;` with no schema lands there) has member functions owned by the
-- bootstrap superuser: altering them would stop this migration with "must be
-- owner of function", and run as a superuser it would rewrite the extension.
-- (This file was corrected in place before it was ever applied; once a
-- migration is applied, write a new one instead.)

do $$
declare
  fn pg_catalog.regprocedure;
begin
  for fn in
    select p.oid::pg_catalog.regprocedure
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and pg_catalog.pg_has_role(p.proowner, 'USAGE')
      and not exists (
        select 1
        from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and d.objid = p.oid
          and d.deptype = 'e'
      )
  loop
    execute pg_catalog.format('alter function %s set search_path = pg_catalog, pg_temp', fn);
  end loop;
end;
$$;
