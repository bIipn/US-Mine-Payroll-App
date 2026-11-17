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
-- Every function the earlier migrations made is set to search pg_catalog first
-- and pg_temp last. The bodies do not change: they already qualify every
-- relation and helper, and now their unqualified type names resolve against
-- pg_catalog before the temporary schema. New functions in later migrations
-- set it themselves (see the README).
--
-- The functions are named one by one. Nothing else in schema public is
-- touched: on a real project public already holds objects these migrations do
-- not own and must leave as they are, such as an extension someone put there
-- (`create extension pg_trgm;` with no schema lands there), a procedure or an
-- aggregate (which ALTER FUNCTION refuses, so a sweep would stop the push), or
-- the project's own trigger function on auth.users, which would lose the
-- search_path it finds its own tables by.
-- (This file was corrected in place twice before it was ever applied, the last
-- time to stop it sweeping the schema; once a migration is applied, write a new
-- one instead.)

alter function public.approve_join_request(uuid, uuid, text, text) set search_path = pg_catalog, pg_temp;
alter function public.clean_text(text) set search_path = pg_catalog, pg_temp;
alter function public.companies_before_write() set search_path = pg_catalog, pg_temp;
alter function public.company_by_code(text) set search_path = pg_catalog, pg_temp;
alter function public.create_company(text, text, text, text, text, text) set search_path = pg_catalog, pg_temp;
alter function public.deny_join_request(uuid) set search_path = pg_catalog, pg_temp;
alter function public.find_on_roster(uuid, text, text) set search_path = pg_catalog, pg_temp;
alter function public.has_hidden_characters(text) set search_path = pg_catalog, pg_temp;
alter function public.is_member(uuid) set search_path = pg_catalog, pg_temp;
alter function public.is_supervisor(uuid) set search_path = pg_catalog, pg_temp;
alter function public.join_company(text, text, text) set search_path = pg_catalog, pg_temp;
alter function public.last_name_core(text) set search_path = pg_catalog, pg_temp;
alter function public.last_name_suffix(text) set search_path = pg_catalog, pg_temp;
alter function public.my_join_requests() set search_path = pg_catalog, pg_temp;
alter function public.name_fits(text, text, text, text) set search_path = pg_catalog, pg_temp;
alter function public.name_words(text) set search_path = pg_catalog, pg_temp;
alter function public.new_join_code() set search_path = pg_catalog, pg_temp;
alter function public.normalize_join_code(text) set search_path = pg_catalog, pg_temp;
alter function public.release_roster_claim(uuid) set search_path = pg_catalog, pg_temp;
alter function public.roster_before_write() set search_path = pg_catalog, pg_temp;
alter function public.roster_keeps_a_supervisor() set search_path = pg_catalog, pg_temp;
alter function public.rotate_join_code(uuid) set search_path = pg_catalog, pg_temp;
alter function public.same_name(text, text, text, text) set search_path = pg_catalog, pg_temp;
