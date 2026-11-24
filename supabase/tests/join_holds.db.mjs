// What the database remembers about an account a supervisor has acted on, so
// the supervisor's decision holds (migration 20261116002000):
//  * an account whose claim was released, or whose row was deleted, cannot
//    take a row back by typing a name: it leaves a 'released' request;
//  * the right person can be handed a claimed row in one step, so nobody with
//    the code can take it in between;
//  * taking someone back on their old row settles the request they left while
//    they were off;
//  * joining settles the account's pending request as 'withdrawn' and keeps
//    it, so a supervisor still sees that the account first typed a claimed
//    coworker's name;
//  * a supervisor can deny with a bar, which keeps that account out of the
//    company until a supervisor lifts it;
//  * a bar and a release are kept apart, so lifting the bar leaves the release
//    (migration 20261116002600).
//
// All names are made up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  join,
  LAST_SUPERVISOR,
  newMember,
  NOT_FOUND,
  refused,
  rosterRow,
  startCompany,
  startDatabase,
  WRONG_STATE,
} from './harness.mjs';

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const pendingOf = async (account) =>
  (await db.adminRows("select * from public.join_requests where user_id = $1 and status = 'pending'", [account]))[0];
const requestRow = async (id) => (await db.adminRows('select * from public.join_requests where id = $1', [id]))[0];
const approve = (supervisor, args) => db.as(supervisor).call('approve_join_request', args);
const deny = (supervisor, args) => db.as(supervisor).call('deny_join_request', args);
const deactivate = (company, rowId) => db.as(company.owner).affected('update public.roster set active = false where id = $1', [rowId]);
const PENDING_RELEASED = { status: 'pending', company_name: 'Test Pit A', reason: 'released' };

describe('an account whose claim a supervisor released', () => {
  it('cannot take the row straight back, so the right person can be approved onto it', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const rowId = company.rows['Riley J Quinn'];
    const impostor = await newMember(db, company, 'Riley', 'Quinn');
    const riley = await db.newAccount();
    assert.equal((await join(db, riley, company.code, 'Riley J', 'Quinn')).reason, 'already_claimed');

    await db.as(company.owner).call('release_roster_claim', { roster_id: rowId });
    assert.deepEqual(await join(db, impostor, company.code, 'Riley', 'Quinn'), PENDING_RELEASED);
    assert.equal((await rosterRow(db, rowId)).user_id, null);

    const request = await pendingOf(riley);
    assert.equal(await approve(company.owner, { request_id: request.id, roster_id: rowId }), rowId);
    assert.equal((await rosterRow(db, rowId)).user_id, riley);
  });

  it('is let in only by a supervisor approving its request, which lifts the hold', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }, { first: 'Bo', last: 'Ellison' }] });
    const kit = await newMember(db, company, 'Kit', 'Marlow');
    await db.as(company.owner).call('release_roster_claim', { roster_id: company.rows['Kit Marlow'] });
    assert.deepEqual(await join(db, kit, company.code, 'Bo', 'Ellison'), PENDING_RELEASED);
    await approve(company.owner, { request_id: (await pendingOf(kit)).id, roster_id: company.rows['Kit Marlow'] });
    assert.equal(await db.as(kit).call('is_member', { company_id: company.id }), true);
    assert.deepEqual(await db.adminRows('select * from public.join_holds where user_id = $1', [kit]), []);
  });
});

describe('a person taken off the roster', () => {
  it('is not let back in by name once a supervisor releases their old row', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    await deactivate(company, company.rows['Riley J Quinn']);
    assert.equal((await join(db, riley, company.code, 'Riley', 'Quinn')).reason, 'removed');
    await deny(company.owner, { request_id: (await pendingOf(riley)).id });

    await db.as(company.owner).call('release_roster_claim', { roster_id: company.rows['Riley J Quinn'] });
    assert.deepEqual(await join(db, riley, company.code, 'Kit', 'Marlow'), PENDING_RELEASED);
    assert.equal((await rosterRow(db, company.rows['Kit Marlow'])).user_id, null);
  });

  it('is not let back in by name once a supervisor deletes their old row', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    await deactivate(company, company.rows['Riley J Quinn']);
    assert.equal(await db.as(company.owner).affected('delete from public.roster where id = $1', [company.rows['Riley J Quinn']]), 1);

    assert.deepEqual(await join(db, riley, company.code, 'Kit', 'Marlow'), PENDING_RELEASED);
    assert.equal((await rosterRow(db, company.rows['Kit Marlow'])).user_id, null);
  });

  it('who is taken back on their old row has the request they left settled, so it cannot re-admit them later', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    const rowId = company.rows['Kit Marlow'];
    const kit = await newMember(db, company, 'Kit', 'Marlow');
    await deactivate(company, rowId);
    assert.equal((await join(db, kit, company.code, 'Kit', 'Marlow')).reason, 'removed');
    const left = await pendingOf(kit);

    // A supervisor takes Kit back on the old row.
    await db.as(company.owner).affected('update public.roster set active = true where id = $1', [rowId]);
    assert.equal((await requestRow(left.id)).status, 'withdrawn');
    assert.deepEqual(await db.as(company.owner).rows("select id from public.join_requests where company_id = $1 and status = 'pending'", [company.id]), []);

    // Taken off again, the old request cannot be approved to bring them back.
    await deactivate(company, rowId);
    await refused(approve(company.owner, { request_id: left.id }), WRONG_STATE, /already been decided/);
    assert.equal(await db.as(kit).call('is_member', { company_id: company.id }), false);
  });
});

describe('handing a claimed row to the right person', () => {
  it('is one step with replace_claim, so nobody with the code can take the row in between', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const rowId = company.rows['Riley J Quinn'];
    const impostor = await newMember(db, company, 'Riley', 'Quinn');
    const riley = await db.newAccount();
    await join(db, riley, company.code, 'Riley J', 'Quinn');
    const request = await pendingOf(riley);

    await refused(approve(company.owner, { request_id: request.id, roster_id: rowId }), WRONG_STATE, /already claimed/);
    assert.equal(await approve(company.owner, { request_id: request.id, roster_id: rowId, replace_claim: true }), rowId);
    assert.equal((await rosterRow(db, rowId)).user_id, riley);
    assert.equal(await db.as(impostor).call('is_member', { company_id: company.id }), false);
    // The account it was taken from is held like any released one.
    assert.deepEqual(await join(db, impostor, company.code, 'Riley', 'Quinn'), PENDING_RELEASED);
  });

  it('still cannot take the last supervisor away', async () => {
    const company = await startCompany(db);
    const someone = await db.newAccount();
    await join(db, someone, company.code, 'Pat', 'Cole');
    const request = await pendingOf(someone);
    await refused(approve(company.owner, { request_id: request.id, roster_id: company.ownRow, replace_claim: true }), LAST_SUPERVISOR);
    assert.equal((await rosterRow(db, company.ownRow)).user_id, company.owner);
    assert.equal((await requestRow(request.id)).status, 'pending');
  });
});

describe('joining with a request pending', () => {
  it('keeps the request, withdrawn, with its notification, so the attempt is not erased', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }] });
    await newMember(db, company, 'Riley', 'Quinn');
    const sly = await db.newAccount();
    assert.equal((await join(db, sly, company.code, 'Riley J', 'Quinn')).reason, 'already_claimed');
    const attempt = await pendingOf(sly);
    assert.equal((await join(db, sly, company.code, 'Kit', 'Marlow')).status, 'joined');

    const seen = await db.as(company.owner).rows('select id, reason, status, decided_by from public.join_requests where company_id = $1', [company.id]);
    assert.deepEqual(seen, [{ id: attempt.id, reason: 'already_claimed', status: 'withdrawn', decided_by: null }]);
    const notices = await db.as(company.owner).rows('select kind, request_id from public.notifications where company_id = $1 order by created_at, id', [company.id]);
    assert.deepEqual(notices.map((n) => n.kind), ['joined', 'join_request', 'joined']);
    assert.equal(notices[1].request_id, attempt.id);

    // A withdrawn request is settled: it cannot be approved or denied.
    await refused(approve(company.owner, { request_id: attempt.id }), WRONG_STATE, /already been decided/);
    await refused(deny(company.owner, { request_id: attempt.id }), WRONG_STATE, /already been decided/);
    assert.deepEqual((await db.as(sly).callRows('my_join_requests')).map((r) => r.status), ['withdrawn']);
  });
});

describe('denying with a bar', () => {
  it('keeps the account out: no more requests, no more notifications, no row by name', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    const stranger = await db.newAccount();
    await join(db, stranger, company.code, 'Pat', 'Cole');
    await deny(company.owner, { request_id: (await pendingOf(stranger)).id, bar: true });
    const notices = async () => (await db.adminRows('select count(*)::int as n from public.notifications where company_id = $1', [company.id]))[0].n;
    const before = await notices();

    for (const [first, last] of [['Pat', 'Cole'], ['Kit', 'Marlow']]) {
      assert.deepEqual(await join(db, stranger, company.code, first, last), { status: 'denied', company_name: 'Test Pit A' });
    }
    assert.equal((await db.adminRows('select count(*)::int as n from public.join_requests where user_id = $1', [stranger]))[0].n, 1);
    assert.equal(await notices(), before);
    assert.equal((await rosterRow(db, company.rows['Kit Marlow'])).user_id, null);
  });

  it('holds only in that company', async () => {
    const a = await startCompany(db);
    const b = await startCompany(db, { name: 'Test Pit B', roster: [{ first: 'Kit', last: 'Marlow' }] });
    const kit = await db.newAccount();
    await join(db, kit, a.code, 'Kit', 'Marlow');
    await deny(a.owner, { request_id: (await pendingOf(kit)).id, bar: true });
    assert.equal((await join(db, kit, b.code, 'Kit', 'Marlow')).status, 'joined');
  });

  it('is lifted by a supervisor of the company, after which the account may ask again', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const employee = await newMember(db, company, 'Riley', 'Quinn');
    const other = await startCompany(db, { name: 'Test Pit B' });
    const stranger = await db.newAccount();
    await join(db, stranger, company.code, 'Pat', 'Cole');
    const denied = await pendingOf(stranger);
    await deny(company.owner, { request_id: denied.id, bar: true });

    for (const who of [employee, other.owner, stranger]) {
      await refused(db.as(who).call('lift_join_bar', { request_id: denied.id }), NOT_FOUND, /No such join request/);
    }
    assert.equal((await join(db, stranger, company.code, 'Pat', 'Cole')).status, 'denied');
    await db.as(company.owner).call('lift_join_bar', { request_id: denied.id });
    assert.equal((await join(db, stranger, company.code, 'Pat', 'Cole')).status, 'pending');
  });

  it('is not what a plain denial does: that account may still ask again', async () => {
    const company = await startCompany(db);
    const stranger = await db.newAccount();
    await join(db, stranger, company.code, 'Pat', 'Cole');
    await deny(company.owner, { request_id: (await pendingOf(stranger)).id });
    assert.equal((await join(db, stranger, company.code, 'Pat', 'Cole')).status, 'pending');
  });
});

describe('a bar on an account that is also held for a release', () => {
  const holdsOf = async (company, account) =>
    (await db.adminRows('select kind from public.join_holds where company_id = $1 and user_id = $2 order by kind', [company.id, account])).map((h) => h.kind);

  it('when lifted, leaves the release, so the impostor whose claim was released cannot type the row back', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const rowId = company.rows['Riley J Quinn'];
    const impostor = await newMember(db, company, 'Riley', 'Quinn');
    await db.as(company.owner).call('release_roster_claim', { roster_id: rowId });
    assert.deepEqual(await join(db, impostor, company.code, 'Riley', 'Quinn'), PENDING_RELEASED);

    // The impostor keeps asking, and is barred; later the bar is lifted.
    const request = await pendingOf(impostor);
    await deny(company.owner, { request_id: request.id, bar: true });
    assert.equal((await join(db, impostor, company.code, 'Riley', 'Quinn')).status, 'denied');
    assert.deepEqual(await holdsOf(company, impostor), ['barred', 'released']);
    await db.as(company.owner).call('lift_join_bar', { request_id: request.id });
    assert.deepEqual(await holdsOf(company, impostor), ['released']);

    // It may ask again, as a lifted bar allows, but it is still held: it does not take the row.
    assert.deepEqual(await join(db, impostor, company.code, 'Riley', 'Quinn'), PENDING_RELEASED);
    assert.equal((await rosterRow(db, rowId)).user_id, null);
  });

  it('when lifted, leaves the hold on a removed person whose row was deleted', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }, { first: 'Bo', last: 'Ellison' }] });
    const kit = await newMember(db, company, 'Kit', 'Marlow');
    await deactivate(company, company.rows['Kit Marlow']);
    assert.equal(await db.as(company.owner).affected('delete from public.roster where id = $1', [company.rows['Kit Marlow']]), 1);
    assert.deepEqual(await join(db, kit, company.code, 'Kit', 'Marlow'), PENDING_RELEASED);
    const request = await pendingOf(kit);
    await deny(company.owner, { request_id: request.id, bar: true });
    await db.as(company.owner).call('lift_join_bar', { request_id: request.id });

    assert.deepEqual(await join(db, kit, company.code, 'Bo', 'Ellison'), PENDING_RELEASED);
    assert.equal((await rosterRow(db, company.rows['Bo Ellison'])).user_id, null);
  });

  it('given after the bar, is not swallowed by it either', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }, { first: 'Bo', last: 'Ellison' }] });
    const kit = await newMember(db, company, 'Kit', 'Marlow');
    await deactivate(company, company.rows['Kit Marlow']);
    assert.equal((await join(db, kit, company.code, 'Kit', 'Marlow')).reason, 'removed');
    const request = await pendingOf(kit);
    // Barred while off the roster, then the old row is deleted, which holds the account too.
    await deny(company.owner, { request_id: request.id, bar: true });
    assert.equal(await db.as(company.owner).affected('delete from public.roster where id = $1', [company.rows['Kit Marlow']]), 1);
    assert.deepEqual(await holdsOf(company, kit), ['barred', 'released']);
    await db.as(company.owner).call('lift_join_bar', { request_id: request.id });

    assert.deepEqual(await join(db, kit, company.code, 'Bo', 'Ellison'), PENDING_RELEASED);
    assert.equal((await rosterRow(db, company.rows['Bo Ellison'])).user_id, null);
  });

  it('goes with the release when a supervisor approves the account', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const impostor = await newMember(db, company, 'Riley', 'Quinn');
    await db.as(company.owner).call('release_roster_claim', { roster_id: company.rows['Riley J Quinn'] });
    await join(db, impostor, company.code, 'Riley', 'Quinn');
    await deny(company.owner, { request_id: (await pendingOf(impostor)).id, bar: true });
    const lifted = await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'denied'", [impostor]);
    await db.as(company.owner).call('lift_join_bar', { request_id: lifted[0].id });
    await join(db, impostor, company.code, 'Pat', 'Cole');
    await approve(company.owner, { request_id: (await pendingOf(impostor)).id });
    assert.deepEqual(await holdsOf(company, impostor), []);
    assert.equal(await db.as(impostor).call('is_member', { company_id: company.id }), true);
  });
});
