// Two API requests at the same instant, acted out on a real PostgreSQL server
// (see server.mjs; skipped without one). PGlite is one session and cannot
// overlap two transactions, so these are the only tests that can show:
//
//  * the last-supervisor guard holding when two supervisors step down at once,
//    at READ COMMITTED (PostgREST's default) and also at REPEATABLE READ and
//    SERIALIZABLE, where a direct connection or a function may run. A guard
//    that only locks the company makes no new row version, so a REPEATABLE READ
//    transaction that waited on the lock counts with its older snapshot and
//    lets both through; the guard has to write.
//  * approve_join_request taking turns with join_company for the same account,
//    so a person who types a name while a supervisor approves their request
//    gets an answer (already_member), not a raw duplicate-key error.
//
// All names are made up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { skipWithoutServer, startServerDatabase } from './server.mjs';

let db;
before(async () => {
  if (!skipWithoutServer) db = await startServerDatabase();
});
after(async () => {
  await db?.drop();
});

/** A company with two supervisors, each with an account on their row. */
async function twoSupervisors() {
  const first = await db.newAccount();
  const second = await db.newAccount();
  const [made] = await db.asAccount(
    first,
    "select * from public.create_company(name => 'Test Pit A', state => 'CA', timezone => null, first_name => 'Sam', last_name => 'Ortiz')",
  );
  const [row] = await db.asAccount(
    first,
    "insert into public.roster (company_id, first_name, last_name, role) values ($1, 'Riley J', 'Quinn', 'supervisor') returning id",
    [made.company_id],
  );
  await db.asAccount(second, "select public.join_company(code => $1, first_name => 'Riley', last_name => 'Quinn')", [made.join_code]);
  const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'pending'", [second]);
  await db.asAccount(first, 'select public.approve_join_request(request_id => $1, roster_id => $2)', [request.id, row.id]);
  const [own] = await db.adminRows('select id from public.roster where user_id = $1', [first]);
  return { id: made.company_id, code: made.join_code, first, second, firstRow: own.id, secondRow: row.id };
}

/** Commit a request whose statement went through, or roll it back. A refusal at commit counts as the outcome. */
async function finish(request, outcome) {
  if (!outcome.ok) {
    await request.rollback();
    return outcome;
  }
  try {
    await request.commit();
    return outcome;
  } catch (error) {
    return { ok: false, code: error.code, message: error.message, atCommit: true };
  }
}

async function supervisorsLeft(companyId) {
  const [{ n }] = await db.adminRows(
    "select count(*)::int as n from public.roster where company_id = $1 and role = 'supervisor' and active and user_id is not null",
    [companyId],
  );
  return n;
}

const AT_ONCE = {
  'both step down by a role change': (co) => [
    [co.first, "update public.roster set role = 'employee' where id = $1", [co.firstRow]],
    [co.second, "update public.roster set role = 'employee' where id = $1", [co.secondRow]],
  ],
  'they release each other': (co) => [
    [co.first, 'select public.release_roster_claim(roster_id => $1)', [co.secondRow]],
    [co.second, 'select public.release_roster_claim(roster_id => $1)', [co.firstRow]],
  ],
  'one takes themself off while the other deletes their own row': (co) => [
    [co.first, 'update public.roster set active = false where id = $1', [co.firstRow]],
    [co.second, 'delete from public.roster where id = $1', [co.secondRow]],
  ],
};

// What the second request is told: READ COMMITTED waits and then sees the first
// one's change; the stricter levels are told to try again.
const SECOND_IS_TOLD = { 'read committed': '23514', 'repeatable read': '40001', serializable: '40001' };

for (const [isolation, expected] of Object.entries(SECOND_IS_TOLD)) {
  describe(`two supervisors stepping down at once, at ${isolation}`, { skip: skipWithoutServer }, () => {
    for (const [path, make] of Object.entries(AT_ONCE)) {
      it(`leave the company a supervisor when ${path}`, async () => {
        const co = await twoSupervisors();
        const [[accountA, sqlA, paramsA], [accountB, sqlB, paramsB]] = make(co);
        const a = await db.request(accountA, isolation);
        // B's transaction, and at the stricter levels its snapshot, starts before A commits.
        const b = await db.request(accountB, isolation);
        await a.query(sqlA, paramsA);
        const { settled } = await b.start(sqlB, paramsB);
        await a.commit();
        const outcome = await finish(b, await settled);
        await a.end();
        await b.end();

        assert.equal(await supervisorsLeft(co.id), 1, `both went through: ${JSON.stringify(outcome)}`);
        assert.equal(outcome.ok, false, 'the second request should be refused');
        assert.equal(outcome.code, expected, outcome.message);
      });
    }
  });
}

describe('approving a request while the same person types a name', { skip: skipWithoutServer }, () => {
  it('takes turns with join_company, so the person is told already_member', async () => {
    const owner = await db.newAccount();
    const person = await db.newAccount();
    const [made] = await db.asAccount(
      owner,
      "select * from public.create_company(name => 'Test Pit A', state => 'CA', timezone => null, first_name => 'Sam', last_name => 'Ortiz')",
    );
    await db.asAccount(owner, "insert into public.roster (company_id, first_name, last_name) values ($1, 'Bo', 'Ellison')", [made.company_id]);
    await db.asAccount(person, "select public.join_company(code => $1, first_name => 'Pat', last_name => 'Cole')", [made.join_code]);
    const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'pending'", [person]);

    // The supervisor approves the request onto a new row, and before that commits the person types a coworker's name.
    const approving = await db.request(owner);
    await approving.query('select public.approve_join_request(request_id => $1)', [request.id]);
    const joining = await db.request(person);
    const { settled } = await joining.start("select public.join_company(code => $1, first_name => 'Bo', last_name => 'Ellison') as result", [made.join_code]);
    await approving.commit();
    const outcome = await finish(joining, await settled);
    await approving.end();
    await joining.end();

    assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    assert.equal(outcome.rows[0].result.status, 'already_member');
    const rows = await db.adminRows("select first_name from public.roster where user_id = $1", [person]);
    assert.deepEqual(rows, [{ first_name: 'Pat' }]);
    assert.equal((await db.adminRows("select user_id from public.roster where company_id = $1 and first_name = 'Bo'", [made.company_id]))[0].user_id, null);
  });
});
