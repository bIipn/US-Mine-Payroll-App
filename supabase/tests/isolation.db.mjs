// A member of company A sees and changes nothing of company B, in any table
// or through any function, and the errors they get say nothing about B.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  errorOf,
  join,
  newMember,
  nobody,
  NO_PRIVILEGE,
  startCompany,
  startDatabase,
} from './harness.mjs';

let db;
let a; // Test Pit A: supervisor Sam Ortiz, employee Riley J Quinn
let b; // Test Pit B: supervisor Ana Diaz, employee Kit Marlow, a request from Jo Sterne
let employeeA;
let employeeB;
let requestB;
let requestA;
let outsiderA;
const errors = [];

before(async () => {
  db = await startDatabase();
  a = await startCompany(db, { name: 'Test Pit A', roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Maria', last: 'De La Cruz' }] });
  employeeA = await newMember(db, a, 'Riley', 'Quinn');
  outsiderA = await db.newAccount();
  await join(db, outsiderA, a.code, 'Pat', 'Cole');
  [requestA] = await db.adminRows('select * from public.join_requests where company_id = $1', [a.id]);

  b = await startCompany(db, { name: 'Test Pit B', state: 'NV', supervisor: ['Ana', 'Diaz'], roster: [{ first: 'Kit', last: 'Marlow' }, { first: 'Bo', last: 'Marlow' }] });
  employeeB = await newMember(db, b, 'Kit', 'Marlow');
  const asking = await db.newAccount();
  await join(db, asking, b.code, 'Jo', 'Sterne');
  [requestB] = await db.adminRows('select * from public.join_requests where company_id = $1', [b.id]);
  assert.ok(requestB);
});
after(async () => {
  await db?.close();
});

/** Everything of company B, as the owner sees it. */
async function snapshotOfB() {
  return {
    company: await db.adminRows('select * from public.companies where id = $1', [b.id]),
    roster: await db.adminRows('select * from public.roster where company_id = $1 order by id', [b.id]),
    requests: await db.adminRows('select * from public.join_requests where company_id = $1 order by id', [b.id]),
    notifications: await db.adminRows('select * from public.notifications where company_id = $1 order by id', [b.id]),
  };
}

/** The error, kept so the last test can check that none of them mentions company B. */
async function kept(promise) {
  const error = await errorOf(promise);
  errors.push(error);
  return error;
}

const membersOfA = () => [
  ['the supervisor of A', a.owner],
  ['an employee of A', employeeA],
];

describe('a member of company A', () => {
  it('reads nothing of company B in any table', async () => {
    for (const [who, account] of membersOfA()) {
      const as = db.as(account);
      assert.deepEqual(await as.rows('select * from public.companies where id = $1', [b.id]), [], who);
      assert.deepEqual(await as.rows('select * from public.roster where company_id = $1 or id = $2', [b.id, b.ownRow]), [], who);
      assert.deepEqual(await as.rows('select * from public.join_requests where company_id = $1 or id = $2', [b.id, requestB.id]), [], who);
      assert.deepEqual(await as.rows('select * from public.notifications where company_id = $1', [b.id]), [], who);

      // Everything they can read is company A's.
      assert.deepEqual((await as.rows('select id from public.companies')).map((c) => c.id), [a.id], who);
      for (const table of ['roster', 'join_requests', 'notifications']) {
        const companies = new Set((await as.rows(`select company_id from public.${table}`)).map((r) => r.company_id));
        assert.ok(!companies.has(b.id), `${who} reads ${table} of B`);
      }
    }
  });

  it('changes nothing of company B in any table', async () => {
    const before = await snapshotOfB();
    for (const [who, account] of membersOfA()) {
      const as = db.as(account);
      assert.equal(await as.affected("update public.companies set name = 'Taken', pay_period = '{}' where id = $1", [b.id]), 0, who);
      assert.equal(await as.affected("update public.roster set title = 'Taken', role = 'supervisor', active = false where company_id = $1", [b.id]), 0, who);
      assert.equal(await as.affected('delete from public.roster where company_id = $1', [b.id]), 0, who);
      assert.equal(await as.affected('update public.notifications set read_at = now() where company_id = $1', [b.id]), 0, who);

      await kept(as.query("insert into public.roster (company_id, first_name, last_name, role) values ($1, 'Lee', 'Park', 'supervisor')", [b.id]));
      // A row of their own company cannot be moved into B either.
      await kept(as.query('update public.roster set company_id = $1 where company_id = $2', [b.id, a.id]));
      await kept(as.query("insert into public.join_requests (company_id, user_id, first_name, last_name, reason) values ($1, $2, 'Lee', 'Park', 'not_on_roster')", [b.id, account]));
      await kept(as.query("insert into public.notifications (company_id, kind, request_id) values ($1, 'join_request', $2)", [b.id, requestB.id]));
      await kept(as.query('delete from public.notifications where company_id = $1', [b.id]));
      await kept(as.query("update public.join_requests set status = 'denied' where company_id = $1", [b.id]));
    }
    assert.deepEqual(await snapshotOfB(), before);
  });

  it('changes nothing of company B through any function, with the same error as for an id that does not exist', async () => {
    const before = await snapshotOfB();
    const tries = [
      ['approve_join_request', { request_id: requestB.id }, { request_id: nobody() }],
      ['approve_join_request', { request_id: requestB.id, roster_id: b.rows['Bo Marlow'], role: 'supervisor' }, { request_id: nobody(), roster_id: nobody(), role: 'supervisor' }],
      ['deny_join_request', { request_id: requestB.id }, { request_id: nobody() }],
      ['rotate_join_code', { company_id: b.id }, { company_id: nobody() }],
      ['release_roster_claim', { roster_id: b.ownRow }, { roster_id: nobody() }],
      ['release_roster_claim', { roster_id: b.rows['Kit Marlow'] }, { roster_id: nobody() }],
    ];
    for (const [who, account] of membersOfA()) {
      for (const [fn, ofB, ofNobody] of tries) {
        const error = await kept(db.as(account).call(fn, ofB));
        assert.deepEqual(error, await errorOf(db.as(account).call(fn, ofNobody)), `${who}: ${fn}`);
      }
      assert.equal(await db.as(account).call('is_member', { company_id: b.id }), false, who);
      assert.equal(await db.as(account).call('is_supervisor', { company_id: b.id }), false, who);
    }

    // A's supervisor cannot approve A's own request onto a row of B's.
    const error = await kept(db.as(a.owner).call('approve_join_request', { request_id: requestA.id, roster_id: b.rows['Bo Marlow'] }));
    assert.deepEqual(error, await errorOf(db.as(a.owner).call('approve_join_request', { request_id: requestA.id, roster_id: nobody() })));
    assert.equal((await db.adminRows('select status from public.join_requests where id = $1', [requestA.id]))[0].status, 'pending');

    assert.deepEqual(await snapshotOfB(), before);
  });

  it('gets errors that say nothing about company B', async () => {
    assert.ok(errors.length >= 20, `only ${errors.length} errors were kept`);
    const secrets = [b.id, b.code, 'Test Pit B', 'NV', ...Object.values(b.rows), requestB.id, 'Diaz', 'Marlow', 'Sterne', employeeB, b.owner];
    for (const error of errors) {
      const text = JSON.stringify(error);
      for (const secret of secrets) assert.ok(!text.includes(secret), `${text} mentions ${secret}`);
    }
    // And they are refusals, not something that half worked.
    for (const error of errors) assert.ok(['42501', 'P0002'].includes(error.code), JSON.stringify(error));
    assert.ok(errors.some((e) => e.code === NO_PRIVILEGE && /row-level security/.test(e.message)));
  });
});

describe('a supervisor of company B', () => {
  it('reads only company B, the same way round', async () => {
    const as = db.as(b.owner);
    assert.deepEqual((await as.rows('select id from public.companies')).map((c) => c.id), [b.id]);
    assert.deepEqual(new Set((await as.rows('select company_id from public.roster')).map((r) => r.company_id)), new Set([b.id]));
    assert.deepEqual((await as.rows('select id from public.join_requests')).map((r) => r.id), [requestB.id]);
    assert.deepEqual(new Set((await as.rows('select company_id from public.notifications')).map((r) => r.company_id)), new Set([b.id]));
    assert.deepEqual(await as.rows('select id from public.roster where company_id = $1', [a.id]), []);
  });
});

describe('an account in both companies', () => {
  it('reads both, and is a supervisor only where its row says so', async () => {
    const both = await newMember(db, b, 'Bo', 'Marlow');
    assert.equal((await join(db, both, a.code, 'Maria', 'De La Cruz')).status, 'joined');
    await db.as(a.owner).affected("update public.roster set role = 'supervisor' where company_id = $1 and user_id = $2", [a.id, both]);

    const as = db.as(both);
    assert.deepEqual(new Set((await as.rows('select id from public.companies')).map((c) => c.id)), new Set([a.id, b.id]));
    assert.equal(await as.call('is_supervisor', { company_id: a.id }), true);
    assert.equal(await as.call('is_supervisor', { company_id: b.id }), false);
    // A supervisor in A, an employee in B: it reads A's requests and none of B's.
    assert.deepEqual((await as.rows('select id from public.join_requests')).map((r) => r.id), [requestA.id]);
    assert.equal(await as.affected("update public.roster set title = 'Taken' where company_id = $1", [b.id]), 0);
    const error = await errorOf(as.call('deny_join_request', { request_id: requestB.id }));
    assert.equal(error.code, 'P0002');
  });
});
