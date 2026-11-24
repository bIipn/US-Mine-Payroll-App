// A company always keeps at least one active supervisor with an account, on
// every path: a role change, taking the row off, deleting it, releasing its
// claim, and deleting the account. An account Supabase Auth has banned or
// soft-deleted is neither counted nor a supervisor, and the server steps an
// account down before it bans it.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addToRoster,
  join,
  LAST_SUPERVISOR,
  newMember,
  NOT_FOUND,
  NOT_SIGNED_IN,
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

// Supabase Auth can take an account away without deleting its auth.users row:
// a soft delete (auth.admin.deleteUser(id, true)) sets deleted_at, and a ban
// sets banned_until. The roster's foreign key never fires, so the row keeps
// its user_id.
const softDelete = (id) => db.admin('update auth.users set deleted_at = now(), email = null where id = $1', [id]);
const ban = (id) => db.admin("update auth.users set banned_until = now() + interval '100 years' where id = $1", [id]);
const GONE = { 'soft-deleted': softDelete, banned: ban };

/** The supervisors of a company whose accounts can still sign in. */
async function usableSupervisors(companyId) {
  return (
    await db.adminRows(
      `select r.user_id from public.roster r join auth.users u on u.id = r.user_id
       where r.company_id = $1 and r.role = 'supervisor' and r.active
         and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
       order by r.user_id`,
      [companyId],
    )
  ).map((r) => r.user_id);
}

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

  it('lets one release the other, who then needs a supervisor to be let back on the row', async () => {
    const company = await startCompany(db);
    const second = await secondSupervisor(db, company);
    const rowId = company.rows['Riley J Quinn'];
    await db.as(company.owner).call('release_roster_claim', { roster_id: rowId });
    assert.equal(await db.as(second).call('is_supervisor', { company_id: company.id }), false);

    // Typing the name again does not hand back the supervisor row; it waits for approval. The
    // account's claim was released, so that is the reason given (migration 20261116002000).
    assert.deepEqual(await join(db, second, company.code, 'Riley', 'Quinn'), { status: 'pending', company_name: 'Test Pit A', reason: 'released' });
    const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'pending'", [second]);
    await db.as(company.owner).call('approve_join_request', { request_id: request.id, roster_id: rowId });
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

// The guard counts only supervisors whose account can still sign in.
describe('a supervisor whose account can no longer sign in', () => {
  for (const [how, gone] of Object.entries(GONE)) {
    it(`does not count, so the other cannot step down once the first is ${how}`, async () => {
      const company = await startCompany(db);
      const second = await secondSupervisor(db, company);
      await gone(company.owner);
      for (const [path, change] of Object.entries(PATHS)) {
        if (path === 'releasing the claim') continue; // would release the one usable supervisor's own row: covered below
        await refused(change(db.as(second), company.rows['Riley J Quinn']), LAST_SUPERVISOR, LAST, path);
      }
      // Nor can the usable one's claim be released by anyone.
      await refused(db.serviceRole().query('update public.roster set user_id = null where id = $1', [company.rows['Riley J Quinn']]), LAST_SUPERVISOR, LAST);
      assert.equal(await db.as(second).call('is_supervisor', { company_id: company.id }), true);
    });
  }

  it('counts again once a ban has run out', async () => {
    const company = await startCompany(db);
    const second = await secondSupervisor(db, company);
    await db.admin("update auth.users set banned_until = now() - interval '1 minute' where id = $1", [company.owner]);
    await db.as(second).query("update public.roster set role = 'employee' where id = $1", [company.rows['Riley J Quinn']]);
    assert.deepEqual((await supervisorsOf(company)).map((r) => r.user_id), [company.owner]);
  });

  it('still lets a dead supervisor row be cleared once someone who can sign in is a supervisor', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Maria', last: 'De La Cruz' }] });
    const maria = await newMember(db, company, 'Maria', 'De La Cruz');
    await softDelete(company.owner);
    // The server key makes Maria a supervisor, then takes the soft-deleted account's row off.
    await db.serviceRole().query("update public.roster set role = 'supervisor' where id = $1", [company.rows['Maria De La Cruz']]);
    await db.serviceRole().query('update public.roster set active = false where id = $1', [company.ownRow]);
    assert.equal(await db.as(maria).call('is_supervisor', { company_id: company.id }), true);
  });

  it('is_last_supervisor tells the server which accounts it must not soft-delete or ban', async () => {
    const company = await startCompany(db);
    const isLast = (id) => db.serviceRole().call('is_last_supervisor', { user_id: id });
    assert.equal(await isLast(company.owner), true);
    const second = await secondSupervisor(db, company);
    assert.equal(await isLast(company.owner), false);
    assert.equal(await isLast(second), false);
    await ban(second);
    assert.equal(await isLast(company.owner), true, 'a banned co-supervisor does not count');
    assert.equal(await isLast(await db.newAccount()), false, 'an account on no roster');
    // It is the server's: nobody signed in through the app can call it.
    await refused(db.as(company.owner).call('is_last_supervisor', { user_id: company.owner }), '42501', /permission denied/);
  });
});

// Membership goes by the same rule the guard does (migration 20261116002300).
// An access token outlives a ban or a soft delete, so the database must not
// take one as a member: from the moment the account is banned or soft-deleted
// it is nobody in any company.
describe('a supervisor banned or soft-deleted while their token still works', () => {
  for (const [how, gone] of Object.entries(GONE)) {
    it(`has no supervisor power left once ${how}: cannot promote a crony and push out the supervisor who can sign in`, async () => {
      const company = await startCompany(db, { roster: [{ first: 'Maria', last: 'De La Cruz' }] });
      const legit = await secondSupervisor(db, company, 'Ana', 'Diaz');
      const crony = await newMember(db, company, 'Maria', 'De La Cruz');
      // The server checks first, as it was told to, and then bans or soft-deletes.
      assert.equal(await db.serviceRole().call('is_last_supervisor', { user_id: company.owner }), false);
      await gone(company.owner);

      const as = db.as(company.owner);
      assert.equal(await as.call('is_supervisor', { company_id: company.id }), false, `a ${how} account still passes is_supervisor()`);
      assert.equal(await as.call('is_member', { company_id: company.id }), false);
      assert.equal(await as.affected("update public.roster set role = 'supervisor' where id = $1", [company.rows['Maria De La Cruz']]), 0);
      assert.equal(await as.affected('update public.roster set active = false where user_id = $1', [legit]), 0);
      assert.equal(await as.affected('delete from public.roster where user_id = $1', [legit]), 0);
      assert.equal(await as.affected("update public.companies set name = 'Taken' where id = $1", [company.id]), 0);
      await refused(as.call('rotate_join_code', { company_id: company.id }), NOT_FOUND);
      await refused(as.call('release_roster_claim', { roster_id: company.rows['Ana Diaz'] }), NOT_FOUND);

      // Nor can it let a second account of its own in as a supervisor.
      const sock = await db.newAccount('sock');
      assert.equal((await join(db, sock, company.code, 'Lou', 'Penrose')).status, 'pending');
      const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'pending'", [sock]);
      await refused(as.call('approve_join_request', { request_id: request.id, role: 'supervisor' }), NOT_FOUND);
      await refused(as.call('deny_join_request', { request_id: request.id, bar: true }), NOT_FOUND);
      await refused(as.call('lift_join_bar', { request_id: request.id }), NOT_FOUND);

      // And it reads nothing.
      for (const table of ['companies', 'roster', 'join_requests', 'notifications']) {
        assert.deepEqual(await as.rows(`select * from public.${table}`), [], table);
      }

      assert.deepEqual(await usableSupervisors(company.id), [legit]);
      assert.equal((await rosterRow(db, company.rows['Maria De La Cruz'])).role, 'employee');
      assert.equal(await db.as(crony).call('is_supervisor', { company_id: company.id }), false);
      assert.equal(await db.as(legit).call('is_supervisor', { company_id: company.id }), true);
    });

    it(`is no member as an employee either once ${how}, and cannot start a company or join one`, async () => {
      const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }, { first: 'Bo', last: 'Ellison' }] });
      const kit = await newMember(db, company, 'Kit', 'Marlow');
      await gone(kit);
      assert.equal(await db.as(kit).call('is_member', { company_id: company.id }), false);
      assert.deepEqual(await db.as(kit).rows('select * from public.roster'), []);
      const other = await startCompany(db, { name: 'Test Pit B', roster: [{ first: 'Kit', last: 'Marlow' }] });
      await refused(join(db, kit, other.code, 'Kit', 'Marlow'), NOT_SIGNED_IN, /can no longer sign in/);
      await refused(
        db.as(kit).callRows('create_company', { name: 'Test Pit C', state: 'CA', timezone: null, first_name: 'Kit', last_name: 'Marlow' }),
        NOT_SIGNED_IN,
        /can no longer sign in/,
      );
      assert.equal((await rosterRow(db, other.rows['Kit Marlow'])).user_id, null);
    });
  }

  it('is a supervisor again once a ban has run out', async () => {
    const company = await startCompany(db);
    await db.admin("update auth.users set banned_until = now() - interval '1 minute' where id = $1", [company.owner]);
    assert.equal(await db.as(company.owner).call('is_supervisor', { company_id: company.id }), true);
    assert.equal(await db.as(company.owner).affected("update public.companies set name = 'Test Pit A2' where id = $1", [company.id]), 1);
  });
});

// A ban or a soft delete happens outside the database's transaction, so the
// guard cannot refuse it. The server first steps the account down through the
// roster (step_down_everywhere), where the guard refuses atomically, and bans
// it only once that has gone through.
describe('the server stepping an account down before it bans it', () => {
  const stepDown = (id) => db.serviceRole().call('step_down_everywhere', { user_id: id });

  it('leaves a supervisor who can sign in when the two supervisors are taken away at once', async () => {
    const company = await startCompany(db);
    const second = await secondSupervisor(db, company);
    // Both are stepped down before either is banned, as a batch job would.
    const outcomes = [];
    for (const account of [company.owner, second]) outcomes.push(await stepDown(account).then((n) => n, (error) => error.code));
    assert.deepEqual(outcomes, [1, LAST_SUPERVISOR]);
    // The server bans only an account that stepped down.
    await ban(company.owner);
    assert.deepEqual(await usableSupervisors(company.id), [second]);
  });

  /** Make an account a supervisor of a company too: a supervisor row, and a request its owner approves onto it. */
  async function supervisorToo(company, account, first, last) {
    const rowId = await addToRoster(db, company.owner, company.id, { first, last, role: 'supervisor' }, company.rows);
    assert.equal((await join(db, account, company.code, first, last)).reason, 'supervisor_row');
    const [request] = await db.adminRows(
      "select id from public.join_requests where user_id = $1 and company_id = $2 and status = 'pending'",
      [account, company.id],
    );
    await db.as(company.owner).call('approve_join_request', { request_id: request.id, roster_id: rowId });
  }

  it('steps the account down in every company it supervises, in one statement, or nowhere', async () => {
    const a = await startCompany(db);
    const b = await startCompany(db, { name: 'Test Pit B' });
    // One account supervises both, beside each company's owner.
    const both = await secondSupervisor(db, a, 'Ana', 'Diaz');
    await supervisorToo(b, both, 'Ana', 'Diaz');
    assert.equal(await stepDown(both), 2);
    assert.deepEqual(await usableSupervisors(a.id), [a.owner]);
    assert.deepEqual(await usableSupervisors(b.id), [b.owner]);
    assert.equal(await db.as(both).call('is_member', { company_id: b.id }), true, 'it stays on the roster as an employee');

    // B's owner supervises A too, beside A's owner, but is B's only supervisor:
    // refused, and it stays a supervisor of A as well.
    await supervisorToo(a, b.owner, 'Jo', 'Vale');
    await refused(stepDown(b.owner), LAST_SUPERVISOR, LAST);
    assert.deepEqual(await usableSupervisors(a.id), [a.owner, b.owner].sort());
    assert.deepEqual(await usableSupervisors(b.id), [b.owner]);
    assert.equal(await stepDown(await db.newAccount()), 0, 'an account on no roster');
  });

  it("is the server key's alone", async () => {
    const company = await startCompany(db);
    const second = await secondSupervisor(db, company);
    await refused(db.as(company.owner).call('step_down_everywhere', { user_id: second }), NOT_SIGNED_IN, /permission denied/);
    await refused(db.anon().call('step_down_everywhere', { user_id: second }), NOT_SIGNED_IN, /permission denied/);
    assert.deepEqual(await usableSupervisors(company.id), [company.owner, second].sort());
  });
});
