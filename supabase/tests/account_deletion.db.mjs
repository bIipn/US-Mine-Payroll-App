// Deleting an account (migration 20261120000200). account_deletion_check tells a signed-in account,
// before anything is deleted, what deleting it means in each of its companies: its role, whether it is
// the last supervisor who can sign in, who could take over, and whether a subscription still runs.
// close_company lets a company's last supervisor, when nobody else can take over and nothing is being
// charged, delete the company and its records. Deleting the account itself is Supabase Auth's admin
// delete, played here by a delete from auth.users as postgres, as the other tests do: it takes the
// sign-in and what is the person's alone (their join requests, holds and send counts), and leaves the
// company's records and roster row with only the link to the account cleared.
//
// The names and companies here are made up.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  addToRoster,
  BAD_INPUT,
  join,
  LAST_SUPERVISOR,
  newMember,
  nobody,
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

const check = (account) => db.as(account).call('account_deletion_check');
const close = (account, id, name) => db.as(account).call('close_company', { p_company_id: id, p_company_name: name });
/** Supabase Auth's admin delete, a hard delete: the auth.users row goes, and the foreign keys do the rest. */
const deleteAccount = (id) => db.admin('delete from auth.users where id = $1', [id]);
const softDelete = (id) => db.admin('update auth.users set deleted_at = now(), email = null where id = $1', [id]);
const ban = (id) => db.admin("update auth.users set banned_until = now() + interval '100 years' where id = $1", [id]);
const accountExists = async (id) => (await db.adminRows('select count(*)::int as n from auth.users where id = $1', [id]))[0].n === 1;

const revOf = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 20);
let made = 0;
/** A shift as a phone sends it, with push_records, as this account. */
async function sendShift(account, companyId) {
  const id = `sh-del-${(made += 1)}`;
  const record = { id, employeeId: 'emp-1', clockIn: 1763300000000 + made, clockOut: null, edits: [] };
  const answer = await db
    .as(account)
    .call('push_records', { company_id: companyId, changes: JSON.stringify([{ key: `shift:${id}`, kind: 'shift', id, rev: revOf(record), record }]) });
  assert.equal(answer.accepted.length, 1, JSON.stringify(answer));
  return id;
}

/** Everything a company has in every table that holds a company's rows, as the owner sees it. */
async function companyState(companyId) {
  const state = {};
  for (const table of [
    'companies',
    'roster',
    'join_requests',
    'notifications',
    'join_holds',
    'company_supervisor_guard',
    'records',
    'record_history',
    'record_counters',
    'billing_subscriptions',
    'billing_overrides',
  ]) {
    const column = table === 'companies' ? 'id' : 'company_id';
    state[table] = await db.adminRows(`select * from public.${table} where ${column} = $1 order by 1, 2`, [companyId]);
  }
  return JSON.parse(JSON.stringify(state));
}

/** A running subscription for a company, as Stripe's events would leave it. */
let subs = 0;
async function subscription(companyId, status, cancels = false) {
  const id = `sub_test_del${(subs += 1)}`;
  await db.admin('insert into public.billing_subscriptions (subscription_id, company_id, status, cancel_at_period_end) values ($1, $2, $3, $4)', [
    id,
    companyId,
    status,
    cancels,
  ]);
  return id;
}

describe('account_deletion_check and close_company', () => {
  it('are for a signed-in account: nobody signed in is refused, and the public key may not call them', async () => {
    const company = await startCompany(db);
    await refused(db.anon().call('account_deletion_check'), NOT_SIGNED_IN, /permission denied/);
    await refused(db.anon().call('close_company', { p_company_id: company.id, p_company_name: 'Test Pit A' }), NOT_SIGNED_IN, /permission denied/);
    await refused(db.noAccount().call('account_deletion_check'), NOT_SIGNED_IN, /Sign in first/);
    await refused(db.noAccount().call('close_company', { p_company_id: company.id, p_company_name: 'Test Pit A' }), NOT_SIGNED_IN, /Sign in first/);
    assert.ok(await accountExists(company.owner));
    assert.equal((await companyState(company.id)).companies.length, 1);
  });

  it('take no account id: who is asked about is the caller, and nobody else', async () => {
    const functions = await db.adminRows(`
      select p.proname as name, coalesce(p.proargnames, '{}') as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('account_deletion_check', 'close_company')
      order by 1`);
    assert.deepEqual(functions, [
      { name: 'account_deletion_check', args: [] },
      { name: 'close_company', args: ['p_company_id', 'p_company_name'] },
    ]);
  });
});

describe('account_deletion_check', () => {
  it('gives a crew member their company, as crew, and never as its last supervisor', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    assert.deepEqual(await check(riley), [
      { id: company.id, name: 'Test Pit A', role: 'employee', last_supervisor: false, successors: [], running: null },
    ]);
  });

  it('tells a lone supervisor they are the last one, with nobody to take over and nothing being charged', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Lee', last: 'Park' }] });
    assert.deepEqual(await check(company.owner), [
      { id: company.id, name: 'Test Pit A', role: 'supervisor', last_supervisor: true, successors: [], running: 0 },
    ]);
  });

  it('lists who can take over: active rows whose account can still sign in, and nobody else', async () => {
    const company = await startCompany(db, {
      roster: [
        { first: 'Riley J', last: 'Quinn' },
        { first: 'Maria', last: 'De La Cruz' },
        { first: 'Lee', last: 'Park' },
        { first: 'Bo', last: 'Lark' },
        { first: 'Kit', last: 'Marlow' },
      ],
    });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const maria = await newMember(db, company, 'Maria', 'De La Cruz');
    const bo = await newMember(db, company, 'Bo', 'Lark');
    const kit = await newMember(db, company, 'Kit', 'Marlow');
    // Maria is taken off the roster, Bo is banned and Kit soft-deleted; Lee never joined.
    await db.as(company.owner).query('update public.roster set active = false where id = $1', [company.rows['Maria De La Cruz']]);
    await ban(bo);
    await softDelete(kit);
    const [mine] = await check(company.owner);
    assert.equal(mine.last_supervisor, true);
    assert.deepEqual(mine.successors, [{ roster_id: company.rows['Riley J Quinn'], first_name: 'Riley J', last_name: 'Quinn' }]);
    // The crew member sees no names.
    assert.deepEqual((await check(riley))[0].successors, []);
    assert.equal((await check(maria)).length, 0, 'taken off the roster: nothing of the company');
  });

  it('is not the last supervisor beside a second supervisor who can sign in, and is again once that one is banned', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Lee', last: 'Park' }] });
    const lee = await newMember(db, company, 'Lee', 'Park');
    const second = await secondSupervisor(db, company, 'Ana', 'Diaz');
    const [mine] = await check(company.owner);
    assert.equal(mine.last_supervisor, false);
    assert.deepEqual(
      mine.successors.map((s) => `${s.first_name} ${s.last_name}`),
      ['Ana Diaz', 'Lee Park'],
    );
    assert.equal((await check(second))[0].last_supervisor, false);
    await ban(second);
    assert.equal((await check(company.owner))[0].last_supervisor, true);
    assert.equal((await check(lee))[0].last_supervisor, false);
  });

  it('counts the subscriptions Stripe still charges: none when comped, one while a trial runs, none once it is cancelled', async () => {
    const company = await startCompany(db);
    assert.equal((await check(company.owner))[0].running, 0);
    const trial = await subscription(company.id, 'trialing');
    assert.equal((await check(company.owner))[0].running, 1);
    await db.admin('update public.billing_subscriptions set cancel_at_period_end = true where subscription_id = $1', [trial]);
    assert.equal((await check(company.owner))[0].running, 0);
    await db.admin("update public.billing_subscriptions set status = 'canceled', cancel_at_period_end = false where subscription_id = $1", [trial]);
    assert.equal((await check(company.owner))[0].running, 0);
    await subscription(company.id, 'active');
    assert.equal((await check(company.owner))[0].running, 1);
  });

  it('names only the caller’s own companies, each once, by name', async () => {
    const a = await startCompany(db, { name: 'Test Pit Z', roster: [{ first: 'Jo', last: 'Vale' }] });
    const b = await startCompany(db, { name: 'Test Pit M', roster: [{ first: 'Jo', last: 'Vale' }] });
    const other = await startCompany(db, { name: 'Test Pit Q', roster: [{ first: 'Jo', last: 'Vale' }] });
    const jo = await newMember(db, a, 'Jo', 'Vale');
    assert.equal((await join(db, jo, b.code, 'Jo', 'Vale')).status, 'joined');
    const seen = await check(jo);
    assert.deepEqual(
      seen.map((c) => [c.name, c.role]),
      [
        ['Test Pit M', 'employee'],
        ['Test Pit Z', 'employee'],
      ],
    );
    assert.ok(!seen.some((c) => c.id === other.id));
    assert.deepEqual(await check(await db.newAccount()), [], 'an account on no roster');
  });

  it('gives a banned or soft-deleted account nothing', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Lee', last: 'Park' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const lee = await newMember(db, company, 'Lee', 'Park');
    await ban(riley);
    await softDelete(lee);
    assert.deepEqual(await check(riley), []);
    assert.deepEqual(await check(lee), []);
  });
});

describe('close_company', () => {
  async function lonelyCompany(name = 'Test Pit C') {
    return startCompany(db, { name, roster: [{ first: 'Lee', last: 'Park' }] });
  }

  it('is refused, the same way and changing nothing, to an employee, another company’s supervisor and a made-up company', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const stranger = await startCompany(db, { name: 'Test Pit B' });
    const before = await companyState(company.id);
    await refused(close(riley, company.id, 'Test Pit A'), NOT_FOUND, /^No such company\.$/);
    await refused(close(stranger.owner, company.id, 'Test Pit A'), NOT_FOUND, /^No such company\.$/);
    await refused(close(company.owner, nobody(), 'Test Pit A'), NOT_FOUND, /^No such company\.$/);
    await refused(close(company.owner, null, 'Test Pit A'), NOT_FOUND, /^No such company\.$/);
    assert.deepEqual(await companyState(company.id), before);
  });

  it('needs the company’s name typed as it is, capitals and spaces aside', async () => {
    const company = await lonelyCompany();
    const before = await companyState(company.id);
    for (const typed of ['Test Pit', 'Test Pit CC', '', null, 'Test Pit A']) {
      const error = await refused(close(company.owner, company.id, typed), BAD_INPUT, /Type the company's name as it is/);
      assert.equal(error.hint, 'wrong_name');
    }
    assert.deepEqual(await companyState(company.id), before);
    assert.equal(await close(company.owner, company.id, '  test   PIT c '), '');
    assert.equal((await companyState(company.id)).companies.length, 0);
  });

  it('is refused while someone else on the roster can sign in, until that row is taken off or that account can no longer sign in', async () => {
    const company = await lonelyCompany();
    const lee = await newMember(db, company, 'Lee', 'Park');
    const before = await companyState(company.id);
    const error = await refused(close(company.owner, company.id, 'Test Pit C'), WRONG_STATE, /^Someone else can take over this company\. Make them a supervisor instead\.$/);
    assert.equal(error.hint, 'someone_can_take_over');
    assert.deepEqual(await companyState(company.id), before);
    // Taken off the roster: nobody is left who could take over.
    await db.as(company.owner).query('update public.roster set active = false where id = $1', [company.rows['Lee Park']]);
    assert.equal(await close(company.owner, company.id, 'Test Pit C'), '');
    assert.ok(await accountExists(lee), 'closing a company deletes no account');

    const again = await lonelyCompany('Test Pit D');
    const leeToo = await newMember(db, again, 'Lee', 'Park');
    await refused(close(again.owner, again.id, 'Test Pit D'), WRONG_STATE, /Someone else can take over/);
    await softDelete(leeToo);
    assert.equal(await close(again.owner, again.id, 'Test Pit D'), '');
  });

  it('is refused while a subscription is still charged, so it is cancelled first', async () => {
    const company = await lonelyCompany();
    const sub = await subscription(company.id, 'active');
    const before = await companyState(company.id);
    const error = await refused(close(company.owner, company.id, 'Test Pit C'), WRONG_STATE, /^The company's subscription is still running\. Cancel it first\.$/);
    assert.equal(error.hint, 'subscription_running');
    assert.deepEqual(await companyState(company.id), before);
    await db.admin('update public.billing_subscriptions set cancel_at_period_end = true where subscription_id = $1', [sub]);
    assert.equal(await close(company.owner, company.id, 'Test Pit C'), '');
  });

  it('deletes the company and everything that is its, and nothing of another company', async () => {
    const company = await startCompany(db, { name: 'Test Pit E', roster: [{ first: 'Lee', last: 'Park' }, { first: 'Bo', last: 'Lark' }] });
    const other = await startCompany(db, { name: 'Test Pit F', roster: [{ first: 'Lee', last: 'Park' }] });
    // Its rows in every table: a request and its notification, a hold, records and their history, billing.
    const lee = await newMember(db, company, 'Lee', 'Park');
    await sendShift(lee, company.id);
    await sendShift(company.owner, company.id);
    await join(db, await db.newAccount(), company.code, 'Pat', 'Cole');
    await db.as(company.owner).call('release_roster_claim', { roster_id: company.rows['Lee Park'] });
    await subscription(company.id, 'canceled');
    const leeOther = await newMember(db, other, 'Lee', 'Park');
    await sendShift(leeOther, other.id);
    const otherBefore = await companyState(other.id);
    const full = await companyState(company.id);
    for (const table of ['roster', 'join_requests', 'notifications', 'join_holds', 'records', 'record_history', 'record_counters', 'billing_subscriptions', 'billing_overrides']) {
      assert.ok(full[table].length > 0, `the company has rows in ${table} before it is closed`);
    }

    assert.equal(await close(company.owner, company.id, 'Test Pit E'), '');
    for (const [table, rows] of Object.entries(await companyState(company.id))) assert.deepEqual(rows, [], table);
    assert.deepEqual(await companyState(other.id), otherBefore);
    // The account that closed it is still there, and is the last supervisor nowhere now.
    assert.ok(await accountExists(company.owner));
    assert.deepEqual(await check(company.owner), []);
  });
});

describe('deleting an account', () => {
  it('leaves a crew member’s roster row and records with the company, and takes what was the account’s alone', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn', title: 'Loader operator' }] });
    const elsewhere = await startCompany(db, { name: 'Test Pit B', roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const held = await startCompany(db, { name: 'Test Pit H', roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const shift = await sendShift(riley, company.id);
    // A request waiting in another company, with its notification, and a hold in a third.
    assert.equal((await join(db, riley, elsewhere.code, 'Riley', 'Kwan')).status, 'pending');
    assert.equal((await join(db, riley, held.code, 'Riley', 'Quinn')).status, 'joined');
    await db.as(held.owner).call('release_roster_claim', { roster_id: held.rows['Riley J Quinn'] });
    const counts = async () =>
      (
        await db.adminRows(
          `select (select count(*) from public.join_requests where user_id = $1)::int as requests,
                  (select count(*) from public.notifications n join public.join_requests r on r.id = n.request_id where r.user_id = $1)::int as notified,
                  (select count(*) from public.join_holds where user_id = $1)::int as holds,
                  (select count(*) from public.record_usage where user_id = $1)::int as usage`,
          [riley],
        )
      )[0];
    assert.deepEqual(await counts(), { requests: 1, notified: 1, holds: 1, usage: 1 });
    const before = await rosterRow(db, company.rows['Riley J Quinn']);

    await deleteAccount(riley);

    assert.equal(await accountExists(riley), false);
    assert.deepEqual(await counts(), { requests: 0, notified: 0, holds: 0, usage: 0 });
    const after = await rosterRow(db, company.rows['Riley J Quinn']);
    assert.deepEqual(
      [after.first_name, after.last_name, after.title, after.role, after.active, after.user_id, after.claimed_at],
      [before.first_name, before.last_name, before.title, before.role, before.active, null, null],
    );
    const [record] = await db.adminRows("select created_by, updated_by, data from public.records where company_id = $1 and kind = 'shift' and id = $2", [company.id, shift]);
    assert.deepEqual([record.created_by, record.updated_by, record.data.id], [null, null, shift]);
    const history = await db.adminRows("select \"by\", version from public.record_history where company_id = $1 and kind = 'shift' and id = $2", [company.id, shift]);
    assert.deepEqual(history, [{ by: null, version: 1 }]);
    // The company's supervisor still reads the record, and the unclaimed row can be claimed again by a new account.
    assert.ok((await db.as(company.owner).rows("select id from public.records where kind = 'shift' and id = $1", [shift])).length === 1);
    const back = await db.newAccount('member');
    assert.equal((await join(db, back, company.code, 'Riley', 'Quinn')).status, 'joined');
  });

  it('leaves an access token the account still holds with no powers anywhere', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    await sendShift(riley, company.id);
    await deleteAccount(riley);
    // The token outlives the account until it expires: auth.uid() still names it.
    const as = db.as(riley);
    assert.deepEqual(await as.callRows('my_companies'), []);
    assert.deepEqual(await check(riley), []);
    await refused(
      as.call('push_records', { company_id: company.id, changes: JSON.stringify([]) }),
      NOT_FOUND,
      /No such company/,
    );
    await refused(as.callRows('read_shared_records', { company_id: company.id, after: 0, max: 10 }), NOT_FOUND, /No such company/);
    for (const table of ['companies', 'roster', 'records', 'record_history', 'join_requests']) assert.deepEqual(await as.rows(`select * from public.${table}`), [], table);
    assert.deepEqual(await as.callRows('my_join_requests'), []);
  });

  it('is refused for a company’s last supervisor until someone else is made a supervisor through the API', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    await newMember(db, company, 'Riley', 'Quinn');
    const before = await companyState(company.id);
    await refused(deleteAccount(company.owner), LAST_SUPERVISOR, /at least one active supervisor/);
    assert.ok(await accountExists(company.owner));
    assert.deepEqual(await companyState(company.id), before);
    // The handover the dashboard's Roster page makes: Riley becomes a supervisor.
    await db.as(company.owner).query("update public.roster set role = 'supervisor' where id = $1", [company.rows['Riley J Quinn']]);
    assert.equal((await check(company.owner))[0].last_supervisor, false);
    await deleteAccount(company.owner);
    assert.equal(await accountExists(company.owner), false);
    const row = await rosterRow(db, company.ownRow);
    assert.deepEqual([row.role, row.active, row.user_id], ['supervisor', true, null]);
  });

  it('is refused for a company’s last supervisor until the company is closed', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Lee', last: 'Park' }] });
    await refused(deleteAccount(company.owner), LAST_SUPERVISOR);
    assert.equal(await close(company.owner, company.id, 'Test Pit A'), '');
    await deleteAccount(company.owner);
    assert.equal(await accountExists(company.owner), false);
  });

  it('takes a supervisor of several companies off every one of them once each has another supervisor', async () => {
    const a = await startCompany(db, { roster: [] });
    const b = await startCompany(db, { name: 'Test Pit B' });
    const both = await secondSupervisor(db, a, 'Ana', 'Diaz');
    const rowB = await addToRoster(db, b.owner, b.id, { first: 'Ana', last: 'Diaz', role: 'supervisor' }, b.rows);
    assert.equal((await join(db, both, b.code, 'Ana', 'Diaz')).reason, 'supervisor_row');
    const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and company_id = $2 and status = 'pending'", [both, b.id]);
    await db.as(b.owner).call('approve_join_request', { request_id: request.id, roster_id: rowB });
    assert.deepEqual((await check(both)).map((c) => [c.role, c.last_supervisor]), [
      ['supervisor', false],
      ['supervisor', false],
    ]);
    await deleteAccount(both);
    assert.equal((await rosterRow(db, rowB)).user_id, null);
    assert.equal((await rosterRow(db, a.rows['Ana Diaz'])).user_id, null);
  });
});

describe('what a signed-in account may call', () => {
  it('names no account in any argument, so nobody is asked about, closed or deleted by an id they send', async () => {
    const callable = await db.adminRows(`
      select p.proname as name, coalesce(p.proargnames, '{}') as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
      order by 1`);
    assert.ok(callable.some((f) => f.name === 'account_deletion_check'));
    assert.ok(callable.some((f) => f.name === 'close_company'));
    // The contact form's p_email is the address a visitor wants an answer at: it names no account and changes none.
    const replyAddress = (name, arg) => name === 'submit_contact_request' && arg === 'p_email';
    for (const { name, args } of callable) {
      for (const arg of args) if (!replyAddress(name, arg)) assert.doesNotMatch(arg, /user|account|uid|email|sub$/i, `${name}(${arg})`);
    }
  });
});
