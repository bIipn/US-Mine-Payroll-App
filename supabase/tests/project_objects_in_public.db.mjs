// The migrations as they run on a Supabase project that already has its own
// objects in schema public, the usual case for a project that is not new: a
// procedure, an aggregate, and the common trigger function on auth.users that
// writes a profile row, naming its table without a schema. A migration that
// swept every function in public with ALTER FUNCTION stopped at the procedure
// or the aggregate ("is not a function", "is an aggregate function"), and with
// neither there it gave the trigger function `search_path = pg_catalog,
// pg_temp`, after which it could not find its own table and every new sign-up
// failed. Migration 20261116001600 names the functions it alters instead.
//
// As in extension_in_public.db.mjs, a role named migrator stands in for
// Supabase's postgres, which owns what the migrations make but is not a
// superuser. All names are made up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { join, startCompany, startDatabase } from './harness.mjs';

const SIGN_UP_TRIGGER = `
  create table public.profiles (id uuid primary key);
  create function public.handle_new_user() returns trigger language plpgsql security definer as $$
  begin
    insert into profiles (id) values (new.id);
    return new;
  end;
  $$;`;

const PROJECT_OBJECTS = `
  create procedure public.tidy_up() language sql as $$ select 1 $$;
  create aggregate public.total_of(int) (sfunc = int4pl, stype = int);
  ${SIGN_UP_TRIGGER}`;

/** A new account signs up while the project's trigger on auth.users is there. Returns its profile rows. */
async function signUp(db) {
  await db.admin('create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user()');
  try {
    const person = await db.newAccount('new-person');
    return { person, profiles: await db.adminRows('select id from public.profiles where id = $1', [person]) };
  } finally {
    await db.admin('drop trigger on_auth_user_created on auth.users');
  }
}

const THE_PROJECTS = ['handle_new_user', 'tidy_up', 'total_of'];

describe("every migration, applied over the project's own objects in public", () => {
  let db;
  before(async () => {
    db = await startDatabase({ owner: 'migrator', before: PROJECT_OBJECTS });
  });
  after(async () => {
    await db?.close();
  });

  it("applies, and leaves the project's own functions, procedure and aggregate as they were", async () => {
    const theirs = await db.adminRows(
      "select p.proname, p.prokind, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any ($1) order by p.proname",
      [THE_PROJECTS],
    );
    assert.deepEqual(theirs.map((p) => [p.proname, p.prokind]), [['handle_new_user', 'f'], ['tidy_up', 'p'], ['total_of', 'a']]);
    for (const p of theirs) assert.equal(p.proconfig, null, `${p.proname} was given ${p.proconfig}`);
  });

  it("so a new sign-up still goes through the project's own trigger on auth.users", async () => {
    const { person, profiles } = await signUp(db);
    assert.deepEqual(profiles, [{ id: person }]);
  });

  it('still gives every function the migrations made the hardened search_path', async () => {
    const unset = await db.adminRows(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and not (p.proname = any ($1))
         and not (coalesce(p.proconfig, '{}') @> array['search_path=pg_catalog, pg_temp'])`,
      [THE_PROJECTS],
    );
    assert.deepEqual(unset, []);
  });

  it('works: a company is started and a person joins it', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    assert.equal((await join(db, await db.newAccount(), company.code, 'Kit', 'Marlow')).status, 'joined');
  });
});

describe("every migration, applied over the project's own sign-up trigger in public alone", () => {
  // Without a procedure or an aggregate to stop it, a sweep went through, and broke sign-ups silently.
  let db;
  before(async () => {
    db = await startDatabase({ owner: 'migrator', before: SIGN_UP_TRIGGER });
  });
  after(async () => {
    await db?.close();
  });

  it('leaves the trigger function as it was, so a new sign-up still works', async () => {
    const [fn] = await db.adminRows("select proconfig from pg_proc where oid = 'public.handle_new_user'::regproc");
    let outcome;
    try {
      outcome = await signUp(db);
    } catch (error) {
      assert.fail(`a new sign-up now fails: ${error.message} (the function was given ${fn.proconfig})`);
    }
    assert.deepEqual(outcome.profiles, [{ id: outcome.person }]);
    assert.equal(fn.proconfig, null);
  });
});
