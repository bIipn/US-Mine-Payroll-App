// Starting a company, its join code, rotating the code, and its settings.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  BAD_INPUT,
  join,
  newMember,
  NO_PRIVILEGE,
  NOT_FOUND,
  NOT_SIGNED_IN,
  refused,
  startCompany,
  startDatabase,
} from './harness.mjs';

const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];
const EN_DASH = String.fromCharCode(0x2013);
const NO_BREAK_SPACE = String.fromCharCode(0x00a0);

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const companyRow = async (id) => (await db.adminRows('select * from public.companies where id = $1', [id]))[0];

const create = (account, args) =>
  db.as(account).callRows('create_company', {
    name: 'Test Pit A',
    state: 'CA',
    timezone: 'America/Los_Angeles',
    first_name: 'Sam',
    last_name: 'Ortiz',
    title: null,
    ...args,
  });

describe('create_company', () => {
  it('makes the company and puts the caller on its roster as a supervisor, with their account on the row', async () => {
    const account = await db.newAccount();
    const [made] = await create(account, {
      name: '  Test   Pit A ',
      state: ' ca ',
      timezone: 'America/Denver',
      first_name: ' Sam ',
      last_name: 'Ortiz',
      title: ' Pit  boss ',
    });
    assert.match(made.join_code, CODE);

    const company = await companyRow(made.company_id);
    assert.equal(company.name, 'Test Pit A');
    assert.equal(company.state, 'CA');
    assert.equal(company.timezone, 'America/Denver');
    assert.equal(company.join_code, made.join_code);
    assert.equal(company.created_by, account);
    assert.equal(company.logo_path, null);
    assert.equal(company.pay_period, null);

    const roster = await db.adminRows('select * from public.roster where company_id = $1', [made.company_id]);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].first_name, 'Sam');
    assert.equal(roster[0].last_name, 'Ortiz');
    assert.equal(roster[0].title, 'Pit boss');
    assert.equal(roster[0].role, 'supervisor');
    assert.equal(roster[0].active, true);
    assert.equal(roster[0].user_id, account);
    assert.ok(roster[0].claimed_at instanceof Date);

    assert.equal(await db.as(account).call('is_member', { company_id: made.company_id }), true);
    assert.equal(await db.as(account).call('is_supervisor', { company_id: made.company_id }), true);
  });

  it('counts the time zone in America/Los_Angeles when none is given', async () => {
    const account = await db.newAccount();
    const [made] = await create(account, { timezone: null });
    assert.equal((await companyRow(made.company_id)).timezone, 'America/Los_Angeles');
  });

  it('takes every state and DC by its postal code, and nothing else', async () => {
    // An account for each: one account may start only so many companies (below).
    for (const state of STATES) {
      const [made] = await create(await db.newAccount(), { state: state.toLowerCase() });
      assert.equal((await companyRow(made.company_id)).state, state);
    }
    const account = await db.newAccount();
    for (const state of ['PR', 'GU', 'VI', 'XX', 'C', 'CAL', 'California', '', '  ', null]) {
      await refused(create(account, { state }), BAD_INPUT, /two-letter postal code/);
    }
  });

  it('takes a name of 1 to 120 characters after trimming, and nothing longer or blank', async () => {
    const account = await db.newAccount();
    const longest = 'P'.repeat(120);
    const [made] = await create(account, { name: `  ${longest}  ` });
    assert.equal((await companyRow(made.company_id)).name, longest);
    for (const name of ['', '   ', `${NO_BREAK_SPACE} `, null, 'P'.repeat(121)]) {
      await refused(create(account, { name }), BAD_INPUT, /1 to 120 characters/);
    }
  });

  it('refuses a time zone the database does not know', async () => {
    const account = await db.newAccount();
    await refused(create(account, { timezone: 'Mars/Olympus_Mons' }), BAD_INPUT, /time zone/);
  });

  it('refuses without the first and last name of the person starting it', async () => {
    const account = await db.newAccount();
    for (const [first_name, last_name] of [['', 'Ortiz'], ['Sam', ' '], [null, 'Ortiz'], ['Sam', 'O'.repeat(101)]]) {
      await refused(create(account, { first_name, last_name }), BAD_INPUT, /first and last name/);
    }
    const before = await db.adminRows('select count(*)::int as n from public.companies where created_by = $1', [account]);
    assert.equal(before[0].n, 0);
  });

  it('lets one account start, and so belong to, several companies', async () => {
    const account = await db.newAccount();
    const [first] = await create(account, { name: 'Test Pit A' });
    const [second] = await create(account, { name: 'Test Pit B' });
    assert.notEqual(first.join_code, second.join_code);
    const mine = await db.as(account).rows('select id from public.companies order by name');
    assert.deepEqual(mine.map((c) => c.id), [first.company_id, second.company_id]);
  });

  it('refuses when nobody is signed in', async () => {
    await refused(
      db.noAccount().callRows('create_company', { name: 'Test Pit A', state: 'CA', timezone: null, first_name: 'Sam', last_name: 'Ortiz' }),
      NOT_SIGNED_IN,
      /Sign in first/,
    );
  });
});

// Every company an account starts adds to what each of its requests costs (each policy works out the
// account's companies), and a security scan's one account started 381 in nine minutes. So one account
// starts at most 3 companies in any 24 hours and 20 in all, counted from the companies it made
// (companies.created_by) (migration 20261117000800). Past either, create_company raises PT429, which
// PostgREST answers with HTTP 429, with a hint a client can go by.
describe('how many companies one account may start', () => {
  const TOO_MANY = 'PT429';
  const IN_A_DAY = /^This account has started 3 companies in the last 24 hours\. Try again in a day\.$/;
  const IN_ALL = /^This account has started 20 companies, the most one account may\. Write to MineMuster to start more\.$/;
  const started = async (account) => (await db.adminRows('select count(*)::int as n from public.companies where created_by = $1', [account]))[0].n;
  const onRosters = async (account) => (await db.adminRows('select count(*)::int as n from public.roster where user_id = $1', [account]))[0].n;

  /** Companies the account started `hoursAgo` hours ago, written as the owner would in the SQL editor. */
  const startedEarlier = (account, count, hoursAgo) =>
    db.admin(
      `insert into public.companies (name, state, join_code, created_by, created_at)
       select 'Test Pit E' || g, 'CA', public.new_join_code(), $1, now() - make_interval(hours => $3::int)
       from generate_series(1, $2::int) g`,
      [account, count, hoursAgo],
    );

  it('three in any 24 hours: the fourth is refused with PT429, and nothing of it is made', async () => {
    const account = await db.newAccount();
    for (const name of ['Test Pit A', 'Test Pit B', 'Test Pit C']) await create(account, { name });
    const error = await refused(create(account, { name: 'Test Pit D' }), TOO_MANY, IN_A_DAY);
    assert.equal(error.hint, 'too_many_today');
    assert.equal(await started(account), 3);
    assert.equal(await onRosters(account), 3);
    // Asking again changes nothing.
    await refused(create(account, { name: 'Test Pit D' }), TOO_MANY, IN_A_DAY);
    assert.equal(await started(account), 3);
  });

  it('counts the last 24 hours only', async () => {
    const yesterday = await db.newAccount();
    await startedEarlier(yesterday, 3, 25);
    for (const name of ['Test Pit A', 'Test Pit B', 'Test Pit C']) await create(yesterday, { name });
    await refused(create(yesterday, { name: 'Test Pit D' }), TOO_MANY, IN_A_DAY);
    assert.equal(await started(yesterday), 6);

    const today = await db.newAccount();
    await startedEarlier(today, 3, 23);
    await refused(create(today), TOO_MANY, IN_A_DAY);
    assert.equal(await started(today), 3);
  });

  it('twenty in all, however long ago they were started', async () => {
    const account = await db.newAccount();
    await startedEarlier(account, 19, 24 * 90);
    await create(account);
    assert.equal(await started(account), 20);
    const error = await refused(create(account, { name: 'Test Pit B' }), TOO_MANY, IN_ALL);
    assert.equal(error.hint, 'too_many_in_all');
    // At both limits at once, the one that waiting does not lift is the one it is told.
    const both = await db.newAccount();
    await startedEarlier(both, 17, 24 * 90);
    await startedEarlier(both, 3, 1);
    assert.equal((await refused(create(both), TOO_MANY, IN_ALL)).hint, 'too_many_in_all');
    assert.equal(await started(account), 20);
  });

  it('counts no call that was refused for what was typed', async () => {
    const account = await db.newAccount();
    for (const state of ['XX', '', null, 'California', 'PR']) await refused(create(account, { state }), BAD_INPUT);
    await refused(create(account, { name: '' }), BAD_INPUT);
    for (const name of ['Test Pit A', 'Test Pit B', 'Test Pit C']) await create(account, { name });
    assert.equal(await started(account), 3);
  });

  it('counts the companies the account started, not those it joined', async () => {
    const account = await db.newAccount();
    for (const name of ['Test Pit F', 'Test Pit G', 'Test Pit H', 'Test Pit J']) {
      const other = await startCompany(db, { name, roster: [{ first: 'Robin', last: 'Hale' }] });
      assert.equal((await join(db, account, other.code, 'Robin', 'Hale')).status, 'joined');
    }
    for (const name of ['Test Pit A', 'Test Pit B', 'Test Pit C']) await create(account, { name });
    assert.equal(await onRosters(account), 7);
  });

  it('holds each account to its own count', async () => {
    const busy = await db.newAccount();
    await startedEarlier(busy, 3, 1);
    await refused(create(busy), TOO_MANY, IN_A_DAY);
    const other = await db.newAccount();
    const [made] = await create(other);
    assert.match(made.join_code, CODE);
  });

  it('still turns away nobody signed in, and an account that can no longer sign in, as before', async () => {
    const banned = await db.newAccount();
    await startedEarlier(banned, 3, 1);
    await db.admin("update auth.users set banned_until = now() + interval '1 day' where id = $1", [banned]);
    await refused(create(banned), NO_PRIVILEGE, /can no longer sign in/);
  });
});

describe('join codes', () => {
  it('are eight characters with no look-alikes, from a source with no bias, and never repeat', async () => {
    const rows = await db.adminRows('select public.new_join_code() as code from generate_series(1, 2000)');
    const codes = rows.map((r) => r.code);
    for (const code of codes) assert.match(code, CODE);
    assert.equal(new Set(codes).size, codes.length);
    // 16,000 characters drawn from 32: every one turns up, and none of 0, O, 1 or I does.
    const seen = new Set(codes.join(''));
    assert.equal(seen.size, 32);
    for (const lookAlike of ['0', 'O', '1', 'I']) assert.equal(seen.has(lookAlike), false);
  });

  it('are read in capitals, with spaces and dashes taken out', async () => {
    const company = await startCompany(db);
    const { code } = company;
    const typed = [
      code.toLowerCase(),
      `${code.slice(0, 4)}-${code.slice(4)}`,
      `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`,
      `  ${code.slice(0, 2)} - ${code.slice(2, 6)}${EN_DASH}${code.slice(6)}  `,
      `${NO_BREAK_SPACE}${code}\n`,
    ];
    const reader = db.as(await db.newAccount());
    for (const text of typed) {
      assert.deepEqual(await reader.callRows('company_by_code', { code: text }), [{ name: 'Test Pit A', state: 'CA' }], text);
    }
  });

  it('cannot be set by hand to anything but eight characters from the alphabet, and never twice', async () => {
    const a = await startCompany(db);
    const b = await startCompany(db, { name: 'Test Pit B' });
    for (const code of ['ABC', 'ABCDEFG0', 'ABCDEFGI', 'abcdefgh', 'ABCDEFGHJ']) {
      await refused(db.admin('update public.companies set join_code = $1 where id = $2', [code, a.id]), '23514');
    }
    await refused(db.admin('update public.companies set join_code = $1 where id = $2', [a.code, b.id]), '23505');
  });
});

describe('company_by_code', () => {
  it("gives the company's name and state, and nothing else", async () => {
    const company = await startCompany(db, { name: 'Test Pit A', state: 'NV' });
    const found = await db.as(await db.newAccount()).callRows('company_by_code', { code: company.code });
    assert.deepEqual(found, [{ name: 'Test Pit A', state: 'NV' }]);
  });

  it('gives nothing for a code no company has', async () => {
    await startCompany(db);
    const reader = db.as(await db.newAccount());
    for (const code of ['', '   ', null, 'ZZZZZZZZ', 'not a code', '%', "' or 1=1 --"]) {
      assert.deepEqual(await reader.callRows('company_by_code', { code }), [], String(code));
    }
  });
});

describe('rotate_join_code', () => {
  it('gives the company a new code, and the old one stops working at once', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const fresh = await db.as(company.owner).call('rotate_join_code', { company_id: company.id });
    assert.match(fresh, CODE);
    assert.notEqual(fresh, company.code);
    assert.equal((await companyRow(company.id)).join_code, fresh);

    // The old code finds nothing and lets nobody in.
    const late = await db.newAccount();
    assert.deepEqual(await db.as(late).callRows('company_by_code', { code: company.code }), []);
    assert.deepEqual(await join(db, late, company.code, 'Riley', 'Quinn'), { status: 'no_company' });
    assert.equal((await db.adminRows('select count(*)::int as n from public.join_requests where user_id = $1', [late]))[0].n, 0);

    // The new one does.
    assert.deepEqual(await db.as(late).callRows('company_by_code', { code: fresh.toLowerCase() }), [{ name: 'Test Pit A', state: 'CA' }]);
    assert.equal((await join(db, late, fresh, 'Riley', 'Quinn')).status, 'joined');
  });

  it('leaves everyone who already joined on the roster', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const member = await newMember(db, company, 'Riley', 'Quinn');
    await db.as(company.owner).call('rotate_join_code', { company_id: company.id });
    assert.equal(await db.as(member).call('is_member', { company_id: company.id }), true);
  });

  it('is for supervisors of the company only', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const employee = await newMember(db, company, 'Riley', 'Quinn');
    const other = await startCompany(db, { name: 'Test Pit B' });
    for (const account of [employee, other.owner, await db.newAccount()]) {
      await refused(db.as(account).call('rotate_join_code', { company_id: company.id }), NOT_FOUND, /No such company/);
    }
    await refused(db.noAccount().call('rotate_join_code', { company_id: company.id }), NOT_SIGNED_IN);
    assert.equal((await companyRow(company.id)).join_code, company.code);
  });
});

describe('company settings', () => {
  it('a supervisor changes the name, state, time zone, logo and pay period', async () => {
    const company = await startCompany(db);
    const before = await companyRow(company.id);
    const changed = await db.as(company.owner).affected(
      `update public.companies
       set name = $2, state = $3, timezone = $4, logo_path = $5, pay_period = $6
       where id = $1`,
      [company.id, ' Test  Pit A North ', 'nv', 'America/Boise', `logos/${company.id}/logo.png`, { kind: 'semimonthly', paid: [5, 20] }],
    );
    assert.equal(changed, 1);
    const after = await companyRow(company.id);
    assert.equal(after.name, 'Test Pit A North');
    assert.equal(after.state, 'NV');
    assert.equal(after.timezone, 'America/Boise');
    assert.equal(after.logo_path, `logos/${company.id}/logo.png`);
    assert.deepEqual(after.pay_period, { kind: 'semimonthly', paid: [5, 20] });
    assert.ok(after.updated_at >= before.updated_at);
    assert.equal(after.join_code, before.join_code);

    // The logo and the pay period can be taken away again; a blank logo path is no logo.
    await db.as(company.owner).affected('update public.companies set logo_path = $2, pay_period = null where id = $1', [company.id, '  ']);
    const cleared = await companyRow(company.id);
    assert.equal(cleared.logo_path, null);
    assert.equal(cleared.pay_period, null);
  });

  it('holds the settings to the same rules as a new company', async () => {
    const company = await startCompany(db);
    const update = (set, value) => db.as(company.owner).affected(`update public.companies set ${set} = $2 where id = $1`, [company.id, value]);
    await refused(update('state', 'PR'), '23514');
    await refused(update('name', '  '), '23514');
    await refused(update('name', 'P'.repeat(121)), '23514');
    await refused(update('timezone', 'Nowhere/Special'), BAD_INPUT);
    await refused(update('pay_period', JSON.stringify([1, 15])), '23514');
    await refused(update('logo_path', 'x'.repeat(1025)), '23514');
  });

  it('keeps the pay period to a size every member can download with the company', async () => {
    const company = await startCompany(db);
    const update = (value) => db.as(company.owner).affected('update public.companies set pay_period = $2 where id = $1', [company.id, value]);
    await refused(update(JSON.stringify({ periods: 'x'.repeat(4 * 1024 * 1024) })), '23514', /companies_pay_period_size/);
    await refused(update(JSON.stringify({ periods: 'x'.repeat(16 * 1024) })), '23514', /companies_pay_period_size/);
    assert.equal(await update(JSON.stringify({ kind: 'semimonthly', paid: [5, 20], ifBankClosed: 'before', note: 'n'.repeat(8000) })), 1);
    assert.equal((await companyRow(company.id)).pay_period.kind, 'semimonthly');
  });

  it("takes a logo path only as a file in the company's own storage", async () => {
    const company = await startCompany(db);
    const update = (value) => db.as(company.owner).affected('update public.companies set logo_path = $2 where id = $1', [company.id, value]);
    for (const path of [
      '../other-company/logo.png',
      'logos/../../other-company/logo.png',
      'logos/..',
      '/etc/logo.png',
      'logos\\..\\other\\logo.png',
      `logos/logo${String.fromCharCode(0x202e)}gnp.svg`,
      `logos/logo${String.fromCodePoint(0xe0041)}.png`,
    ]) {
      await refused(update(path), BAD_INPUT, /logo/).catch((error) => {
        error.message = `${JSON.stringify(path)}: ${error.message}`;
        throw error;
      });
    }
    // Dots inside a name are fine.
    for (const path of ['logos/logo.v2.png', `${company.id}/logo..png`, 'logo.png']) {
      assert.equal(await update(path), 1, path);
      assert.equal((await companyRow(company.id)).logo_path, path);
    }
  });

  it('never lets the join code, id, creator or dates be written through the API', async () => {
    const company = await startCompany(db);
    const other = await startCompany(db, { name: 'Test Pit B' });
    const writes = [
      ['join_code', 'ABCDEFGH'],
      ['id', other.id],
      ['created_by', await db.newAccount()],
      ['created_at', new Date('2020-01-01')],
      ['updated_at', new Date('2020-01-01')],
    ];
    for (const [column, value] of writes) {
      await refused(
        db.as(company.owner).affected(`update public.companies set ${column} = $2 where id = $1`, [company.id, value]),
        NO_PRIVILEGE,
        /permission denied/,
      );
    }
    const after = await companyRow(company.id);
    assert.equal(after.join_code, company.code);
    assert.equal(after.created_by, company.owner);
  });

  it('never lets a company be made or removed through the API', async () => {
    const company = await startCompany(db);
    await refused(
      db.as(company.owner).query("insert into public.companies (name, state, join_code) values ('Test Pit C', 'CA', 'ABCDEFGH')"),
      NO_PRIVILEGE,
      /permission denied/,
    );
    await refused(db.as(company.owner).query('delete from public.companies where id = $1', [company.id]), NO_PRIVILEGE, /permission denied/);
    await refused(db.as(company.owner).query('truncate public.companies cascade'), NO_PRIVILEGE, /permission denied/);
    assert.ok(await companyRow(company.id));
  });

  it("keeps the company's id, creator and creation time even for the server's key, but lets the creator go when their account is deleted", async () => {
    const company = await startCompany(db);
    await refused(
      db.serviceRole().query('update public.companies set created_at = $2 where id = $1', [company.id, new Date('2020-01-01')]),
      NO_PRIVILEGE,
      /cannot be changed/,
    );
    await refused(
      db.serviceRole().query('update public.companies set created_by = $2 where id = $1', [company.id, await db.newAccount()]),
      NO_PRIVILEGE,
      /cannot be changed/,
    );
    // Its creator stays on as a supervisor elsewhere: a second supervisor lets the account go.
    const helper = await db.newAccount();
    await db.admin(
      "insert into public.roster (company_id, first_name, last_name, role, user_id) values ($1, 'Riley J', 'Quinn', 'supervisor', $2)",
      [company.id, helper],
    );
    await db.admin('delete from auth.users where id = $1', [company.owner]);
    assert.equal((await companyRow(company.id)).created_by, null);
  });
});
