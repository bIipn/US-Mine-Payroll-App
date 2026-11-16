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
-- Every function in schema public is set to search pg_catalog first and pg_temp
-- last. The bodies do not change: they already qualify every relation and
-- helper, and now their unqualified type names resolve against pg_catalog
-- before the temporary schema. New functions in later migrations must do the
-- same (see the README).

do $$
declare
  fn pg_catalog.regprocedure;
begin
  for fn in
    select p.oid::pg_catalog.regprocedure
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute pg_catalog.format('alter function %s set search_path = pg_catalog, pg_temp', fn);
  end loop;
end;
$$;
