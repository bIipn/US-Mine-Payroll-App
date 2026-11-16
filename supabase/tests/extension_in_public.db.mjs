// The migrations as they run on Supabase: as `postgres`, which owns what the
// migrations make but is not a superuser, on a project where someone has put
// an extension in schema public (`create extension pg_trgm;` with no schema
// lands there). A trusted extension installed by a non-superuser is owned by
// that user, but its member functions belong to the bootstrap superuser
// (supabase_admin on Supabase). A migration that alters every function in
// public then stops with "must be owner of function", and `supabase db push`
// with it; run as a superuser it would quietly rewrite the extension instead.
//
// The harness stands PGlite's superuser in for supabase_admin and a role
// named migrator in for postgres.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { join, startCompany, startDatabase } from './harness.mjs';

const MEMBERS_OF_PG_TRGM = `
  select p.oid::regprocedure::text as fn, p.proowner::regrole::text as owner, p.proconfig as config
  from pg_proc p
  join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
  join pg_extension e on e.oid = d.refobjid
  where e.extname = 'pg_trgm'`;

describe('every migration, applied by a non-superuser owner with pg_trgm in public', () => {
  let db;
  before(async () => {
    db = await startDatabase({ owner: 'migrator', extensions: { pg_trgm }, before: 'create extension pg_trgm;' });
  });
  after(async () => {
    await db?.close();
  });

  it('applies, and leaves the functions of the extension alone', async () => {
    const members = await db.adminRows(MEMBERS_OF_PG_TRGM);
    assert.ok(members.length > 10, 'pg_trgm is in public');
    for (const m of members) {
      assert.notEqual(m.owner, 'migrator', `${m.fn} belongs to the superuser, as on Supabase`);
      assert.equal(m.config, null, `${m.fn} was given ${m.config}`);
    }
  });

  it('still gives every function the migrations made the hardened search_path', async () => {
    const unset = await db.adminRows(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
        and not (coalesce(p.proconfig, '{}') @> array['search_path=pg_catalog, pg_temp'])`);
    assert.deepEqual(unset, []);
  });

  it('works: a company is started and a person joins it', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    assert.equal((await join(db, await db.newAccount(), company.code, 'Kit', 'Marlow')).status, 'joined');
  });
});

describe('every migration, applied by a superuser with pg_trgm in public', () => {
  it('leaves the functions of the extension alone too', async () => {
    const db = await startDatabase({ extensions: { pg_trgm }, before: 'create extension pg_trgm;' });
    try {
      const touched = (await db.adminRows(MEMBERS_OF_PG_TRGM)).filter((m) => m.config !== null).map((m) => m.fn);
      assert.deepEqual(touched, [], `${touched.length} pg_trgm functions were given a search_path`);
    } finally {
      await db.close();
    }
  });
});
