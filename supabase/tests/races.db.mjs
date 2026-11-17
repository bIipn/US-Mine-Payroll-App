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
//  * the server stepping two supervisors down at once (step_down_everywhere,
//    before it bans them): the second is refused, as two supervisors stepping
//    down themselves are.
//  * join_company taking turns with a supervisor's change to the caller's own
//    row: releasing or deleting a removed person's row, or taking them back,
//    while they type a name. Without that, a change committing between
//    join_company's reads was half seen: a removed person claimed a coworker's
//    row by name, or an active member was left a fresh pending request.
//  * a row renamed while its old name is typed is not claimed under its new name.
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

describe('the server stepping both supervisors down at once', { skip: skipWithoutServer }, () => {
  for (const [isolation, expected] of Object.entries(SECOND_IS_TOLD)) {
    it(`leaves the company a supervisor, at ${isolation}`, async () => {
      const co = await twoSupervisors();
      const a = await db.request(co.first, isolation);
      const b = await db.request(co.second, isolation);
      for (const server of [a, b]) await server.query('set local role service_role');
      await a.query('select public.step_down_everywhere(user_id => $1)', [co.first]);
      const { settled } = await b.start('select public.step_down_everywhere(user_id => $1)', [co.second]);
      await a.commit();
      const outcome = await finish(b, await settled);
      await a.end();
      await b.end();

      assert.equal(await supervisorsLeft(co.id), 1, `both went through: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.ok, false, 'the second step-down should be refused, so the server does not ban that account');
      assert.equal(outcome.code, expected, outcome.message);
    });
  }
});

/** A company with Kit Marlow (claimed by kit, then taken off the roster) and Bo Ellison (unclaimed). */
async function removedKit({ leaveRequest }) {
  const owner = await db.newAccount();
  const kit = await db.newAccount();
  const [made] = await db.asAccount(
    owner,
    "select * from public.create_company(name => 'Test Pit A', state => 'CA', timezone => null, first_name => 'Sam', last_name => 'Ortiz')",
  );
  const [kitRow] = await db.asAccount(owner, "insert into public.roster (company_id, first_name, last_name) values ($1, 'Kit', 'Marlow') returning id", [made.company_id]);
  const [boRow] = await db.asAccount(owner, "insert into public.roster (company_id, first_name, last_name) values ($1, 'Bo', 'Ellison') returning id", [made.company_id]);
  const [joined] = await db.asAccount(kit, "select public.join_company(code => $1, first_name => 'Kit', last_name => 'Marlow') as r", [made.join_code]);
  assert.equal(joined.r.status, 'joined');
  await db.asAccount(owner, 'update public.roster set active = false where id = $1', [kitRow.id]);
  if (leaveRequest) {
    const [typed] = await db.asAccount(kit, "select public.join_company(code => $1, first_name => 'Kit', last_name => 'Marlow') as r", [made.join_code]);
    assert.equal(typed.r.reason, 'removed');
  }
  return { owner, kit, companyId: made.company_id, code: made.join_code, kitRow: kitRow.id, boRow: boRow.id };
}

/**
 * A supervisor's change to a removed person's row, held open while that person
 * types a name, then committed. Returns join_company's answer.
 */
async function typedDuring(co, change, params, first, last) {
  const supervisor = await db.request(co.owner);
  await supervisor.query(change, params);
  const person = await db.request(co.kit);
  const { settled } = await person.start('select public.join_company(code => $1, first_name => $2, last_name => $3) as result', [co.code, first, last]);
  await supervisor.commit();
  const outcome = await finish(person, await settled);
  await supervisor.end();
  await person.end();
  assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
  return outcome.rows[0].result;
}

const PENDING_RELEASED = { status: 'pending', company_name: 'Test Pit A', reason: 'released' };

describe('a supervisor changing a removed person\'s row while they type a name', { skip: skipWithoutServer }, () => {
  it('releasing it: join_company waits for the release and is held by it, so no coworker row is claimed', async () => {
    const co = await removedKit({ leaveRequest: false });
    const answer = await typedDuring(co, 'select public.release_roster_claim(roster_id => $1)', [co.kitRow], 'Bo', 'Ellison');
    assert.deepEqual(answer, PENDING_RELEASED);
    assert.deepEqual(await db.adminRows('select user_id from public.roster where id = $1', [co.boRow]), [{ user_id: null }]);
  });

  it('deleting it: the same', async () => {
    const co = await removedKit({ leaveRequest: false });
    const answer = await typedDuring(co, 'delete from public.roster where id = $1', [co.kitRow], 'Bo', 'Ellison');
    assert.deepEqual(answer, PENDING_RELEASED);
    assert.deepEqual(await db.adminRows('select user_id from public.roster where id = $1', [co.boRow]), [{ user_id: null }]);
  });

  it('taking them back on it: they are told already_member, and no pending request is left to re-admit them later', async () => {
    const co = await removedKit({ leaveRequest: true });
    const answer = await typedDuring(co, 'update public.roster set active = true where id = $1', [co.kitRow], 'Kit', 'Marlow');
    assert.deepEqual(answer, { status: 'already_member', company_name: 'Test Pit A', role: 'employee' });
    assert.deepEqual(await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'pending'", [co.kit]), []);
  });
});

describe('a row renamed while its old name is typed', { skip: skipWithoutServer }, () => {
  it('is not handed to the account that typed the old name', async () => {
    const owner = await db.newAccount();
    const [made] = await db.asAccount(
      owner,
      "select * from public.create_company(name => 'Test Pit A', state => 'CA', timezone => null, first_name => 'Sam', last_name => 'Ortiz')",
    );
    const [row] = await db.asAccount(owner, "insert into public.roster (company_id, first_name, last_name) values ($1, 'Bo', 'Ellison') returning id", [made.company_id]);

    // The supervisor corrects the row to Pat Cole; before that commits, someone types "Bo Ellison".
    const renaming = await db.request(owner);
    await renaming.query("update public.roster set first_name = 'Pat', last_name = 'Cole' where id = $1", [row.id]);
    const typist = await db.newAccount();
    const joining = await db.request(typist);
    const { settled } = await joining.start("select public.join_company(code => $1, first_name => 'Bo', last_name => 'Ellison') as result", [made.join_code]);
    await renaming.commit();
    const outcome = await finish(joining, await settled);
    await renaming.end();
    await joining.end();

    assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    assert.deepEqual(outcome.rows[0].result, { status: 'pending', company_name: 'Test Pit A', reason: 'not_on_roster' });
    const [after] = await db.adminRows('select first_name, last_name, user_id from public.roster where id = $1', [row.id]);
    assert.deepEqual(after, { first_name: 'Pat', last_name: 'Cole', user_id: null }, 'the row now named Pat Cole went to the account that typed Bo Ellison');
  });
});
