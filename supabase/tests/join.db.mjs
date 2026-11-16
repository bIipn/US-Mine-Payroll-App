// join_company: every status it answers with, and claiming a row only once.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  BAD_INPUT,
  join,
  newMember,
  NO_PRIVILEGE,
  NOT_SIGNED_IN,
  refused,
  rosterRow,
  startCompany,
  startDatabase,
  WRONG_STATE,
} from './harness.mjs';

const EN_DASH = String.fromCharCode(0x2013);

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
  { first: 'Lee', last: 'Park' },
  { first: 'Lee Roy', last: 'Park' },
  { first: 'Roy "Lee"', last: 'Park' },
  { first: 'Ana', last: 'Diaz', role: 'supervisor', title: 'Lab' },
];

const count = async (sql, params) => (await db.adminRows(sql, params))[0].n;
const requestsOf = (account) => db.adminRows('select * from public.join_requests where user_id = $1 order by created_at', [account]);
const notificationsOf = (company) => db.adminRows('select * from public.notifications where company_id = $1 order by created_at, id', [company.id]);

describe('join_company: joined', () => {
  it('claims the one active unclaimed row a name is, and tells the supervisors', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await db.newAccount();
    const result = await join(db, account, company.code, 'riley', 'QUINN');
    assert.deepEqual(result, { status: 'joined', company_name: 'Test Pit A', role: 'employee' });

    const row = await rosterRow(db, company.rows['Riley J Quinn']);
    assert.equal(row.user_id, account);
    assert.ok(row.claimed_at instanceof Date);
    assert.equal(await db.as(account).call('is_member', { company_id: company.id }), true);
    assert.equal(await db.as(account).call('is_supervisor', { company_id: company.id }), false);

    const notes = await notificationsOf(company);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, 'joined');
    assert.equal(notes[0].roster_id, row.id);
    assert.equal(notes[0].request_id, null);
    assert.equal(notes[0].read_at, null);
    assert.equal((await requestsOf(account)).length, 0);
  });

  it('gives the role on the row, so a supervisor row makes a supervisor', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await db.newAccount();
    assert.deepEqual(await join(db, account, company.code, 'Ana', 'Diaz'), { status: 'joined', company_name: 'Test Pit A', role: 'supervisor' });
    assert.equal(await db.as(account).call('is_supervisor', { company_id: company.id }), true);
  });

  it('reads the code in capitals, without spaces or dashes', async () => {
    const company = await startCompany(db, { roster: CREW });
    const { code } = company;
    const typed = [
      [code.toLowerCase(), 'Riley', 'Quinn'],
      [`  ${code.slice(0, 4)} ${code.slice(4)}  `, 'Lee', 'Vance'],
      [`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`, 'Maria', 'De La Cruz'],
      [`${code.slice(0, 3)}${EN_DASH}${code.slice(3, 6)} - ${code.slice(6)}`, 'Ana', 'Diaz'],
    ];
    for (const [text, first, last] of typed) {
      assert.equal((await join(db, await db.newAccount(), text, first, last)).status, 'joined', text);
    }
  });

  it('lets an account belong to several companies', async () => {
    const a = await startCompany(db, { roster: CREW });
    const b = await startCompany(db, { name: 'Test Pit B', roster: CREW });
    const account = await db.newAccount();
    assert.equal((await join(db, account, a.code, 'Maria', 'De La Cruz')).status, 'joined');
    assert.equal((await join(db, account, b.code, 'Maria', 'De La Cruz')).status, 'joined');
    const companies = await db.as(account).rows('select name from public.companies order by name');
    assert.deepEqual(companies.map((c) => c.name), ['Test Pit A', 'Test Pit B']);
  });

  it('takes the name typed exactly as on the roster over the others it fits', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await db.newAccount();
    assert.equal((await join(db, account, company.code, 'Lee', 'Park')).status, 'joined');
    assert.equal((await rosterRow(db, company.rows['Lee Park'])).user_id, account);
    assert.equal((await rosterRow(db, company.rows['Lee Roy Park'])).user_id, null);
  });

  it('lets someone who was taken off the roster back in on a new row, letting go of the old one', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await newMember(db, company, 'Maria', 'De La Cruz');
    const oldRow = company.rows['Maria De La Cruz'];
    await db.as(company.owner).affected('update public.roster set active = false where id = $1', [oldRow]);
    assert.equal(await db.as(account).call('is_member', { company_id: company.id }), false);

    const [newRow] = await db.as(company.owner).rows(
      "insert into public.roster (company_id, first_name, last_name, title) values ($1, 'Maria', 'De La Cruz', 'Scale house') returning id",
      [company.id],
    );
    assert.deepEqual(await join(db, account, company.code, 'Maria', 'De La Cruz'), { status: 'joined', company_name: 'Test Pit A', role: 'employee' });
    assert.equal((await rosterRow(db, newRow.id)).user_id, account);
    const old = await rosterRow(db, oldRow);
    assert.equal(old.user_id, null);
    assert.equal(old.claimed_at, null);
  });
});

describe('join_company: claim once', () => {
  it('gives a second account typing the same name a pending request (already_claimed), never the row', async () => {
    const company = await startCompany(db, { roster: CREW });
    const first = await newMember(db, company, 'Riley', 'Quinn');

    for (const [typedFirst, typedLast] of [['Riley J', 'Quinn'], ['riley j.', 'QUINN'], ['Riley', 'Quinn']]) {
      const second = await db.newAccount();
      assert.deepEqual(await join(db, second, company.code, typedFirst, typedLast), {
        status: 'pending',
        company_name: 'Test Pit A',
        reason: 'already_claimed',
      });
      assert.equal(await db.as(second).call('is_member', { company_id: company.id }), false);
      const [request] = await requestsOf(second);
      assert.equal(request.reason, 'already_claimed');
      assert.equal(request.status, 'pending');
      assert.equal(request.roster_id, null);
    }

    const row = await rosterRow(db, company.rows['Riley J Quinn']);
    assert.equal(row.user_id, first);
  });

  it('never hands a claimed row straight to another account, even with the server key', async () => {
    const company = await startCompany(db, { roster: CREW });
    const first = await newMember(db, company, 'Riley', 'Quinn');
    const second = await db.newAccount();
    await refused(
      db.admin('update public.roster set user_id = $2 where id = $1', [company.rows['Riley J Quinn'], second]),
      WRONG_STATE,
      /already claimed/,
    );
    assert.equal((await rosterRow(db, company.rows['Riley J Quinn'])).user_id, first);
  });

  it('lets an account hold one row in a company, never two', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await newMember(db, company, 'Riley', 'Quinn');
    await refused(db.admin('update public.roster set user_id = $2 where id = $1', [company.rows['Maria De La Cruz'], account]), '23505');
  });
});

describe('join_company: already_member', () => {
  it('says so when the account already holds an active row there, and records nothing more', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await newMember(db, company, 'Lee', 'Vance');
    const before = await notificationsOf(company);
    for (const [typedFirst, typedLast] of [['Lee', 'Vance'], ['Someone', 'Else']]) {
      assert.deepEqual(await join(db, account, company.code, typedFirst, typedLast), {
        status: 'already_member',
        company_name: 'Test Pit A',
        role: 'employee',
      });
    }
    assert.deepEqual(await notificationsOf(company), before);
    assert.equal((await requestsOf(account)).length, 0);
  });

  it('names the role, for the supervisor who started the company too', async () => {
    const company = await startCompany(db);
    assert.deepEqual(await join(db, company.owner, company.code, 'Sam', 'Ortiz'), {
      status: 'already_member',
      company_name: 'Test Pit A',
      role: 'supervisor',
    });
  });
});

describe('join_company: ambiguous', () => {
  it('records nothing when a name fits several rows and none exactly', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await db.newAccount();
    assert.deepEqual(await join(db, account, company.code, 'Roy', 'Park'), { status: 'ambiguous', company_name: 'Test Pit A' });
    assert.equal((await requestsOf(account)).length, 0);
    assert.equal((await notificationsOf(company)).length, 0);
    assert.equal((await rosterRow(db, company.rows['Lee Roy Park'])).user_id, null);
    assert.equal((await rosterRow(db, company.rows['Roy "Lee" Park'])).user_id, null);

    // Typed the whole way it is on the roster, it is one person.
    assert.equal((await join(db, account, company.code, 'Roy "Lee"', 'Park')).status, 'joined');
    assert.equal((await rosterRow(db, company.rows['Roy "Lee" Park'])).user_id, account);
  });
});

describe('join_company: pending', () => {
  it('leaves one request (not_on_roster) for a name that is not on the roster, and tells the supervisors', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await db.newAccount();
    assert.deepEqual(await join(db, account, company.code, '  Pat ', ' Cole  '), {
      status: 'pending',
      company_name: 'Test Pit A',
      reason: 'not_on_roster',
    });
    const [request] = await requestsOf(account);
    assert.equal(request.company_id, company.id);
    assert.equal(request.first_name, 'Pat');
    assert.equal(request.last_name, 'Cole');
    assert.equal(request.reason, 'not_on_roster');
    assert.equal(request.status, 'pending');
    assert.equal(request.decided_by, null);
    assert.equal(request.decided_at, null);

    const notes = await notificationsOf(company);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, 'join_request');
    assert.equal(notes[0].request_id, request.id);
    assert.equal(notes[0].roster_id, null);

    // The person sees their own request; they are not a member yet.
    const own = await db.as(account).rows('select id, status, reason from public.join_requests');
    assert.deepEqual(own, [{ id: request.id, status: 'pending', reason: 'not_on_roster' }]);
    assert.equal(await db.as(account).call('is_member', { company_id: company.id }), false);
    assert.deepEqual(await db.as(account).rows('select id from public.roster'), []);
  });

  it('returns the request already pending on a second try, and adds nothing', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await db.newAccount();
    await join(db, account, company.code, 'Pat', 'Cole');
    for (const [typedFirst, typedLast] of [['Pat', 'Cole'], ['Jo', 'Sterne']]) {
      assert.deepEqual(await join(db, account, company.code, typedFirst, typedLast), {
        status: 'pending',
        company_name: 'Test Pit A',
        reason: 'not_on_roster',
      });
    }
    const requests = await requestsOf(account);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].first_name, 'Pat');
    assert.equal((await notificationsOf(company)).length, 1);
  });

  it('still lets the person join on their own once their row is there', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await db.newAccount();
    await join(db, account, company.code, 'Pat', 'Cole');
    await db.as(company.owner).affected("insert into public.roster (company_id, first_name, last_name) values ($1, 'Pat', 'Cole')", [company.id]);
    assert.equal((await join(db, account, company.code, 'Pat', 'Cole')).status, 'joined');
  });

  it('does not match a row taken off the roster', async () => {
    const company = await startCompany(db, { roster: [...CREW, { first: 'Jo', last: 'Sterne', active: false }] });
    const account = await db.newAccount();
    assert.equal((await join(db, account, company.code, 'Jo', 'Sterne')).reason, 'not_on_roster');
    assert.equal((await rosterRow(db, company.rows['Jo Sterne'])).user_id, null);
  });
});

describe('join_company: no_company', () => {
  it('says so for a code no company has, and records nothing', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await db.newAccount();
    const inUse = new Set((await db.adminRows('select join_code from public.companies')).map((c) => c.join_code));
    const reversed = [...company.code].reverse().join('');
    const codes = ['ZZZZZZZZ', reversed, '', null, 'abc', `${company.code}X`, company.code.slice(1)].filter((code) => !inUse.has(code));
    assert.ok(codes.length >= 6);
    for (const code of codes) {
      assert.deepEqual(await join(db, account, code, 'Riley', 'Quinn'), { status: 'no_company' }, String(code));
    }
    assert.equal((await requestsOf(account)).length, 0);
    assert.equal((await rosterRow(db, company.rows['Riley J Quinn'])).user_id, null);
  });
});

describe('join_company: refused', () => {
  it('without a first and last name, recording nothing', async () => {
    const company = await startCompany(db, { roster: CREW });
    const account = await db.newAccount();
    for (const [first, last] of [['', 'Quinn'], ['Riley', '   '], [null, 'Quinn'], ['Riley', null], ['R'.repeat(101), 'Quinn']]) {
      await refused(join(db, account, company.code, first, last), BAD_INPUT, /first and last name/);
    }
    assert.equal((await requestsOf(account)).length, 0);
    assert.equal(await count('select count(*)::int as n from public.notifications where company_id = $1', [company.id]), 0);
  });

  it('when nobody is signed in', async () => {
    const company = await startCompany(db, { roster: CREW });
    await refused(db.noAccount().call('join_company', { code: company.code, first_name: 'Riley', last_name: 'Quinn' }), NOT_SIGNED_IN, /Sign in first/);
    await refused(db.anon().call('join_company', { code: company.code, first_name: 'Riley', last_name: 'Quinn' }), NO_PRIVILEGE, /permission denied/);
    assert.equal((await rosterRow(db, company.rows['Riley J Quinn'])).user_id, null);
  });
});
