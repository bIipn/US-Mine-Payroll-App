// Stand-ins for what every Supabase project already has, as SQL the harness
// runs on an empty PGlite database before the migrations.
//
// Kept in a JavaScript file, not a .sql file, on purpose: the Supabase CLI's
// `supabase test db` runs every .sql file under supabase/tests as a pgTAP
// test, and this must never run against a real Supabase database.

export const SUPABASE_STUB = `
-- Only for these tests. Never apply this to a Supabase project: it has all
-- of this already, and the migrations neither create nor change any of it.

-- The API roles. PostgREST switches to anon or authenticated for each request,
-- by the request's key and sign-in; service_role is the server's key.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- Supabase Auth's schema: its accounts, and the signed-in account's id.
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text
);

-- The signed-in account, from the request's token. Null when nobody is signed in.
create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- The request's JWT claims, as Supabase provides them. A real anonymous sign-in
-- carries "is_anonymous": true here. Empty object when there is no token.
create function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;

-- Supabase's grants on schema public: every table, function and sequence made
-- there is open to the API roles unless a migration takes it back. The
-- migrations are tested against this, so a table or function they forget to
-- lock is caught.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
`;
