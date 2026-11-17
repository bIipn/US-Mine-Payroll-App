// Regressions for the join-flow hardening (migration 20261116001200):
//  * a supervisor row is never handed out by a typed name, so nobody takes the
//    company over by claiming one;
//  * a person taken off the roster cannot walk back in by themselves, by their
//    own name or a coworker's;
//  * a name written the same way for several people leaves a request;
//  * a name cannot carry a control or invisible character;
//  * joining settles the account's own pending request;
//  * a name that fits a removed person, exactly or the looser way, never lands
//    on a different, still-active person (migration 20261116002600).
//
// All names are made up. The companies are Test Pit A, B, ...

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addToRoster,
  join,
  newMember,
  rosterRow,
  startCompany,
  startDatabase,
} from './harness.mjs';

const ZWSP = String.fromCharCode(0x200b);

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const requestsOf = (account) => db.adminRows('select * from public.join_requests where user_id = $1 order by created_at, id', [account]);
const unreadOf = async (company) =>
  (await db.adminRows('select count(*)::int as n from public.notifications where company_id = $1 and read_at is null', [company.id]))[0].n;

describe('an unclaimed supervisor row', () => {
  it('cannot be claimed by a typed name, so a code holder does not become a supervisor', async () => {
    const company = await startCompany(db, { supervisor: ['Sam', 'Ortiz'], roster: [{ first: 'Riley J', last: 'Quinn' }] });
    // A co-supervisor is lined up before they have signed up.
    await addToRoster(db, company.owner, company.id, { first: 'Dana', last: 'Hollis', role: 'supervisor' }, company.rows);
    const employee = await newMember(db, company, 'Riley', 'Quinn');

    // An employee can read the code and which supervisor rows are unclaimed.
    const [{ join_code }] = await db.as(employee).rows('select join_code from public.companies');
    assert.deepEqual(
      await db.as(employee).rows("select first_name, last_name from public.roster where role = 'supervisor' and user_id is null and active"),
      [{ first_name: 'Dana', last_name: 'Hollis' }],
    );

    // A second account types that name: it waits for a supervisor, it does not claim the role.
    const second = await db.newAccount('second');
    const result = await join(db, second, join_code, 'Dana', 'Hollis');
    assert.deepEqual(result, { status: 'pending', company_name: 'Test Pit A', reason: 'supervisor_row' });
    assert.equal(await db.as(second).call('is_supervisor', { company_id: company.id }), false);
    assert.equal((await rosterRow(db, company.rows['Dana Hollis'])).user_id, null);

    // It cannot touch the real supervisors' notifications or release their claim.
    assert.equal(await db.as(second).affected('update public.notifications set read_at = now() where company_id = $1', [company.id]), 0);
    await assert.rejects(db.as(second).call('release_roster_claim', { roster_id: company.ownRow }), (error) => error.code === 'P0002');
    assert.equal(await db.as(company.owner).call('is_supervisor', { company_id: company.id }), true);
    assert.ok((await unreadOf(company)) >= 1, 'the supervisors still have the join_request notice to see');
  });

  it('is let on only by a supervisor approving the request, which keeps the supervisor role', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }] });
    const account = await db.newAccount();
    await join(db, account, company.code, 'Ana', 'Diaz');
    const [request] = await requestsOf(account);
    await db.as(company.owner).call('approve_join_request', { request_id: request.id, roster_id: company.rows['Ana Diaz'] });
    assert.equal(await db.as(account).call('is_supervisor', { company_id: company.id }), true);
  });
});

describe('a person taken off the roster', () => {
  it('cannot land on a coworker by retyping their own name', async () => {
    const company = await startCompany(db, {
      roster: [
        { first: 'Lee', last: 'Park' },
        { first: 'Lee Roy', last: 'Park', role: 'supervisor' },
      ],
    });
    const lee = await newMember(db, company, 'Lee', 'Park');
    await db.as(company.owner).affected('update public.roster set active = false where id = $1', [company.rows['Lee Park']]);

    const result = await join(db, lee, company.code, 'Lee', 'Park');
    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'removed');
    assert.notEqual((await rosterRow(db, company.rows['Lee Roy Park'])).user_id, lee);
    assert.equal(await db.as(lee).call('is_supervisor', { company_id: company.id }), false);
  });

  it('cannot walk back in by typing an unclaimed coworker', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }, { first: 'Bo', last: 'Ellison' }] });
    const kit = await newMember(db, company, 'Kit', 'Marlow');
    await db.as(company.owner).affected('update public.roster set active = false where id = $1', [company.rows['Kit Marlow']]);

    const result = await join(db, kit, company.code, 'Bo', 'Ellison');
    assert.equal(result.reason, 'removed');
    assert.equal(await db.as(kit).call('is_member', { company_id: company.id }), false);
    assert.equal((await rosterRow(db, company.rows['Bo Ellison'])).user_id, null);
  });

  it('is never used to stand in for a still-active person on a looser match', async () => {
    // Active "Lee Roy Park", and an inactive "Lee Park": a stranger typing
    // "Lee Park" must not be matched onto "Lee Roy Park".
    const company = await startCompany(db, {
      roster: [{ first: 'Lee Roy', last: 'Park' }, { first: 'Lee', last: 'Park' }],
    });
    await db.as(company.owner).affected('update public.roster set active = false where id = $1', [company.rows['Lee Park']]);
    const stranger = await db.newAccount();
    const result = await join(db, stranger, company.code, 'Lee', 'Park');
    assert.equal(result.reason, 'not_on_roster');
    assert.equal((await rosterRow(db, company.rows['Lee Roy Park'])).user_id, null);
  });
});

describe('a name that fits a row taken off the roster', () => {
  // The exact name on an inactive row shadows the looser fallback. So does a
  // name that only fits it, the way the fallback reads names: full stops,
  // commas and quote marks as spaces, a suffix left off (migration 20261116002600).
  const FATHER_AND_SON = [{ first: 'Riley J', last: 'Quinn' }, { first: 'Riley J', last: 'Quinn Jr' }];

  async function withFatherRemoved(roster = FATHER_AND_SON) {
    const company = await startCompany(db, { roster });
    const father = `${roster[0].first} ${roster[0].last}`;
    await db.as(company.owner).affected('update public.roster set active = false where id = $1', [company.rows[father]]);
    return { company, son: company.rows['Riley J Quinn Jr'] };
  }

  it('with both rows active, the looser name is ambiguous', async () => {
    const company = await startCompany(db, { roster: FATHER_AND_SON });
    assert.deepEqual(await join(db, await db.newAccount(), company.code, 'Riley J.', 'Quinn'), { status: 'ambiguous', company_name: 'Test Pit A' });
  });

  it('typed exactly as the inactive row, leaves a request', async () => {
    const { company, son } = await withFatherRemoved();
    assert.equal((await join(db, await db.newAccount(), company.code, 'Riley J', 'Quinn')).reason, 'not_on_roster');
    assert.equal((await rosterRow(db, son)).user_id, null);
  });

  for (const [what, first, last, roster] of [
    ['with a full stop after the initial', 'Riley J.', 'Quinn'],
    ['with a comma after the last name', 'Riley J', 'Quinn,'],
    ['without the full stop the roster wrote', 'Riley J', 'Quinn', [{ first: 'Riley J.', last: 'Quinn' }, { first: 'Riley J', last: 'Quinn Jr' }]],
    ['without the middle initial', 'Riley', 'Quinn'],
  ]) {
    it(`typed ${what}, leaves a request rather than landing on the active namesake`, async () => {
      const { company, son } = await withFatherRemoved(roster);
      const result = await join(db, await db.newAccount(), company.code, first, last);
      assert.deepEqual(result, { status: 'pending', company_name: 'Test Pit A', reason: 'not_on_roster' });
      assert.equal((await rosterRow(db, son)).user_id, null);
    });
  }

  it('does not stop the son from joining by his own name', async () => {
    const { company, son } = await withFatherRemoved();
    const account = await db.newAccount();
    assert.equal((await join(db, account, company.code, 'Riley J', 'Quinn Jr')).status, 'joined');
    assert.equal((await rosterRow(db, son)).user_id, account);
  });
});

describe('names written the same for several people', () => {
  it('leave an ambiguous request instead of recording nothing', async () => {
    const company = await startCompany(db, {
      roster: [{ first: 'Lee', last: 'Park', title: 'Crusher' }, { first: 'Lee', last: 'Park', title: 'Haul truck' }],
    });
    const lee = await db.newAccount();
    const result = await join(db, lee, company.code, 'Lee', 'Park');
    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'ambiguous');
    const requests = await requestsOf(lee);
    assert.equal(requests.length, 1, 'a supervisor has something to approve');
  });

  it('still asks for the whole name when only a loose match is shared', async () => {
    // "Roy Park" only loosely fits "Lee Roy Park" and "Roy \"Lee\" Park":
    // typing the whole name settles it, so nothing is recorded.
    const company = await startCompany(db, { roster: [{ first: 'Lee Roy', last: 'Park' }, { first: 'Roy "Lee"', last: 'Park' }] });
    const account = await db.newAccount();
    assert.deepEqual(await join(db, account, company.code, 'Roy', 'Park'), { status: 'ambiguous', company_name: 'Test Pit A' });
    assert.equal((await requestsOf(account)).length, 0);
  });
});

describe('a hidden character in a typed name', () => {
  it('cannot turn an already_claimed name into an innocent request', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    await newMember(db, company, 'Riley', 'Quinn');
    const sly = await db.newAccount();
    await assert.rejects(
      join(db, sly, company.code, `Riley J${ZWSP}`, `Qu${ZWSP}inn`),
      (error) => error.code === '22023',
    );
    assert.equal((await requestsOf(sly)).length, 0);
  });

  it('cannot be written into a roster name or a company name', async () => {
    const company = await startCompany(db);
    await assert.rejects(
      db.as(company.owner).query("insert into public.roster (company_id, first_name, last_name) values ($1, $2, 'Park')", [company.id, `Lee${ZWSP}`]),
      (error) => error.code === '22023',
    );
    await assert.rejects(
      db.as(company.owner).query('update public.companies set name = $2 where id = $1', [company.id, `Test Pit${ZWSP} A`]),
      (error) => error.code === '22023',
    );
  });
});

describe('joining settles the account own pending request', () => {
  it('withdraws a stale request so it cannot be approved to re-admit someone later', async () => {
    const company = await startCompany(db);
    const pat = await db.newAccount();
    assert.equal((await join(db, pat, company.code, 'Patty', 'Cole')).reason, 'not_on_roster');
    const [{ id: requestId }] = await requestsOf(pat);

    const [row] = await db.as(company.owner).rows("insert into public.roster (company_id, first_name, last_name) values ($1, 'Pat', 'Cole') returning id", [company.id]);
    assert.equal((await join(db, pat, company.code, 'Pat', 'Cole')).status, 'joined');

    // The request is kept, withdrawn, as a record of what the account typed first.
    assert.equal((await db.adminRows('select status from public.join_requests where id = $1', [requestId]))[0].status, 'withdrawn');
    // Taking them off later and approving the old request cannot bring them back, because it is settled.
    await db.as(company.owner).affected('update public.roster set active = false where id = $1', [row.id]);
    await assert.rejects(db.as(company.owner).call('approve_join_request', { request_id: requestId }), (error) => error.code === '55000');
  });
});
