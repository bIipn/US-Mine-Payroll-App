-- MineMuster, step 1 hardening: the server key cannot empty a table.
--
-- The earlier migrations take table privileges away from public, anon and
-- authenticated, but Supabase's defaults leave service_role with everything,
-- TRUNCATE included. TRUNCATE fires no row or statement trigger, so
-- `truncate public.roster` would empty every company's roster past the
-- last-supervisor guard. The README's promise is that the server key stays
-- within these rules, so TRUNCATE is taken away from it on all four tables.
-- DELETE (which does fire the guard and the cascades) is left as it is.

revoke truncate on table
  public.companies,
  public.roster,
  public.join_requests,
  public.notifications
from service_role;
