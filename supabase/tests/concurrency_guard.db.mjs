// Regressions for two things the single-session test database cannot act out
// directly, read instead from the catalog and the privileges:
//
//  * migration 20261116001400: the last-supervisor guard locks each affected
//    company before it counts, so two overlapping statements that each remove a
//    different supervisor are judged one after the other (write skew) rather
//    than both passing. PGlite is one session and cannot overlap two
//    transactions, so this asserts the guard takes the lock; the behavioural
//    single-session cases are in supervisor-guard.db.mjs.
//
//  * migration 20261116001500: the server key cannot empty a table with
//    TRUNCATE, which fires no row or statement trigger.
//
// All names are made up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { refused, startCompany, startDatabase } from './harness.mjs';

const TABLES = ['companies', 'roster', 'join_requests', 'notifications'];

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

describe('the last-supervisor guard', () => {
  it('locks each affected company before it counts, so overlapping removals cannot both pass', async () => {
    const [{ prosrc }] = await db.adminRows(
      "select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'roster_keeps_a_supervisor'",
    );
    // It takes a per-company lock (a row lock here) before the count that follows.
    assert.match(prosrc, /for no key update/i, 'the guard counts without locking the company first');
    assert.match(prosrc, /companies/i);
  });
});

describe('the server key', () => {
  it('holds no TRUNCATE on any of the tables', async () => {
    for (const table of TABLES) {
      const [{ has }] = await db.adminRows("select has_table_privilege('service_role', $1, 'TRUNCATE') as has", [`public.${table}`]);
      assert.equal(has, false, `service_role TRUNCATE on ${table}`);
    }
  });

  it('cannot take the last supervisor away with TRUNCATE', async () => {
    const company = await startCompany(db);
    await refused(db.serviceRole().query('truncate public.roster cascade'), '42501', /permission denied/);
    const [{ n }] = await db.adminRows(
      "select count(*)::int as n from public.roster where company_id = $1 and role = 'supervisor' and active and user_id is not null",
      [company.id],
    );
    assert.equal(n, 1);
    assert.equal((await db.adminRows('select count(*)::int as n from public.companies where id = $1', [company.id]))[0].n, 1);
  });
});
