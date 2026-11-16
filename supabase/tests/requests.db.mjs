// Approving and denying join requests.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  BAD_INPUT,
  join,
  newMember,
  nobody,
  NO_PRIVILEGE,
  NOT_FOUND,
  NOT_SIGNED_IN,
  refused,
  rosterRow,
  secondSupervisor,
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

const CREW = [
  { first: 'Riley J', last: 'Quinn' },
  { first: 'Lee "Buck"', last: 'Vance III', title: 'Bagging plant' },
  { first: 'Maria', last: 'De La Cruz' },
  { first: 'Jo', last: 'Sterne', active: false },
];

const requestRow = async (id) => (await db.adminRows('select * from public.join_requests where id = $1', [id]))[0];

/** A new account asks to join under a name that is not on the roster. Returns the account and its request. */
async function asksToJoin(company, first = 'Pat', last = 'Cole') {
  const account = await db.newAccount('asking');
  const result = await join(db, account, company.code, first, last);
  assert.equal(result.status, 'pending');
  const [request] = await db.adminRows("select * from public.join_requests where user_id = $1 and status = 'pending'", [account]);
  return { account, request };
}

const approve = (supervisor, args) => db.as(supervisor).call('approve_join_request', args);
const deny = (supervisor, requestId) => db.as(supervisor).call('deny_join_request', { request_id: requestId });

describe('approve_join_request onto a row already on the roster', () => {
  it('gives the requester that row and records who decided and when', async () => {
    const company = await startCompany(db, { roster: CREW });
    // "Bucky" is not a word of Lee "Buck", so the name goes to a supervisor.
    const { account, request } = await asksToJoin(company, 'Bucky', 'Vance');
    assert.equal(request.reason, 'not_on_roster');

    const rowId = company.rows['Lee "Buck" Vance III'];
    assert.equal(await approve(company.owner, { request_id: request.id, roster_id: rowId }), rowId);

    const row = await rosterRow(db, rowId);
    assert.equal(row.user_id, account);
    assert.ok(row.claimed_at instanceof Date);
    // The row keeps its own name, role and title.
    assert.equal(row.first_name, 'Lee "Buck"');
    assert.equal(row.role, 'employee');
    assert.equal(row.title, 'Bagging plant');

    const decided = await requestRow(request.id);
    assert.equal(decided.status, 'approved');
    assert.equal(decided.roster_id, rowId);
    assert.equal(decided.decided_by, company.owner);
    assert.ok(decided.decided_at instanceof Date);

    assert.equal(await db.as(account).call('is_member', { company_id: company.id }), true);
    assert.deepEqual(await db.as(account).rows('select name from public.companies'), [{ name: 'Test Pit A' }]);
    assert.equal((await join(db, account, company.code, 'Bucky', 'Vance')).status, 'already_member');
  });

  it('settles an already_claimed request once a supervisor releases the row from the wrong account', async () => {
    const company = await startCompany(db, { roster: CREW });
    const wrong = await newMember(db, company, 'Riley', 'Quinn');
    const { account, request } = await asksToJoin(company, 'Riley J', 'Quinn');
    assert.equal(request.reason, 'already_claimed');

    const rowId = company.rows['Riley J Quinn'];
    await db.as(company.owner).call('release_roster_claim', { roster_id: rowId });
    await approve(company.owner, { request_id: request.id, roster_id: rowId });
    assert.equal((await rosterRow(db, rowId)).user_id, account);
    assert.equal(await db.as(wrong).call('is_member', { company_id: company.id }), false);
  });

  it('refuses a row that is claimed, taken off, of another company, or not there, and changes nothing', async () => {
    const company = await startCompany(db, { roster: CREW });
    const other = await startCompany(db, { name: 'Test Pit B', roster: CREW });
    await newMember(db, company, 'Riley', 'Quinn');
    const { account, request } = await asksToJoin(company);

    const tries = [
      [company.rows['Riley J Quinn'], WRONG_STATE, /already claimed/],
      [company.rows['Jo Sterne'], WRONG_STATE, /not active/],
      [other.rows['Maria De La Cruz'], NOT_FOUND, /No such roster row/],
      [nobody(), NOT_FOUND, /No such roster row/],
    ];
    for (const [rowId, code, message] of tries) {
      await refused(approve(company.owner, { request_id: request.id, roster_id: rowId }), code, message);
    }
    assert.equal((await requestRow(request.id)).status, 'pending');
    assert.equal((await rosterRow(db, other.rows['Maria De La Cruz'])).user_id, null);
    assert.equal((await rosterRow(db, company.rows['Jo Sterne'])).user_id, null);
    assert.equal(await db.as(account).call('is_member', { company_id: company.id }), false);
  });
});

describe('approve_join_request with a new row', () => {
  it("makes a row from the request's name, as an employee unless told otherwise, and gives it to the requester", async () => {
    const company = await startCompany(db, { roster: CREW });
    const { account, request } = await asksToJoin(company, 'Pat', 'Cole');
    const rowId = await approve(company.owner, { request_id: request.id });

    const row = await rosterRow(db, rowId);
    assert.equal(row.company_id, company.id);
    assert.equal(row.first_name, 'Pat');
    assert.equal(row.last_name, 'Cole');
    assert.equal(row.role, 'employee');
    assert.equal(row.title, null);
    assert.equal(row.active, true);
    assert.equal(row.user_id, account);

    const decided = await requestRow(request.id);
    assert.equal(decided.status, 'approved');
    assert.equal(decided.roster_id, rowId);
    assert.equal(decided.decided_by, company.owner);
  });

  it('takes a role and a job title for the new row', async () => {
    const company = await startCompany(db, { roster: CREW });
    const { account, request } = await asksToJoin(company, 'Kit', 'Marlow');
    const rowId = await approve(company.owner, { request_id: request.id, role: 'Supervisor', title: ' Shop ' });
    const row = await rosterRow(db, rowId);
    assert.equal(row.role, 'supervisor');
    assert.equal(row.title, 'Shop');
    assert.equal(await db.as(account).call('is_supervisor', { company_id: company.id }), true);
  });

  it('refuses a role that is not employee or supervisor', async () => {
    const company = await startCompany(db, { roster: CREW });
    const { request } = await asksToJoin(company);
    for (const role of ['owner', '', null]) {
      await refused(approve(company.owner, { request_id: request.id, role }), BAD_INPUT, /employee or supervisor/);
    }
    await refused(approve(company.owner, { request_id: request.id, title: 'T'.repeat(101) }), BAD_INPUT, /100 characters/);
    assert.equal((await requestRow(request.id)).status, 'pending');
  });

  it('moves the account off a row of theirs that was taken off the roster', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await newMember(db, company, 'Maria', 'De La Cruz');
    const oldRow = company.rows['Maria De La Cruz'];
    await db.as(company.owner).affected('update public.roster set active = false where id = $1', [oldRow]);
    // Their old row is off the roster, so their name no longer matches anyone.
    assert.equal((await join(db, account, company.code, 'Maria', 'De La Cruz')).reason, 'not_on_roster');
    const [request] = await db.adminRows("select * from public.join_requests where user_id = $1 and status = 'pending'", [account]);

    const rowId = await approve(company.owner, { request_id: request.id });
    assert.equal((await rosterRow(db, rowId)).user_id, account);
    assert.equal((await rosterRow(db, oldRow)).user_id, null);
  });

  it('refuses a request from someone already on the roster; denying it closes it', async () => {
    const company = await startCompany(db, { roster: CREW });
    const { account, request } = await asksToJoin(company, 'Pat', 'Cole');
    // A supervisor adds them, and they join by themselves before anyone decides.
    await db.as(company.owner).affected("insert into public.roster (company_id, first_name, last_name) values ($1, 'Pat', 'Cole')", [company.id]);
    assert.equal((await join(db, account, company.code, 'Pat', 'Cole')).status, 'joined');

    await refused(approve(company.owner, { request_id: request.id }), WRONG_STATE, /already on the roster/);
    await deny(company.owner, request.id);
    assert.equal((await requestRow(request.id)).status, 'denied');
    assert.equal(await db.as(account).call('is_member', { company_id: company.id }), true);
  });
});

describe('deny_join_request', () => {
  it('closes the request, records who decided and when, and lets nobody in', async () => {
    const company = await startCompany(db, { roster: CREW });
    const { account, request } = await asksToJoin(company);
    assert.equal(await deny(company.owner, request.id), '');

    const decided = await requestRow(request.id);
    assert.equal(decided.status, 'denied');
    assert.equal(decided.roster_id, null);
    assert.equal(decided.decided_by, company.owner);
    assert.ok(decided.decided_at instanceof Date);
    assert.equal(await db.as(account).call('is_member', { company_id: company.id }), false);
    assert.deepEqual(await db.as(account).rows('select status from public.join_requests'), [{ status: 'denied' }]);
  });

  it('leaves the person free to ask again, as a new request', async () => {
    const company = await startCompany(db, { roster: CREW });
    const { account, request } = await asksToJoin(company);
    await deny(company.owner, request.id);
    assert.equal((await join(db, account, company.code, 'Pat', 'Cole')).status, 'pending');
    const requests = await db.adminRows('select status from public.join_requests where user_id = $1 order by created_at', [account]);
    assert.deepEqual(requests.map((r) => r.status), ['denied', 'pending']);
  });
});

describe('a decided request', () => {
  it('cannot be decided again, either way', async () => {
    const company = await startCompany(db, { roster: CREW });
    const approved = (await asksToJoin(company, 'Pat', 'Cole')).request;
    const denied = (await asksToJoin(company, 'Kit', 'Marlow')).request;
    await approve(company.owner, { request_id: approved.id });
    await deny(company.owner, denied.id);
    const approvedRow = await requestRow(approved.id);

    for (const id of [approved.id, denied.id]) {
      await refused(approve(company.owner, { request_id: id }), WRONG_STATE, /already been decided/);
      await refused(approve(company.owner, { request_id: id, roster_id: company.rows['Maria De La Cruz'] }), WRONG_STATE, /already been decided/);
      await refused(deny(company.owner, id), WRONG_STATE, /already been decided/);
    }
    assert.deepEqual(await requestRow(approved.id), approvedRow);
    assert.equal((await requestRow(denied.id)).status, 'denied');
    assert.equal((await rosterRow(db, company.rows['Maria De La Cruz'])).user_id, null);
  });
});

describe('deciding a request', () => {
  it('is for supervisors of that company only', async () => {
    const company = await startCompany(db, { roster: CREW });
    const employee = await newMember(db, company, 'Riley', 'Quinn');
    const other = await startCompany(db, { name: 'Test Pit B' });
    const { account, request } = await asksToJoin(company);

    for (const who of [employee, account, other.owner, await db.newAccount()]) {
      await refused(approve(who, { request_id: request.id }), NOT_FOUND, /No such join request/);
      await refused(approve(who, { request_id: request.id, role: 'supervisor' }), NOT_FOUND, /No such join request/);
      await refused(deny(who, request.id), NOT_FOUND, /No such join request/);
    }
    await refused(db.noAccount().call('approve_join_request', { request_id: request.id }), NOT_SIGNED_IN);
    await refused(db.noAccount().call('deny_join_request', { request_id: request.id }), NOT_SIGNED_IN);
    await refused(db.anon().call('approve_join_request', { request_id: request.id }), NO_PRIVILEGE, /permission denied/);
    await refused(db.anon().call('deny_join_request', { request_id: request.id }), NO_PRIVILEGE, /permission denied/);
    assert.equal((await requestRow(request.id)).status, 'pending');
  });

  it('is for any supervisor of the company, not only the one who started it', async () => {
    const company = await startCompany(db, { roster: CREW });
    const second = await secondSupervisor(db, company, 'Ana', 'Diaz');
    const { request } = await asksToJoin(company);
    await approve(second, { request_id: request.id });
    assert.equal((await requestRow(request.id)).decided_by, second);
  });

  it('cannot be done by writing to the table', async () => {
    const company = await startCompany(db, { roster: CREW });
    const { account, request } = await asksToJoin(company);
    for (const who of [company.owner, account]) {
      await refused(db.as(who).query("update public.join_requests set status = 'approved' where id = $1", [request.id]), NO_PRIVILEGE, /permission denied/);
      await refused(db.as(who).query('delete from public.join_requests where id = $1', [request.id]), NO_PRIVILEGE, /permission denied/);
      await refused(
        db.as(who).query("insert into public.join_requests (company_id, user_id, first_name, last_name, reason) values ($1, $2, 'Pat', 'Cole', 'not_on_roster')", [company.id, who]),
        NO_PRIVILEGE,
        /permission denied/,
      );
    }
    assert.equal((await requestRow(request.id)).status, 'pending');
  });
});
