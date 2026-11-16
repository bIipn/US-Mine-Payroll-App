// Regressions for what the single-session test database cannot act out
// directly, read instead from the catalog and the privileges. races.db.mjs
// acts the races out on a real PostgreSQL server when one is given.
//
//  * The last-supervisor guard writes a row for each company that lost a
//    counting supervisor before it counts (migration 20261116001700). A lock
//    alone (20261116001400) made no new row version, so at REPEATABLE READ a
//    second transaction waited, then counted with its older snapshot and let
//    both through. A write makes the second one wait at READ COMMITTED and
//    then see the first, and fail with a serialization error at REPEATABLE
//    READ or SERIALIZABLE.
//  * approve_join_request and deny_join_request take the same per-account lock
//    as join_company, before they lock the request, so they take turns with a
//    join by that account (migration 20261116002000).
//  * The server key cannot empty a table with TRUNCATE, which fires no row or
//    statement trigger (migration 20261116001500, and the newer tables).
//
// All names are made up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { refused, secondSupervisor, startCompany, startDatabase } from './harness.mjs';

const TABLES = ['companies', 'roster', 'join_requests', 'notifications', 'company_supervisor_guard', 'join_holds'];

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const sourceOf = async (name) =>
  (await db.adminRows("select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1", [name]))[0].prosrc;

describe('the last-supervisor guard', () => {
  it('writes a row for each affected company before it counts, so overlapping removals cannot both pass', async () => {
    const prosrc = await sourceOf('roster_keeps_a_supervisor');
    const write = prosrc.search(/insert\s+into\s+public\.company_supervisor_guard[\s\S]*on\s+conflict\s*\(company_id\)\s*do\s+update/i);
    assert.ok(write >= 0, 'the guard counts without writing a row per company first');
    assert.ok(write < prosrc.search(/raise\s+exception/i), 'the write comes before the count');
    assert.doesNotMatch(prosrc, /for\s+no\s+key\s+update/i, 'a bare row lock makes no row version to conflict on');
  });

  it('leaves a row for the company once a supervisor steps down, and the row goes with the company', async () => {
    const company = await startCompany(db);
    await secondSupervisor(db, company);
    const guardRows = async () => (await db.adminRows('select count(*)::int as n from public.company_supervisor_guard where company_id = $1', [company.id]))[0].n;
    assert.equal(await guardRows(), 0);
    await db.as(company.owner).query("update public.roster set role = 'employee' where id = $1", [company.ownRow]);
    assert.equal(await guardRows(), 1);
    await db.serviceRole().query('delete from public.companies where id = $1', [company.id]);
    assert.equal(await guardRows(), 0);
  });
});

describe('deciding a request', () => {
  for (const fn of ['approve_join_request', 'deny_join_request']) {
    it(`${fn} takes the per-account lock join_company takes, before it locks the request`, async () => {
      const prosrc = await sourceOf(fn);
      const lock = prosrc.search(/pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\('join_company '/i);
      assert.ok(lock >= 0, `${fn} does not take the per-account lock`);
      assert.ok(lock < prosrc.search(/for\s+update/i), `${fn} locks the request before the per-account lock`);
    });
  }
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
