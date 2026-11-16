// A company always keeps at least one active supervisor with an account, on
// every path: a role change, taking the row off, deleting it, releasing its
// claim, and deleting the account.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addToRoster,
  join,
  LAST_SUPERVISOR,
  newMember,
  refused,
  rosterRow,
  secondSupervisor,
  startCompany,
  startDatabase,
} from './harness.mjs';

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const LAST = /at least one active supervisor/;

/** The ways a supervisor's row can stop counting. Each takes the supervisor making the change and the row. */
const PATHS = {
  'a role change': (as, row) => as.query("update public.roster set role = 'employee' where id = $1", [row]),
  'taking the row off the roster': (as, row) => as.query('update public.roster set active = false where id = $1', [row]),
  'deleting the row': (as, row) => as.query('delete from public.roster where id = $1', [row]),
  'releasing the claim': (as, row) => as.call('release_roster_claim', { roster_id: row }),
};

async function supervisorsOf(company) {
  return db.adminRows(
    "select id, user_id from public.roster where company_id = $1 and role = 'supervisor' and active and user_id is not null order by id",
    [company.id],
  );
}

describe('the only supervisor', () => {
  for (const [path, change] of Object.entries(PATHS)) {
    it(`cannot step down by ${path}`, async () => {
      const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
      const before = await rosterRow(db, company.ownRow);
      await refused(change(db.as(company.owner), company.ownRow), LAST_SUPERVISOR, LAST);
      assert.deepEqual(await rosterRow(db, company.ownRow), before);
      assert.equal(await db.as(company.owner).call('is_supervisor', { company_id: company.id }), true);
    });
  }

  it("cannot be taken away by deleting the supervisor's account", async () => {
    const company = await startCompany(db);
    await refused(db.admin('delete from auth.users where id = $1', [company.owner]), LAST_SUPERVISOR, LAST);
    assert.equal((await db.adminRows('select count(*)::int as n from auth.users where id = $1', [company.owner]))[0].n, 1);
    assert.equal((await rosterRow(db, company.ownRow)).user_id, company.owner);
  });

  it("cannot be taken away even with the server's key", async () => {
    const company = await startCompany(db);
    for (const sql of [
      "update public.roster set role = 'employee' where id = $1",
      'update public.roster set active = false where id = $1',
      'update public.roster set user_id = null where id = $1',
      'delete from public.roster where id = $1',
    ]) {
      await refused(db.serviceRole().query(sql, [company.ownRow]), LAST_SUPERVISOR, LAST);
    }
    assert.equal((await supervisorsOf(company)).length, 1);
  });

  it('is not replaced by a supervisor row nobody has claimed, or one taken off the roster', async () => {
    const company = await startCompany(db);
    await addToRoster(db, company.owner, company.id, { first: 'Riley J', last: 'Quinn', role: 'supervisor' }, company.rows);
    const second = await secondSupervisor(db, company, 'Ana', 'Diaz');
    // The second one steps down from the roster: allowed, since the first is still there.
    await db.as(second).affected('update public.roster set active = false where user_id = $1', [second]);
    for (const [path, change] of Object.entries(PATHS)) {
      await refused(change(db.as(company.owner), company.ownRow), LAST_SUPERVISOR, LAST, path);
    }
    assert.deepEqual((await supervisorsOf(company)).map((r) => r.id), [company.ownRow]);
  });
});

describe('with a second supervisor', () => {
  for (const [path, change] of Object.entries(PATHS)) {
    it(`either one can step down by ${path}, but not both`, async () => {
      const company = await startCompany(db);
      const second = await secondSupervisor(db, company);
      const secondRow = company.rows['Riley J Quinn'];
      await change(db.as(company.owner), company.ownRow);
      assert.deepEqual((await supervisorsOf(company)).map((r) => r.user_id), [second]);
      await refused(change(db.as(second), secondRow), LAST_SUPERVISOR, LAST);
      assert.deepEqual((await supervisorsOf(company)).map((r) => r.user_id), [second]);
    });
  }

  it('one statement cannot take away every supervisor at once', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Maria', last: 'De La Cruz' }] });
    await secondSupervisor(db, company);
    await newMember(db, company, 'Maria', 'De La Cruz');
    await refused(
      db.as(company.owner).query("update public.roster set role = 'employee' where company_id = $1", [company.id]),
      LAST_SUPERVISOR,
      LAST,
    );
    await refused(db.as(company.owner).query('delete from public.roster where company_id = $1', [company.id]), LAST_SUPERVISOR, LAST);
    assert.equal((await supervisorsOf(company)).length, 2);
  });

  it("lets the first one's account be deleted", async () => {
    const company = await startCompany(db);
    const second = await secondSupervisor(db, company);
    await db.admin('delete from auth.users where id = $1', [company.owner]);
    const row = await rosterRow(db, company.ownRow);
    assert.equal(row.user_id, null);
    assert.equal(row.claimed_at, null);
    assert.deepEqual((await supervisorsOf(company)).map((r) => r.user_id), [second]);
  });

  it('lets one release the other, who can then claim the row again', async () => {
    const company = await startCompany(db);
    const second = await secondSupervisor(db, company);
    await db.as(company.owner).call('release_roster_claim', { roster_id: company.rows['Riley J Quinn'] });
    assert.equal(await db.as(second).call('is_supervisor', { company_id: company.id }), false);
    assert.equal((await join(db, second, company.code, 'Riley', 'Quinn')).status, 'joined');
    assert.equal(await db.as(second).call('is_supervisor', { company_id: company.id }), true);
  });
});

describe('the guard', () => {
  it('does not hold up changes to anyone else, or releasing a row nobody claimed', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Maria', last: 'De La Cruz' }, { first: 'Lee', last: 'Park' }] });
    const member = await newMember(db, company, 'Maria', 'De La Cruz');
    const as = db.as(company.owner);
    assert.equal(await as.affected("update public.roster set title = 'Scale house', active = false where id = $1", [company.rows['Maria De La Cruz']]), 1);
    assert.equal(await as.affected("update public.roster set title = 'Pit boss' where id = $1", [company.ownRow]), 1);
    assert.equal(await as.call('release_roster_claim', { roster_id: company.rows['Lee Park'] }), '');
    assert.equal(await as.affected('delete from public.roster where id = $1', [company.rows['Lee Park']]), 1);
    assert.equal(await db.as(member).call('is_member', { company_id: company.id }), false);
  });

  it('lets the whole company be deleted, with its roster, requests and notifications', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Maria', last: 'De La Cruz' }] });
    await newMember(db, company, 'Maria', 'De La Cruz');
    await join(db, await db.newAccount(), company.code, 'Pat', 'Cole');
    await db.serviceRole().query('delete from public.companies where id = $1', [company.id]);
    for (const table of ['roster', 'join_requests', 'notifications']) {
      const [{ n }] = await db.adminRows(`select count(*)::int as n from public.${table} where company_id = $1`, [company.id]);
      assert.equal(n, 0, table);
    }
  });
});
