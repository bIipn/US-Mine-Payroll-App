-- MineMuster, step 1 hardening: the planner's statistics say nothing about
-- another company.
--
-- This migration is new; it never edits an applied one. Row level security
-- hides rows but not column statistics. With ANALYZE's ordinary statistics
-- (most common values and histograms), PostgreSQL estimates a query a caller
-- writes from every row of the table, those of every company, because the
-- comparison operators involved (uuid and text equality and order) are
-- leakproof and may be applied under row level security. PostgREST hands that
-- estimate to any signed-in caller as the count of a request made with
-- `Prefer: count=planned` (supabase-js: select(..., { count: 'planned' })),
-- run as the caller's role. From estimates alone a member of one company
-- could tell a real company id from a made-up one and roughly how many people
-- it has, confirm that a surname is on another company's roster, and recover
-- other companies' ids by bisecting `company_id < X`; an account in no company
-- could do the same through companies.id.
--
-- Every column of every table these migrations make keeps no statistics
-- (SET STATISTICS 0), so every estimate is the planner's fixed default. The
-- app's own lookups go through the unique and partial indexes, so its plans do
-- not need the statistics at this size.
--
-- What is left: a table's total row count (reltuples) still shapes an
-- unfiltered estimate, which shows the platform-wide number of rows in a
-- table, never one company's. Statistics already gathered survive SET
-- STATISTICS 0, which is why this lands with the tables, before they hold
-- data. A table added later turns its statistics off in the migration that
-- makes it (see the README).

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
      and c.relname in ('companies', 'roster', 'join_requests', 'notifications', 'company_supervisor_guard', 'join_holds')
      and a.attnum > 0
      and not a.attisdropped
    order by c.relname, a.attnum
  loop
    execute pg_catalog.format('alter table %s alter column %I set statistics 0', col.tbl, col.attname);
  end loop;
end;
$$;
