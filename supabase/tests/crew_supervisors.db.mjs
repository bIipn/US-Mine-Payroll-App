// The supervisor side of crew passcodes (migration 20261122000100):
//   roster_before_write       a supervisor's row is never held by a passcode account, on any path that
//                             writes one, and crew_keep_passcode keeps no passcode for an account that
//                             holds a supervisor's row: supervisors sign in with email. A passcode
//                             account holds rows in one company only, whichever way it would come to
//                             hold them in two;
//   make_passcode_reset_code  a supervisor of the company makes a 6-digit reset code for a row held by a
//                             passcode account, shown to them once, good for 30 minutes and 5 tries;
//   crew_reset_check          the person types it in the app with a new passcode, and crew-auth asks this
//                             with the server key: the person found as the sign-in check finds them, the
//                             code checked and counted, and the new passcode kept;
//   crew_sign_in_to_delete    the passcode account on a row of the supervisor's own company, which the
//                             supervisor-tools function then deletes with Supabase Auth.
//
// The two a supervisor calls answer a row of a company the caller does not supervise exactly as they answer
// an id nobody has, as release_roster_claim does: a refusal never tells a real id from a made-up one.
//
// A crew account is made here as crew-auth makes one: an account, its passcode kept with the server key,
// and the name typed to join. The names, passcodes, codes and addresses are made up (the addresses are
// from the ranges kept for documentation). No test message names a passcode, a reset code, a digest or a
// login: the tests assert on them.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  addToRoster,
  errorOf,
  join,
  newMember,
  NO_PRIVILEGE,
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

// Three that pass the passcode rule, and one that is wrong for all of them.
const PASSCODE = '583920';
const OTHER = '904712';
const THIRD = '275019';
const WRONG = '583921';

const MINUTE = 60 * 1000;

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

let sent = 0;
/** An address no request has come from yet, so each test's tries are its own. */
const anyAddress = () => `2001:db8:4::${(sent += 1).toString(16)}`;

const server = () => db.serviceRole();
const keep = (user, passcode) => server().call('crew_keep_passcode', { p_user: user, p_passcode: passcode });
const signInCheck = (code, first, last, passcode, address = anyAddress()) =>
  server().call('crew_sign_in_check', { p_code: code, p_first: first, p_last: last, p_passcode: passcode, p_address: address });
const resetCheck = (code, first, last, resetCode, newPasscode, address = anyAddress()) =>
  server().call('crew_reset_check', {
    p_code: code,
    p_first: first,
    p_last: last,
    p_reset_code: resetCode,
    p_new_passcode: newPasscode,
    p_address: address,
  });
const makeCode = (supervisor, rowId) => db.as(supervisor).call('make_passcode_reset_code', { p_roster_id: rowId });
const toDelete = (supervisor, rowId) => db.as(supervisor).call('crew_sign_in_to_delete', { p_roster_id: rowId });

/** A crew account, made as crew-auth makes one: an account, its passcode kept, and the name typed to join. */
async function crewMember(company, first, last, passcode = PASSCODE) {
  const account = await db.newAccount('crew');
  await keep(account, passcode);
  const joined = await join(db, account, company.code, first, last);
  return { account, joined };
}

const takeOff = (company, name) => db.as(company.owner).query('update public.roster set active = false where id = $1', [company.rows[name]]);

/** An account's counts, lock and reset code, as kept. */
const loginOf = async (account) =>
  (
    await db.adminRows(
      'select wrong_in_a_row, locked_until, reset_digest, reset_until, reset_tries from public.crew_logins where user_id = $1',
      [account],
    )
  )[0];

const emailOf = async (account) => (await db.adminRows('select email from auth.users where id = $1', [account]))[0].email;
const loginPassword = async (email) => (await db.adminRows('select public.crew_login_password($1) as password', [email]))[0].password;

/** The answer to a check that let the account in, with its login checked and set aside. */
async function signedIn(answer, account) {
  const email = await emailOf(account);
  assert.equal(answer.status, 'ok');
  assert.ok(answer.login_email === email, "the login is the account's own address");
  assert.ok(answer.login_password === (await loginPassword(email)), 'and the password worked out from it');
  const { login_email: _email, login_password: _password, ...rest } = answer;
  return rest;
}

/** Everything these functions could make or change, as the owner sees it. */
const everything = async () =>
  (
    await db.adminRows(`
      select (select count(*) from auth.users)::int as accounts,
             (select count(*) from public.companies)::int as companies,
             (select count(*) from public.notifications)::int as notifications,
             (select pg_catalog.jsonb_agg(l order by l.user_id) from public.crew_logins l) as logins,
             (select pg_catalog.jsonb_agg(j order by j.id) from public.join_requests j) as requests,
             (select pg_catalog.jsonb_agg(h order by h.company_id, h.user_id, h.kind) from public.join_holds h) as holds,
             (select pg_catalog.jsonb_agg(r order by r.id) from public.roster r) as roster`)
  )[0];

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((part) => Buffer.from(part)))).digest();

/** Another code than this one: its last digit moved on by one. */
const otherThan = (code) => code.slice(0, 5) + String((Number(code[5]) + 1) % 10);

/** A function's definition, its comments taken out. */
const definitionOf = async (fn) =>
  (await db.adminRows(`select pg_get_functiondef('public.${fn}'::regproc) as def`))[0].def.replace(/--[^\n]*/g, ' ');

/** Refused because supervisors sign in with email. */
async function needsEmail(promise) {
  const error = await refused(promise, WRONG_STATE);
  assert.equal(error.hint, 'supervisor_needs_email', error.message);
  return error;
}

/** Refused because no passcode account holds the row. */
async function notPasscode(promise) {
  const error = await refused(promise, WRONG_STATE);
  assert.equal(error.hint, 'not_a_passcode_account', error.message);
  return error;
}

/** Refused because a passcode account is for one company only. */
async function elsewhere(promise) {
  const error = await refused(promise, WRONG_STATE);
  assert.equal(error.hint, 'passcode_account_elsewhere', error.message);
  return error;
}

/** Refused as a row there is not: word for word what an id nobody has gets. */
async function noSuchRow(promise, madeUp) {
  const error = await refused(promise, NOT_FOUND, /^No such roster row\.$/);
  assert.deepEqual(error, madeUp, 'the same answer as for an id nobody has');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether a statement takes the account's lock, the one crew_keep_passcode takes. The statement runs in a
 * DO block, which then reads pg_locks for that advisory lock (hashtextextended('crew_logins ' || the
 * account's id), held by this session) and raises what it found, so the statement is rolled back. Only
 * statements written here run this way, with ids the tests made.
 */
async function takesTheLock(statement, account) {
  assert.match(account, UUID);
  const error = await errorOf(
    db.admin(`do $probe$
      begin
        ${statement};
        raise exception using errcode = 'P0001', message = case when exists (
          select 1 from pg_catalog.pg_locks l
          where l.locktype = 'advisory' and l.objsubid = 1 and l.granted and l.pid = pg_catalog.pg_backend_pid()
            and ((l.classid::bigint << 32) | l.objid::bigint) = pg_catalog.hashtextextended('crew_logins ' || '${account}', 0)
        ) then 'held' else 'not held' end;
      end
    $probe$`),
  );
  assert.equal(error.code, 'P0001', error.message);
  return error.message === 'held';
}

describe('supervisors sign in with email', () => {
  it('a passcode account never holds a supervisor row: not by approval, a role change or an insert', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Ana', last: 'Diaz', role: 'supervisor' }] });
    // Jo Vale's supervisor row is held by an email account, let onto it the usual way.
    await secondSupervisor(db, company, 'Jo', 'Vale');
    // A crew account types a supervisor's name. The app sends that name to the email sign-in; joining by
    // hand leaves a request, as it does for anyone who types a supervisor's name. Another is on the
    // roster as crew.
    const ana = await crewMember(company, 'Ana', 'Diaz');
    assert.deepEqual(ana.joined, { status: 'pending', company_name: 'Test Pit A', reason: 'supervisor_row' });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    assert.equal(riley.joined.status, 'joined');
    const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'pending'", [ana.account]);
    const approve = (args) => db.as(company.owner).call('approve_join_request', { request_id: request.id, ...args });
    const rileyRow = company.rows['Riley J Quinn'];
    const before = await everything();

    // By approval: onto the supervisor's row nobody holds, onto one an email account holds (handed over in
    // one step), or as a new supervisor's row; and by any other claim of a supervisor's row.
    await needsEmail(approve({ roster_id: company.rows['Ana Diaz'] }));
    await needsEmail(approve({ roster_id: company.rows['Jo Vale'], replace_claim: true }));
    await needsEmail(approve({ role: 'supervisor' }));
    await needsEmail(server().query('update public.roster set user_id = $1 where id = $2', [ana.account, company.rows['Ana Diaz']]));
    // By a role change: made by a supervisor, with the server key or in the SQL editor, on the roster or
    // taken off it (a row taken off can be put back).
    await needsEmail(db.as(company.owner).query("update public.roster set role = 'supervisor' where id = $1", [rileyRow]));
    await needsEmail(db.as(company.owner).query("update public.roster set role = 'supervisor', active = false where id = $1", [rileyRow]));
    await needsEmail(server().query("update public.roster set role = 'supervisor' where id = $1", [rileyRow]));
    await needsEmail(db.admin("update public.roster set role = 'supervisor' where id = $1", [rileyRow]));
    // By an insert: the account starting a company, which makes it the company's first supervisor, or a
    // supervisor's row written with the server key or in the SQL editor.
    await needsEmail(
      db.as(riley.account).callRows('create_company', { name: 'Test Pit B', state: 'NV', timezone: null, first_name: 'Riley J', last_name: 'Quinn', title: null }),
    );
    const insert = "insert into public.roster (company_id, first_name, last_name, role, user_id) values ($1, 'Kit', 'Marlow', 'supervisor', $2)";
    await needsEmail(server().query(insert, [company.id, ana.account]));
    await needsEmail(db.admin(insert, [company.id, ana.account]));
    // None of them wrote anything.
    assert.deepEqual(await everything(), before);

    // Crew stay crew: the request is let in, as an employee.
    const row = await rosterRow(db, await approve({}));
    assert.deepEqual([row.role, row.user_id, row.active], ['employee', ana.account, true]);
  });

  it('the server key keeps no passcode for an account that holds a supervisor row, in any company', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Lee', last: 'Park' }] });
    const jo = await secondSupervisor(db, company, 'Jo', 'Vale');
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'] });
    // Pat Cole, a supervisor at Test Pit B, is also on Test Pit A's roster as an employee; Jo Vale's
    // supervisor row is taken off the roster, and a supervisor can put it back.
    assert.equal((await join(db, other.owner, company.code, 'Lee', 'Park')).status, 'joined');
    await takeOff(company, 'Jo Vale');
    const supervisors = [company.owner, jo, other.owner];
    for (const account of supervisors) await needsEmail(keep(account, PASSCODE));
    assert.deepEqual(await db.adminRows('select user_id from public.crew_logins where user_id = any ($1::uuid[])', [supervisors]), []);
    // An account with no supervisor's row keeps one, as crew-auth keeps one for each account it makes.
    const crew = await db.newAccount('crew');
    await keep(crew, PASSCODE);
    assert.equal((await db.adminRows('select user_id from public.crew_logins where user_id = $1', [crew])).length, 1);
  });

  it("a supervisor's row and a passcode take turns for one account", async () => {
    // PGlite is one session, so the two cannot be sent at once here: the order is read from the code. Each
    // takes the account's lock before it looks for what the other writes (the trigger for a passcode and
    // for the account's rows elsewhere, crew_keep_passcode for the account's rows), so the one that comes
    // second waits for the first to commit and then sees what it wrote.
    for (const [fn, account, looks] of [
      ['roster_before_write', /new\.user_id\b/, [/\bfrom\s+public\.crew_logins\b/i, /\bfrom\s+public\.roster\b/i]],
      ['crew_keep_passcode', /p_user\b/, [/\bfrom\s+public\.roster\b/i]],
    ]) {
      const body = await definitionOf(fn);
      const lock = body.search(
        new RegExp(String.raw`\bpg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\s*\(\s*'crew_logins '\s*\|\|\s*${account.source}`, 'i'),
      );
      assert.ok(lock > 0, `${fn} takes the account's lock`);
      for (const look of looks) assert.ok(lock < body.search(look), `${fn} takes it before it looks (${look.source})`);
    }
    const keeping = await definitionOf('crew_keep_passcode');
    assert.ok(keeping.search(/\bfrom\s+public\.roster\b/i) < keeping.search(/\binsert\s+into\s+public\.crew_logins\b/i), 'it looks before it keeps the passcode');
  });

  it("every write that puts an account on a row, or writes a supervisor's row it holds, takes the lock keeping a passcode takes", async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    const jo = await secondSupervisor(db, company, 'Jo', 'Vale');
    const visitor = await db.newAccount('visitor');
    for (const id of [company.id, company.rows['Kit Marlow'], company.rows['Jo Vale']]) assert.match(id, UUID);
    // The probe itself: a statement that takes no lock is told apart.
    assert.equal(await takesTheLock('perform 1', visitor), false);
    // Keeping a passcode takes the account's lock, and so does every write the trigger looks at for it: a
    // claim of a row, a row written with an account on it, and a change to a supervisor's row an account
    // holds. Two such writes for one account take turns.
    assert.equal(await takesTheLock(`perform public.crew_keep_passcode('${visitor}', '${OTHER}')`, visitor), true);
    assert.equal(await takesTheLock(`update public.roster set user_id = '${visitor}' where id = '${company.rows['Kit Marlow']}'`, visitor), true);
    assert.equal(
      await takesTheLock(`insert into public.roster (company_id, first_name, last_name, user_id) values ('${company.id}', 'Lee', 'Park', '${visitor}')`, visitor),
      true,
    );
    assert.equal(await takesTheLock(`update public.roster set title = 'Loader' where id = '${company.rows['Jo Vale']}'`, jo), true);
    // Each probe was rolled back.
    assert.deepEqual(await db.adminRows('select user_id from public.crew_logins where user_id = $1', [visitor]), []);
    assert.deepEqual(await db.adminRows('select id from public.roster where user_id = $1', [visitor]), []);
    assert.equal((await rosterRow(db, company.rows['Jo Vale'])).title, null);
  });
});

describe('one company per passcode account', () => {
  it('a passcode account holds rows in one company only: not by a join request approved in a second company, nor by a claim or an insert there', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'], roster: [{ first: 'Lee', last: 'Park' }, { first: 'Kit', last: 'Marlow' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    assert.equal(riley.joined.status, 'joined');
    // The account types Test Pit B's code by hand: the app never does, and a sign-up there makes an account
    // of its own. A name on no row there leaves a request.
    assert.deepEqual(await join(db, riley.account, other.code, 'Jo', 'Vale'), { status: 'pending', company_name: 'Test Pit B', reason: 'not_on_roster' });
    const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and company_id = $2 and status = 'pending'", [
      riley.account,
      other.id,
    ]);
    const approve = (args) => db.as(other.owner).call('approve_join_request', { request_id: request.id, ...args });
    const insert = "insert into public.roster (company_id, first_name, last_name, user_id) values ($1, 'Jo', 'Vale', $2)";
    async function triesInTestPitB() {
      const before = await everything();
      // The request approved there, onto a row or as a new one.
      await elsewhere(approve({ roster_id: other.rows['Lee Park'] }));
      await elsewhere(approve({}));
      // A name on that roster, typed by the account, which would claim the row.
      await elsewhere(join(db, riley.account, other.code, 'Kit', 'Marlow'));
      // A claim or an insert there, with the server key or in the SQL editor.
      await elsewhere(server().query('update public.roster set user_id = $1 where id = $2', [riley.account, other.rows['Lee Park']]));
      await elsewhere(server().query(insert, [other.id, riley.account]));
      await elsewhere(db.admin(insert, [other.id, riley.account]));
      assert.deepEqual(await everything(), before);
    }
    await triesInTestPitB();
    // Taken off Test Pit A's roster, the account still holds that row, and the row can be put back.
    await takeOff(company, 'Riley J Quinn');
    await triesInTestPitB();
    // Test Pit B's people are let in as ever: an email account claims the row.
    assert.equal((await join(db, await db.newAccount('email'), other.code, 'Lee', 'Park')).status, 'joined');
  });

  it('a second row in the same company is left to the rules there already are', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    // One row per account in a company: the roster's own unique index refuses a second (23505), not this rule.
    for (const [sql, params] of [
      ["insert into public.roster (company_id, first_name, last_name, user_id) values ($1, 'Jo', 'Vale', $2)", [company.id, riley.account]],
      ['update public.roster set user_id = $1 where id = $2', [riley.account, company.rows['Kit Marlow']]],
    ]) {
      const error = await errorOf(server().query(sql, params));
      assert.equal(error.code, '23505', error.message);
      assert.match(error.message, /roster_one_row_per_account/);
    }
    // Taken off the roster, the person asks to come back, and a supervisor lets them onto a new row: the row
    // taken off lets go of the account, as it always has.
    await takeOff(company, 'Riley J Quinn');
    assert.deepEqual(await join(db, riley.account, company.code, 'Riley', 'Quinn'), { status: 'pending', company_name: 'Test Pit A', reason: 'removed' });
    const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'pending'", [riley.account]);
    const fresh = await addToRoster(db, company.owner, company.id, { first: 'Riley J', last: 'Quinn' });
    assert.equal(await db.as(company.owner).call('approve_join_request', { request_id: request.id, roster_id: fresh }), fresh);
    const held = await db.adminRows('select id, active from public.roster where user_id = $1', [riley.account]);
    assert.deepEqual(held, [{ id: fresh, active: true }]);
    // Signed in by the name as written: beside the old row, taken off under that name, the looser fit is
    // passed over, as joining passes it over.
    assert.equal((await signInCheck(company.code, 'Riley J', 'Quinn', PASSCODE)).status, 'ok');
  });

  it('the server key keeps no passcode for an account that holds rows in two companies', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Lee', last: 'Park' }] });
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'], roster: [{ first: 'Kit', last: 'Marlow' }] });
    // An email account on both rosters, its row at Test Pit B taken off: it still holds that row.
    const account = await newMember(db, company, 'Lee', 'Park');
    assert.equal((await join(db, account, other.code, 'Kit', 'Marlow')).status, 'joined');
    await takeOff(other, 'Kit Marlow');
    await elsewhere(keep(account, PASSCODE));
    assert.deepEqual(await db.adminRows('select user_id from public.crew_logins where user_id = $1', [account]), []);
  });
});

describe('make_passcode_reset_code', () => {
  it('only a supervisor of the company makes a reset code, and only for a row held by a passcode account', async () => {
    const company = await startCompany(db, {
      roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }, { first: 'Lee', last: 'Park' }, { first: 'Jo', last: 'Vale' }],
    });
    const ana = await secondSupervisor(db, company, 'Ana', 'Diaz');
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const kit = await crewMember(company, 'Kit', 'Marlow');
    await takeOff(company, 'Kit Marlow');
    const lee = await newMember(db, company, 'Lee', 'Park');
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'] });
    const rileyRow = company.rows['Riley J Quinn'];
    const before = await everything();

    // Nobody signed in is told to sign in. To anyone else who is not a supervisor of the company (crew, an
    // email account on the roster, a supervisor of another company), the row is not there: the answer an id
    // nobody has gets, word for word, so a refusal never tells a real id from a made-up one.
    await refused(db.noAccount().call('make_passcode_reset_code', { p_roster_id: rileyRow }), NOT_SIGNED_IN, /Sign in first/);
    const madeUp = await refused(makeCode(company.owner, nobody()), NOT_FOUND, /^No such roster row\.$/);
    for (const caller of [riley.account, kit.account, lee, other.owner]) {
      await noSuchRow(makeCode(caller, rileyRow), madeUp);
      await noSuchRow(makeCode(caller, nobody()), madeUp);
    }
    // Only for a row held by a passcode account: not one an email account holds, one nobody holds, or a
    // supervisor's own.
    for (const row of [company.rows['Lee Park'], company.rows['Jo Vale'], company.ownRow, company.rows['Ana Diaz']]) {
      await notPasscode(makeCode(company.owner, row));
    }
    // The public key and the server key cannot call it at all.
    for (const session of [db.anon(), server()]) {
      await refused(session.call('make_passcode_reset_code', { p_roster_id: rileyRow }), NO_PRIVILEGE, /permission denied for function make_passcode_reset_code/);
    }
    assert.deepEqual(await everything(), before);

    // Each supervisor of the company makes one, for a person on the roster or taken off it.
    for (const [supervisor, row, account] of [
      [company.owner, rileyRow, riley.account],
      [ana, company.rows['Kit Marlow'], kit.account],
    ]) {
      assert.match(await makeCode(supervisor, row), /^[0-9]{6}$/);
      const login = await loginOf(account);
      assert.notEqual(login.reset_digest, null);
      assert.equal(login.reset_tries, 0);
    }
  });

  it('a reset code is 6 digits, good for 30 minutes and 5 tries, and sets a new passcode', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const make = () => makeCode(company.owner, company.rows['Riley J Quinn']);
    const reset = (code, passcode) => resetCheck(company.code, 'Riley', 'Quinn', code, passcode);
    const theirs = { status: 'ok', company_id: company.id, company_name: 'Test Pit A', waiting: false };

    // Six digits, leading zeros and all, a new one each time.
    const codes = [];
    for (let i = 0; i < 300; i += 1) codes.push(await make());
    assert.ok(codes.every((code) => /^[0-9]{6}$/.test(code)), 'six digits each');
    assert.ok(new Set(codes).size >= 295, 'a new code each time');
    // One code in ten starts with 0: 300 with none would come up less than once in 10^13 runs.
    assert.ok(codes.some((code) => code.startsWith('0')), 'a code may start with 0');
    // From random bytes (gen_random_uuid), never random().
    const making = await definitionOf('make_passcode_reset_code');
    assert.match(making, /\bpg_catalog\.gen_random_uuid\(\)/);
    assert.doesNotMatch(making, /\brandom\s*\(/);

    // Kept only as a digest: SHA-256 of the crew key, the account's salt and the code, marked as a reset
    // code, so it never matches a passcode of the same digits.
    const code = codes.at(-1);
    const [{ key }] = await db.adminRows('select key from public.crew_key');
    const [kept] = await db.adminRows('select salt, reset_digest, reset_until, reset_tries from public.crew_logins where user_id = $1', [riley.account]);
    const salt = Buffer.from(kept.salt);
    const digest = Buffer.from(kept.reset_digest);
    assert.equal(digest.length, 32);
    assert.ok(!digest.includes(Buffer.from(code)), 'the code as shown is not kept');
    assert.ok(digest.equals(sha256(key, salt, `reset:${code}`)), "sha256 of the key, the account's salt, reset: and the code");
    assert.ok(!digest.equals(sha256(code)) && !digest.equals(sha256(salt, code)), 'not a hash anyone could work out without the key');
    assert.ok(!digest.equals(sha256(key, salt, code)), 'nor the digest a passcode of the same digits has');
    // Good for 30 minutes from when it was made, with all 5 tries.
    const ahead = new Date(kept.reset_until).getTime() - Date.now();
    assert.ok(ahead > 29 * MINUTE && ahead <= 30 * MINUTE + 1000, `good for ${Math.round(ahead / 1000)} s more`);
    assert.equal(kept.reset_tries, 0);

    // Wrong codes count down from 5 tries, and the right one on the fifth still works.
    for (const left of [4, 3, 2, 1]) assert.deepEqual(await reset(otherThan(code), OTHER), { status: 'bad_reset_code', tries_left: left });
    assert.deepEqual(await signedIn(await reset(code, OTHER), riley.account), theirs);
    // The new passcode signs in, and the old one is wrong.
    assert.equal((await signInCheck(company.code, 'Riley', 'Quinn', OTHER)).status, 'ok');
    assert.deepEqual(await signInCheck(company.code, 'Riley', 'Quinn', PASSCODE), { status: 'wrong', tries_left: 4 });

    // Five wrong spend a code: the right one then answers expired, and nothing more is counted.
    const spent = await make();
    for (const left of [4, 3, 2, 1, 0]) assert.deepEqual(await reset(otherThan(spent), THIRD), { status: 'bad_reset_code', tries_left: left });
    assert.deepEqual(await reset(spent, THIRD), { status: 'expired' });
    assert.equal((await loginOf(riley.account)).reset_tries, 5);
    // Thirty minutes spend one too, with no try counted.
    const late = await make();
    await db.admin("update public.crew_logins set reset_until = now() - interval '1 second' where user_id = $1", [riley.account]);
    assert.deepEqual(await reset(late, THIRD), { status: 'expired' });
    assert.equal((await loginOf(riley.account)).reset_tries, 0);
    // Neither set a passcode.
    assert.equal((await signInCheck(company.code, 'Riley', 'Quinn', OTHER)).status, 'ok');

    // A new code replaces the one before: the older is then a wrong code, counted against the newer.
    const older = await make();
    let newer = await make();
    while (newer === older) newer = await make();
    assert.deepEqual(await reset(older, THIRD), { status: 'bad_reset_code', tries_left: 4 });
    // A passcode the rule refuses is turned down before the code is tried, and spends no try.
    for (const [passcode, problem] of [['123456', 'easy'], ['58392', 'too_short'], ['', 'not_digits'], [null, 'not_digits']]) {
      assert.deepEqual(await reset(newer, passcode), { status: 'easy_passcode', problem });
    }
    assert.equal((await loginOf(riley.account)).reset_tries, 1);
    assert.deepEqual(await signedIn(await reset(newer, THIRD), riley.account), theirs);
    assert.equal((await signInCheck(company.code, 'Riley', 'Quinn', THIRD)).status, 'ok');
  });

  it('a reset code works while the account is locked, and does not work twice', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const kit = await crewMember(company, 'Kit', 'Marlow');
    // Riley Quinn is locked until a reset: ten wrong in a row, across the 15 minutes.
    for (let i = 0; i < 5; i += 1) await signInCheck(company.code, 'Riley', 'Quinn', WRONG);
    await db.admin("update public.crew_logins set locked_until = now() - interval '1 second' where user_id = $1", [riley.account]);
    for (let i = 0; i < 5; i += 1) await signInCheck(company.code, 'Riley', 'Quinn', WRONG);
    assert.deepEqual(await signInCheck(company.code, 'Riley', 'Quinn', PASSCODE), { status: 'locked', until: null });
    // Kit Marlow is locked for 15 minutes: five wrong in a row.
    for (let i = 0; i < 5; i += 1) await signInCheck(company.code, 'Kit', 'Marlow', WRONG);
    assert.equal((await signInCheck(company.code, 'Kit', 'Marlow', PASSCODE)).status, 'locked');

    // A code made for each opens nothing by itself...
    const codes = [
      ['Riley', 'Quinn', riley.account, await makeCode(company.owner, company.rows['Riley J Quinn'])],
      ['Kit', 'Marlow', kit.account, await makeCode(company.owner, company.rows['Kit Marlow'])],
    ];
    assert.deepEqual(await signInCheck(company.code, 'Riley', 'Quinn', PASSCODE), { status: 'locked', until: null });
    assert.equal((await signInCheck(company.code, 'Kit', 'Marlow', PASSCODE)).status, 'locked');
    const theirs = { status: 'ok', company_id: company.id, company_name: 'Test Pit A', waiting: false };
    for (const [first, last, account, code] of codes) {
      // ...the code with a new passcode does, and clears the count, the lock and the code.
      assert.deepEqual(await signedIn(await resetCheck(company.code, first, last, code, OTHER), account), theirs);
      assert.deepEqual(await loginOf(account), { wrong_in_a_row: 0, locked_until: null, reset_digest: null, reset_until: null, reset_tries: 0 });
      assert.equal((await signInCheck(company.code, first, last, OTHER)).status, 'ok');
      // Not twice: the code is gone, whatever passcode comes with it, and the passcode it set stays.
      assert.deepEqual(await resetCheck(company.code, first, last, code, THIRD), { status: 'expired' });
      assert.equal((await signInCheck(company.code, first, last, OTHER)).status, 'ok');
      assert.deepEqual(await signInCheck(company.code, first, last, THIRD), { status: 'wrong', tries_left: 4 });
    }
  });
});

describe('crew_reset_check', () => {
  it('a wrong reset code made through the reset check stays counted', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const code = await makeCode(company.owner, company.rows['Riley J Quinn']);
    // Each check is a request of its own, committed as it answers.
    for (const [left, tries] of [[4, 1], [3, 2], [2, 3]]) {
      assert.deepEqual(await resetCheck(company.code, 'Riley', 'Quinn', otherThan(code), OTHER), { status: 'bad_reset_code', tries_left: left });
      assert.equal((await loginOf(riley.account)).reset_tries, tries);
    }
    // No passcode was set: the old one still signs in, and the code keeps the tries it has left.
    assert.equal((await signInCheck(company.code, 'Riley', 'Quinn', PASSCODE)).status, 'ok');
    assert.equal((await loginOf(riley.account)).reset_tries, 3);
  });

  it('finds the person as the sign-in check does, once the request is counted against the limit', async () => {
    const company = await startCompany(db, {
      roster: [
        { first: 'Lee Roy', last: 'Park' },
        { first: 'Roy "Lee"', last: 'Park' },
        { first: 'Riley J', last: 'Quinn' },
        { first: 'Kit', last: 'Marlow' },
        { first: 'Jo', last: 'Vale' },
        { first: 'Ana', last: 'Diaz', role: 'supervisor' },
      ],
    });
    const one = await crewMember(company, 'Lee Roy', 'Park');
    const two = await crewMember(company, 'Roy "Lee"', 'Park', OTHER);
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const kit = await crewMember(company, 'Kit', 'Marlow');
    await takeOff(company, 'Kit Marlow');
    await newMember(db, company, 'Jo', 'Vale');
    const codeOf = {};
    for (const name of ['Lee Roy Park', 'Roy "Lee" Park', 'Riley J Quinn', 'Kit Marlow']) codeOf[name] = await makeCode(company.owner, company.rows[name]);
    const theirs = { status: 'ok', company_id: company.id, company_name: 'Test Pit A', waiting: false };

    // A name that fits two people is ambiguous, and no code is tried against either.
    for (const code of [codeOf['Lee Roy Park'], codeOf['Roy "Lee" Park']]) {
      assert.deepEqual(await resetCheck(company.code, 'Roy', 'Park', code, THIRD), { status: 'ambiguous' });
    }
    for (const { account } of [one, two]) assert.equal((await loginOf(account)).reset_tries, 0);
    // A supervisor's row, held or not, and a row an email account holds: they sign in with email.
    for (const [first, last] of [['Sam', 'Ortiz'], ['Ana', 'Diaz'], ['Jo', 'Vale']]) {
      assert.deepEqual(await resetCheck(company.code, first, last, codeOf['Riley J Quinn'], THIRD), { status: 'use_email' });
    }
    // A name nobody signed up with, and a code no company has.
    assert.deepEqual(await resetCheck(company.code, 'Pat', 'Cole', codeOf['Riley J Quinn'], THIRD), { status: 'no_account' });
    assert.deepEqual(await resetCheck('ZZZZZZZZ', 'Riley', 'Quinn', codeOf['Riley J Quinn'], THIRD), { status: 'no_company' });
    // Found the way people type a name, and taken off the roster too.
    assert.deepEqual(await signedIn(await resetCheck(company.code, '  RILEY ', 'quinn', codeOf['Riley J Quinn'], THIRD), riley.account), theirs);
    assert.deepEqual(await signedIn(await resetCheck(company.code, 'kit', ' MARLOW', codeOf['Kit Marlow'], THIRD), kit.account), theirs);

    // Each request is counted first, against the limit the other checks share: 30 from an address in 10
    // minutes. Turned away, it tries no code.
    const address = '203.0.113.21';
    for (let i = 0; i < 30; i += 1) assert.equal((await resetCheck(company.code, 'Pat', 'Cole', '000000', THIRD, address)).status, 'no_account');
    assert.deepEqual(await resetCheck(company.code, 'Lee Roy', 'Park', otherThan(codeOf['Lee Roy Park']), THIRD, address), { status: 'busy' });
    assert.deepEqual(await server().call('crew_lookup', { p_code: company.code, p_address: address }), { status: 'busy' });
    assert.equal((await loginOf(one.account)).reset_tries, 0);
    assert.deepEqual(await signedIn(await resetCheck(company.code, 'Lee Roy', 'Park', codeOf['Lee Roy Park'], THIRD), one.account), theirs);

    // The finder is crew_find_person itself, as for signing in, never a copy of it.
    const body = await definitionOf('crew_reset_check');
    const counted = body.search(/\bpublic\.crew_try_counted\s*\(\s*p_address\s*\)/i);
    const found = body.search(/\bpublic\.crew_find_person\s*\(/i);
    assert.ok(counted > 0 && found > counted, 'the request is counted, then the person looked for');
    assert.doesNotMatch(body, /\b(find_on_roster|same_name|join_requests)\b/i, 'it looks for nobody by itself');
  });
});

describe('crew_sign_in_to_delete', () => {
  it('a supervisor gets the account to delete only for a passcode account of their own company', async () => {
    const company = await startCompany(db, {
      roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }, { first: 'Lee', last: 'Park' }, { first: 'Jo', last: 'Vale' }],
    });
    const ana = await secondSupervisor(db, company, 'Ana', 'Diaz');
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'], roster: [{ first: 'Bo', last: 'Ellison' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const kit = await crewMember(company, 'Kit', 'Marlow');
    await takeOff(company, 'Kit Marlow');
    const lee = await newMember(db, company, 'Lee', 'Park');
    const bo = await crewMember(other, 'Bo', 'Ellison');
    const rileyRow = company.rows['Riley J Quinn'];
    const boRow = other.rows['Bo Ellison'];
    const before = await everything();

    // A supervisor of the company gets the passcode account on its row, on the roster or taken off it.
    assert.equal(await toDelete(company.owner, rileyRow), riley.account);
    assert.equal(await toDelete(ana, company.rows['Kit Marlow']), kit.account);
    assert.equal(await toDelete(other.owner, boRow), bo.account);
    // Nobody signed in is told to sign in. To anyone else who is not a supervisor of the row's company (crew,
    // an email account on the roster, a supervisor of another company), the row is not there, word for word
    // as an id nobody has.
    await refused(db.noAccount().call('crew_sign_in_to_delete', { p_roster_id: rileyRow }), NOT_SIGNED_IN, /Sign in first/);
    const madeUp = await refused(toDelete(company.owner, nobody()), NOT_FOUND, /^No such roster row\.$/);
    for (const [caller, row] of [
      [riley.account, company.rows['Kit Marlow']],
      [lee, rileyRow],
      [other.owner, rileyRow],
      [company.owner, boRow],
      [ana, boRow],
      [other.owner, nobody()],
    ]) {
      await noSuchRow(toDelete(caller, row), madeUp);
    }
    // Only a passcode account: not one with email, nor a row nobody holds, nor a supervisor's own.
    for (const row of [company.rows['Lee Park'], company.rows['Jo Vale'], company.ownRow, company.rows['Ana Diaz']]) {
      await notPasscode(toDelete(company.owner, row));
    }
    // The public key and the server key cannot call it at all.
    for (const session of [db.anon(), server()]) {
      await refused(session.call('crew_sign_in_to_delete', { p_roster_id: rileyRow }), NO_PRIVILEGE, /permission denied for function crew_sign_in_to_delete/);
    }
    // It deletes nothing itself: the supervisor-tools function deletes the account with Supabase Auth.
    assert.deepEqual(await everything(), before);
  });
});

describe('who may call them', () => {
  it('only the server key calls the reset check, which runs where it can write, and the helper is theirs alone', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const args = { p_code: company.code, p_first: 'Riley', p_last: 'Quinn', p_reset_code: '000000', p_new_passcode: OTHER, p_address: anyAddress() };
    for (const session of [db.anon(), db.as(riley.account), db.as(company.owner), db.noAccount()]) {
      await refused(session.call('crew_reset_check', args), NO_PRIVILEGE, /permission denied for function crew_reset_check/);
    }
    for (const session of [db.anon(), db.as(company.owner), server()]) {
      await refused(
        session.call('crew_account_on_row', { p_roster_id: company.rows['Riley J Quinn'] }),
        NO_PRIVILEGE,
        /permission denied for function crew_account_on_row/,
      );
    }
    // The reset check counts a try and a wrong code as it answers, and making a code writes it: volatile,
    // so PostgREST runs them by POST, in a transaction that can write, never by GET in a read-only one.
    const kinds = await db.adminRows('select proname, provolatile from pg_proc where proname = any ($1) order by proname', [
      ['crew_reset_check', 'make_passcode_reset_code'],
    ]);
    assert.deepEqual(kinds, [
      { proname: 'crew_reset_check', provolatile: 'v' },
      { proname: 'make_passcode_reset_code', provolatile: 'v' },
    ]);
  });
});
