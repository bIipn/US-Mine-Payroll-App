// Crew sign-up and sign-in checks (migration 20261122000100). The crew-auth edge function asks these with
// the server key before it talks to Supabase Auth itself:
//   crew_lookup         the company a code is for;
//   crew_sign_up_check  whether a sign-up may go ahead, and the hidden address and password to make the
//                       account with. It makes nothing;
//   crew_sign_in_check  the person found by name the way joining finds them, their passcode checked and
//                       counted, and the login to sign in with;
//   crew_confirm_check  the passcode of the account signed in on the phone, for deleting it.
// Each that takes the phone's network address counts the request first, against at most 30 from that
// address in 10 minutes. Nobody signed in looks a company up by its code any more: the app asks crew-auth.
//
// A crew account is made here as crew-auth makes one: an account, its passcode kept with the server key,
// and the name typed to join. The names, passcodes and addresses are made up (the addresses are from the
// ranges kept for documentation). No test message names a passcode, an address or a login: the tests
// assert on them.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { addToRoster, BAD_INPUT, join, newMember, NO_PRIVILEGE, nobody, refused, startCompany, startDatabase } from './harness.mjs';

// Two that pass the passcode rule, and one that is wrong for both.
const PASSCODE = '583920';
const OTHER = '904712';
const WRONG = '583921';

const HIDDEN_ADDRESS = /^crew-[0-9a-f]{32}@crew\.minemuster\.com$/;
const MINUTE = 60 * 1000;
const EN_DASH = String.fromCharCode(0x2013);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const CYRILLIC_SMALL_IE = String.fromCodePoint(0x0435); // looks like a Latin e

// Names join_company refuses (22023) for what they are: missing, too long, an invisible character, two
// alphabets, and one that only looks like Kit Marlow on the roster (a capital I for the l).
const BAD_NAMES = [
  ['', 'Vale'],
  [null, 'Vale'],
  ['Jo', '   '],
  ['J'.repeat(101), 'Vale'],
  ['Jo', `Va${ZERO_WIDTH_SPACE}le`],
  ['Jo', `Val${CYRILLIC_SMALL_IE}`],
  ['Kit', 'MarIow'],
];

const CHECKS = ['crew_confirm_check', 'crew_lookup', 'crew_sign_in_check', 'crew_sign_up_check'];

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

let sent = 0;
/** An address no request has come from yet, so each test's tries are its own. */
const anyAddress = () => `2001:db8:1::${(sent += 1).toString(16)}`;

const server = () => db.serviceRole();
const lookup = (code, address = anyAddress()) => server().call('crew_lookup', { p_code: code, p_address: address });
const signUpCheck = (code, first, last, passcode = PASSCODE, address = anyAddress()) =>
  server().call('crew_sign_up_check', { p_code: code, p_first: first, p_last: last, p_passcode: passcode, p_address: address });
const signInCheck = (code, first, last, passcode = PASSCODE, address = anyAddress()) =>
  server().call('crew_sign_in_check', { p_code: code, p_first: first, p_last: last, p_passcode: passcode, p_address: address });
const confirmCheck = (user, passcode) => server().call('crew_confirm_check', { p_user: user, p_passcode: passcode });

/** A crew account, made as crew-auth makes one: an account, its passcode kept, and the name typed to join. */
async function crewMember(company, first, last, passcode = PASSCODE) {
  const account = await db.newAccount('crew');
  await server().call('crew_keep_passcode', { p_user: account, p_passcode: passcode });
  const joined = await join(db, account, company.code, first, last);
  return { account, joined };
}

const emailOf = async (account) => (await db.adminRows('select email from auth.users where id = $1', [account]))[0].email;
const loginPassword = async (email) => (await db.adminRows('select public.crew_login_password($1) as password', [email]))[0].password;
const countsOf = async (account) =>
  (await db.adminRows('select wrong_in_a_row, locked_until from public.crew_logins where user_id = $1', [account]))[0];
const takeOff = (company, name) => db.as(company.owner).query('update public.roster set active = false where id = $1', [company.rows[name]]);

/** The answer to a sign-in check that let the account in, with its login checked and set aside. */
async function signedIn(answer, account) {
  const email = await emailOf(account);
  assert.equal(answer.status, 'ok');
  assert.ok(answer.login_email === email, "the login is the account's own address");
  assert.ok(answer.login_password === (await loginPassword(email)), 'and the password worked out from it');
  const { login_email: _email, login_password: _password, ...rest } = answer;
  return rest;
}

/** Everything a check could make or change, as the owner sees it. */
const everything = async () =>
  (
    await db.adminRows(`
      select (select count(*) from auth.users)::int as accounts,
             (select count(*) from public.crew_logins)::int as logins,
             (select count(*) from public.join_requests)::int as requests,
             (select count(*) from public.notifications)::int as notifications,
             (select count(*) from public.join_holds)::int as holds,
             (select pg_catalog.jsonb_agg(r order by r.id) from public.roster r) as roster`)
  )[0];

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((part) => Buffer.from(part)))).digest();

describe('crew_lookup', () => {
  it('looks up a company by its code the forgiving way, and says no company otherwise', async () => {
    const company = await startCompany(db, { name: 'Test Pit A', state: 'NV' });
    const { code } = company;
    const typed = [
      code,
      code.toLowerCase(),
      `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`,
      `  ${code.slice(0, 4)} ${code.slice(4).toLowerCase()}  `,
      `${code.slice(0, 4)}${EN_DASH}${code.slice(4)}`,
    ];
    for (const text of typed) assert.deepEqual(await lookup(text), { status: 'company', name: 'Test Pit A', state: 'NV' });
    for (const text of ['', '   ', null, 'zzzz-zzzz', 'not a code', '%', "' or 1=1 --"]) {
      assert.deepEqual(await lookup(text), { status: 'no_company' });
    }
  });
});

describe('the limit on tries from one address', () => {
  it('counts tries from one address and says busy past 30 in 10 minutes', async () => {
    const company = await startCompany(db);
    const address = '203.0.113.7';
    // The lookup and both checks count against the one limit.
    for (let i = 0; i < 10; i += 1) assert.equal((await lookup(company.code, address)).status, 'company');
    for (let i = 0; i < 10; i += 1) assert.equal((await signInCheck(company.code, 'Pat', 'Cole', PASSCODE, address)).status, 'no_account');
    for (let i = 0; i < 10; i += 1) assert.equal((await signUpCheck(company.code, 'Pat', 'Cole', PASSCODE, address)).status, 'ok');
    // The 31st from that address, whatever it asks, is busy; the address is read trimmed, in lower case.
    assert.deepEqual(await lookup(company.code, address), { status: 'busy' });
    assert.deepEqual(await signInCheck(company.code, 'Pat', 'Cole', PASSCODE, ` ${address} `), { status: 'busy' });
    assert.deepEqual(await signUpCheck(company.code, 'Pat', 'Cole', PASSCODE, address), { status: 'busy' });
    // Another address is not affected.
    assert.deepEqual(await lookup(company.code, '198.51.100.4'), { status: 'company', name: 'Test Pit A', state: 'CA' });
    // An IPv6 address, whatever its capitals.
    for (let i = 0; i < 30; i += 1) assert.equal((await lookup(company.code, i % 2 ? '2001:DB8::7' : '2001:db8::7')).status, 'company');
    assert.deepEqual(await lookup(company.code, '2001:db8::7'), { status: 'busy' });
    // Guessing at codes counts as much as anything: 30 guesses, and even the right code is busy.
    for (let i = 0; i < 20; i += 1) assert.deepEqual(await lookup('ZZZZZZZZ', '198.51.100.23'), { status: 'no_company' });
    for (let i = 0; i < 10; i += 1) assert.deepEqual(await signInCheck('ZZZZZZZZ', 'Pat', 'Cole', PASSCODE, '198.51.100.23'), { status: 'no_company' });
    assert.deepEqual(await lookup(company.code, '198.51.100.23'), { status: 'busy' });

    // A request turned away is not counted, so trying again while busy does not keep anyone waiting longer.
    const [{ key }] = await db.adminRows('select key from public.crew_key');
    const tries = async (from) =>
      (await db.adminRows('select count(*)::int as n from public.crew_sign_in_tries where sender = $1', [sha256(key, from)]))[0].n;
    assert.equal(await tries(address), 30);

    // Once the 10 minutes have gone by, the address is let through again, and what is older is deleted.
    await db.admin("update public.crew_sign_in_tries set at = at - interval '10 minutes'");
    assert.equal((await lookup(company.code, address)).status, 'company');
    assert.equal(await tries(address), 1);
    const old = await db.adminRows("select count(*)::int as n from public.crew_sign_in_tries where at <= now() - interval '10 minutes'");
    assert.equal(old[0].n, 0);
  });

  it('with no address, every request counts against one shared sender, and only a keyed digest is kept', async () => {
    const company = await startCompany(db);
    for (let i = 0; i < 30; i += 1) assert.equal((await lookup(company.code, [null, '', '   '][i % 3])).status, 'company');
    assert.deepEqual(await lookup(company.code, null), { status: 'busy' });
    assert.deepEqual(await signInCheck(company.code, 'Pat', 'Cole', PASSCODE, ''), { status: 'busy' });
    assert.equal((await lookup(company.code, '198.51.100.9')).status, 'company');

    // A digest of the address made with the crew key: 32 bytes, not the address, nor a hash anyone could work out.
    const [{ key }] = await db.adminRows('select key from public.crew_key');
    await lookup(company.code, '192.0.2.44');
    const kept = await db.adminRows('select sender from public.crew_sign_in_tries where sender = $1', [sha256(key, '192.0.2.44')]);
    assert.equal(kept.length, 1);
    for (const { sender } of await db.adminRows('select sender from public.crew_sign_in_tries')) {
      const digest = Buffer.from(sender);
      assert.equal(digest.length, 32);
      assert.ok(!digest.includes(Buffer.from('192.0.2.44')), 'the address is not kept');
      assert.ok(!digest.equals(sha256('192.0.2.44')), 'nor a plain hash of it');
    }
    const [{ same }] = await db.adminRows("select (select key from public.crew_key) = (select key from public.contact_sender_key) as same");
    assert.equal(same, false, 'the crew key, not the contact form key');
  });

  it('tries from one address take turns from the count to the commit', async () => {
    // PGlite is one session, so two requests at once cannot be sent here: the order is read from the code.
    const [{ def }] = await db.adminRows("select pg_get_functiondef('public.crew_try_counted'::regproc) as def");
    const body = def.replace(/--[^\n]*/g, ' ');
    const lock = body.search(/\bpg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\s*\(\s*'crew_sign_in_tries '\s*\|\|\s*pg_catalog\.encode\s*\(\s*who\b/i);
    assert.ok(lock > 0, "a transaction lock on the sender's digest");
    const count = body.search(/\bcount\(\*\)/i);
    const insert = body.search(/\binsert\s+into\s+public\.crew_sign_in_tries\b/i);
    assert.ok(lock < count && count < insert, 'taken before the count, which comes before the insert');
  });
});

describe('crew_sign_up_check', () => {
  it("a sign-up check refuses an easy passcode, a bad name, a name already signed up and a supervisor's row, making nothing", async () => {
    const company = await startCompany(db, {
      roster: [
        { first: 'Riley J', last: 'Quinn' },
        { first: 'Kit', last: 'Marlow' },
        { first: 'Lee', last: 'Park' },
        { first: 'Ana', last: 'Diaz', role: 'supervisor' },
      ],
    });
    // Signed up already: an active row held by a crew account, one taken off the roster, and a request
    // that waits for a supervisor.
    assert.equal((await crewMember(company, 'Riley', 'Quinn')).joined.status, 'joined');
    assert.equal((await crewMember(company, 'Kit', 'Marlow')).joined.status, 'joined');
    await takeOff(company, 'Kit Marlow');
    assert.equal((await crewMember(company, 'Pat', 'Cole')).joined.status, 'pending');
    // A row held by an email account.
    await newMember(db, company, 'Lee', 'Park');
    // What join_company says to each bad name, typed by an account of its own.
    const refusals = [];
    for (const [first, last] of BAD_NAMES) refusals.push(await refused(join(db, await db.newAccount('visitor'), company.code, first, last), BAD_INPUT));

    const before = await everything();

    for (const [passcode, problem] of [
      ['123456', 'easy'],
      ['121212', 'easy'],
      ['58392', 'too_short'],
      ['5839205839201', 'too_long'],
      ['58392a', 'not_digits'],
      ['', 'not_digits'],
      [null, 'not_digits'],
    ]) {
      assert.deepEqual(await signUpCheck(company.code, 'Jo', 'Vale', passcode), { status: 'easy_passcode', problem });
    }
    // A name join_company would refuse, with its words, so no account is made for a name that cannot join.
    for (const [i, [first, last]] of BAD_NAMES.entries()) {
      assert.deepEqual(await signUpCheck(company.code, first, last), { status: 'bad_name', message: refusals[i].message });
    }
    // A name someone has signed up with, capitals and spaces aside.
    for (const [first, last] of [['Riley', 'Quinn'], ['riley j', 'QUINN'], ['Kit', 'Marlow'], ['  pat ', ' cole']]) {
      assert.deepEqual(await signUpCheck(company.code, first, last), { status: 'already_signed_up' });
    }
    // A supervisor's row, claimed or not, and a row held by an email account: they sign in with email.
    for (const [first, last] of [['Sam', 'Ortiz'], ['Ana', 'Diaz'], ['Lee', 'Park']]) {
      assert.deepEqual(await signUpCheck(company.code, first, last), { status: 'use_email' });
    }
    assert.deepEqual(await signUpCheck('ZZZZZZZZ', 'Jo', 'Vale'), { status: 'no_company' });

    assert.deepEqual(await everything(), before);
  });

  it('a sign-up check answers ok with a hidden address on crew.minemuster.com and a password worked out from it', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const before = await everything();
    // A roster row nobody holds yet (the join will claim it), and a name on no row (it will leave a request).
    const answers = [];
    for (const [first, last] of [['Riley', 'Quinn'], ['Pat', 'Cole'], ['Pat', 'Cole'], ['Jo', 'Vale'], ['Riley J', 'Quinn']]) {
      answers.push(await signUpCheck(company.code, first, last));
    }
    for (const answer of answers) {
      assert.deepEqual(Object.keys(answer).sort(), ['company_id', 'company_name', 'login_email', 'login_password', 'status']);
      assert.equal(answer.status, 'ok');
      assert.equal(answer.company_id, company.id);
      assert.equal(answer.company_name, 'Test Pit A');
      assert.ok(HIDDEN_ADDRESS.test(answer.login_email), 'a hidden address on crew.minemuster.com');
      assert.ok(answer.login_password === (await loginPassword(answer.login_email)), 'the password crew_login_password works out from it');
    }
    assert.equal(new Set(answers.map((answer) => answer.login_email)).size, answers.length, 'a new address each time');
    // Nothing is made: crew-auth makes the account with that address and password.
    assert.deepEqual(await everything(), before);
  });
});

describe('crew_sign_in_check', () => {
  it('signs in a person found by name the way joining finds them', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Lee "Buck"', last: 'Park' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const buck = await crewMember(company, 'Buck', 'Park', OTHER);
    assert.equal(riley.joined.status, 'joined');
    assert.equal(buck.joined.status, 'joined');
    const theirs = { status: 'ok', company_id: company.id, company_name: 'Test Pit A', waiting: false };
    for (const [first, last] of [['Riley', 'Quinn'], ['Riley J', 'Quinn'], ['  RILEY   j ', ' quinn ']]) {
      assert.deepEqual(await signedIn(await signInCheck(company.code, first, last, PASSCODE), riley.account), theirs);
    }
    for (const [first, last] of [['Buck', 'Park'], ['Lee', 'park'], ['lee BUCK', 'Park'], ['Lee "Buck"', 'Park']]) {
      assert.deepEqual(await signedIn(await signInCheck(company.code, first, last, OTHER), buck.account), theirs);
    }
    // The code is read as joining reads it.
    const typed = `${company.code.slice(0, 4).toLowerCase()}-${company.code.slice(4).toLowerCase()}`;
    assert.deepEqual(await signedIn(await signInCheck(typed, 'Riley', 'Quinn', PASSCODE), riley.account), theirs);
    // A name nobody has signed up with, a roster row nobody holds, and a code no company has.
    await addToRoster(db, company.owner, company.id, { first: 'Jo', last: 'Vale' });
    assert.deepEqual(await signInCheck(company.code, 'Pat', 'Cole'), { status: 'no_account' });
    assert.deepEqual(await signInCheck(company.code, 'Jo', 'Vale'), { status: 'no_account' });
    assert.deepEqual(await signInCheck('ZZZZZZZZ', 'Riley', 'Quinn'), { status: 'no_company' });
  });

  it('an ambiguous name answers ambiguous and counts no wrong try against anyone', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Lee Roy', last: 'Park' }, { first: 'Roy "Lee"', last: 'Park' }] });
    const one = await crewMember(company, 'Lee Roy', 'Park');
    const two = await crewMember(company, 'Roy "Lee"', 'Park', OTHER);
    assert.equal(one.joined.status, 'joined');
    assert.equal(two.joined.status, 'joined');
    // Roy Park fits both and is neither: whichever passcode is typed, it is checked against nobody.
    for (const passcode of [PASSCODE, OTHER, WRONG]) {
      assert.deepEqual(await signInCheck(company.code, 'Roy', 'Park', passcode), { status: 'ambiguous' });
      assert.deepEqual(await signInCheck(company.code, 'Lee', 'Park', passcode), { status: 'ambiguous' });
    }
    // Two requests that wait under one name, as two sign-ups at once can leave, are ambiguous too.
    const three = await crewMember(company, 'Pat', 'Cole');
    const four = await crewMember(company, 'Pat', 'Cole', OTHER);
    assert.equal(three.joined.status, 'pending');
    assert.equal(four.joined.status, 'pending');
    assert.deepEqual(await signInCheck(company.code, 'Pat', 'Cole', WRONG), { status: 'ambiguous' });
    for (const { account } of [one, two, three, four]) assert.deepEqual(await countsOf(account), { wrong_in_a_row: 0, locked_until: null });
    // A third sign-up for a name two crew accounts signed up with is refused; one for a name that only fits
    // several rows goes ahead, and joining answers it (ambiguous, recording nothing).
    assert.deepEqual(await signUpCheck(company.code, 'Pat', 'Cole'), { status: 'already_signed_up' });
    assert.equal((await signUpCheck(company.code, 'Roy', 'Park')).status, 'ok');
    // Typing the whole name as it is on the roster settles it.
    assert.equal((await signInCheck(company.code, 'Lee Roy', 'Park', PASSCODE)).status, 'ok');
    assert.equal((await signInCheck(company.code, 'Roy "Lee"', 'Park', OTHER)).status, 'ok');
  });

  it('finds a person taken off the roster, and one whose request waits for a supervisor (waiting: true)', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    const kit = await crewMember(company, 'Kit', 'Marlow');
    assert.equal(kit.joined.status, 'joined');
    await takeOff(company, 'Kit Marlow');
    // Taken off the roster: signed in, only to delete the account (the app shows its off-the-roster screen).
    const theirs = { status: 'ok', company_id: company.id, company_name: 'Test Pit A', waiting: false };
    assert.deepEqual(await signedIn(await signInCheck(company.code, ' kit ', 'MARLOW'), kit.account), theirs);

    // Waiting for a supervisor, found by the exact name on the request, capitals and spaces aside.
    const riley = await crewMember(company, 'Riley J', 'Quinn');
    assert.deepEqual(riley.joined, { status: 'pending', company_name: 'Test Pit A', reason: 'not_on_roster' });
    const waiting = { ...theirs, waiting: true };
    assert.deepEqual(await signedIn(await signInCheck(company.code, 'riley  J', ' Quinn'), riley.account), waiting);
    // Not by the looser way a roster name is matched.
    assert.deepEqual(await signInCheck(company.code, 'Riley', 'Quinn'), { status: 'no_account' });
    // Still found once a supervisor puts the name on the roster, until the request is let in: nobody holds
    // that row yet, and a second sign-up for the name would only make a stray account.
    await addToRoster(db, company.owner, company.id, { first: 'Riley J', last: 'Quinn' });
    assert.deepEqual(await signedIn(await signInCheck(company.code, 'Riley J', 'Quinn'), riley.account), waiting);
    assert.deepEqual(await signUpCheck(company.code, 'Riley J', 'Quinn'), { status: 'already_signed_up' });

    // A request a supervisor turned down finds nobody, and neither does one left by an email account.
    const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'pending'", [riley.account]);
    await db.as(company.owner).call('deny_join_request', { request_id: request.id });
    assert.deepEqual(await signInCheck(company.code, 'Riley J', 'Quinn'), { status: 'no_account' });
    assert.equal((await join(db, await db.newAccount('email'), company.code, 'Jo', 'Vale')).status, 'pending');
    assert.deepEqual(await signInCheck(company.code, 'Jo', 'Vale'), { status: 'no_account' });
    // Nor does that one stand in the way of a crew sign-up under the name, or make it ambiguous.
    assert.equal((await signUpCheck(company.code, 'Jo', 'Vale')).status, 'ok');
    const jo = await crewMember(company, 'Jo', 'Vale');
    assert.deepEqual(await signedIn(await signInCheck(company.code, 'Jo', 'Vale'), jo.account), waiting);
  });

  it('a person whose row is held by an email account is sent to the email sign-in', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Lee', last: 'Park' }, { first: 'Ana', last: 'Diaz', role: 'supervisor' }] });
    const lee = await newMember(db, company, 'Lee', 'Park');
    // Lee Park joined with an email account; Sam Ortiz holds a supervisor's row; Ana Diaz's supervisor row
    // is held by nobody yet. Supervisors sign in with email.
    for (const [first, last] of [['Lee', 'Park'], ['Sam', 'Ortiz'], ['Ana', 'Diaz']]) {
      for (const passcode of [PASSCODE, WRONG]) assert.deepEqual(await signInCheck(company.code, first, last, passcode), { status: 'use_email' });
    }
    // Taken off the roster, an email account's row finds nobody: its owner signs in with email anyway.
    await takeOff(company, 'Lee Park');
    assert.deepEqual(await db.adminRows('select user_id from public.crew_logins where user_id = $1', [lee]), []);
    assert.deepEqual(await signInCheck(company.code, 'Lee', 'Park'), { status: 'no_account' });
    // So it stands in nobody's way: someone new of that name signs up, and waits for a supervisor.
    assert.equal((await signUpCheck(company.code, 'Lee', 'Park')).status, 'ok');
    const newcomer = await crewMember(company, 'Lee', 'Park');
    assert.deepEqual(newcomer.joined, { status: 'pending', company_name: 'Test Pit A', reason: 'not_on_roster' });
    const waiting = { status: 'ok', company_id: company.id, company_name: 'Test Pit A', waiting: true };
    assert.deepEqual(await signedIn(await signInCheck(company.code, 'Lee', 'Park'), newcomer.account), waiting);
  });

  it('a wrong try made through the sign-in check stays counted, so five lock the account', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    // Each check is a request of its own, committed as it answers.
    for (const left of [4, 3, 2, 1]) assert.deepEqual(await signInCheck(company.code, 'Riley', 'Quinn', WRONG), { status: 'wrong', tries_left: left });
    assert.equal((await countsOf(riley.account)).wrong_in_a_row, 4);
    const locked = await signInCheck(company.code, 'Riley', 'Quinn', WRONG);
    assert.deepEqual(Object.keys(locked).sort(), ['status', 'until']);
    assert.equal(locked.status, 'locked');
    const ahead = Date.parse(locked.until) - Date.now();
    assert.ok(ahead > 14 * MINUTE && ahead <= 15 * MINUTE + 1000, `locked for ${Math.round(ahead / 1000)} s more`);
    // The right passcode is locked out too, and counted nowhere.
    assert.equal((await signInCheck(company.code, 'Riley', 'Quinn', PASSCODE)).status, 'locked');
    assert.equal((await countsOf(riley.account)).wrong_in_a_row, 5);
  });
});

describe('crew_confirm_check', () => {
  it("confirms the passcode of the account signed in on the phone, with its login, and counts a wrong one", async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const ok = await confirmCheck(riley.account, PASSCODE);
    assert.deepEqual(Object.keys(ok).sort(), ['login_email', 'login_password', 'status']);
    assert.deepEqual(await signedIn(ok, riley.account), { status: 'ok' });
    assert.deepEqual(await confirmCheck(riley.account, WRONG), { status: 'wrong', tries_left: 4 });
    assert.equal((await countsOf(riley.account)).wrong_in_a_row, 1);
    // Found by the account, not by a code or a name: both can change, and the phone keeps neither.
    await db.as(company.owner).query("update public.roster set first_name = 'Riley J.', active = false where id = $1", [company.rows['Riley J Quinn']]);
    await db.as(company.owner).call('rotate_join_code', { company_id: company.id });
    assert.deepEqual(await signedIn(await confirmCheck(riley.account, PASSCODE), riley.account), { status: 'ok' });
    // Locked, the right passcode is turned away.
    for (let i = 0; i < 4; i += 1) await confirmCheck(riley.account, WRONG);
    assert.equal((await confirmCheck(riley.account, WRONG)).status, 'locked');
    assert.equal((await confirmCheck(riley.account, PASSCODE)).status, 'locked');
    // An email account keeps no passcode, nor does an account nobody made.
    assert.deepEqual(await confirmCheck(company.owner, PASSCODE), { status: 'no_account' });
    assert.deepEqual(await confirmCheck(nobody(), PASSCODE), { status: 'no_account' });
  });
});

describe('who may call them', () => {
  it('anonymous callers can no longer look up a company by code; signed-in ones still can', async () => {
    const company = await startCompany(db, { name: 'Test Pit A', state: 'NV' });
    await refused(db.anon().callRows('company_by_code', { code: company.code }), NO_PRIVILEGE, /permission denied for function company_by_code/);
    const signedInCaller = db.as(await db.newAccount('visitor'));
    assert.deepEqual(await signedInCaller.callRows('company_by_code', { code: company.code }), [{ name: 'Test Pit A', state: 'NV' }]);
    // The app looks a code up through crew-auth instead, under its limit.
    assert.deepEqual(await lookup(company.code), { status: 'company', name: 'Test Pit A', state: 'NV' });
  });

  it('only the server key calls the checks, no API role reads the tries, and the checks run where they can write', async () => {
    const company = await startCompany(db);
    const visitor = await db.newAccount('visitor');
    const calls = {
      crew_lookup: { p_code: company.code, p_address: anyAddress() },
      crew_sign_up_check: { p_code: company.code, p_first: 'Pat', p_last: 'Cole', p_passcode: PASSCODE, p_address: anyAddress() },
      crew_sign_in_check: { p_code: company.code, p_first: 'Pat', p_last: 'Cole', p_passcode: PASSCODE, p_address: anyAddress() },
      crew_confirm_check: { p_user: visitor, p_passcode: PASSCODE },
    };
    for (const session of [db.anon(), db.as(visitor), db.noAccount()]) {
      for (const [fn, args] of Object.entries(calls)) await refused(session.call(fn, args), NO_PRIVILEGE, new RegExp(`permission denied for function ${fn}`));
    }
    for (const session of [db.anon(), db.as(visitor), db.noAccount(), db.serviceRole()]) {
      await refused(session.query('select * from public.crew_sign_in_tries'), NO_PRIVILEGE, /permission denied for table crew_sign_in_tries/);
      await refused(session.query('delete from public.crew_sign_in_tries'), NO_PRIVILEGE, /permission denied/);
    }
    // The helpers they share are for them alone.
    for (const session of [db.anon(), db.as(visitor), db.serviceRole()]) {
      await refused(session.call('crew_try_counted', { p_address: anyAddress() }), NO_PRIVILEGE, /permission denied for function crew_try_counted/);
      await refused(session.call('crew_find_person', { p_company: company.id, p_first: 'Pat', p_last: 'Cole' }), NO_PRIVILEGE, /permission denied for function crew_find_person/);
    }
    // A check counts a try, and a wrong passcode, as it answers: volatile, so PostgREST runs it by POST, in
    // a transaction that can write, never by GET in a read-only one.
    const writers = [...CHECKS, 'crew_try_counted'];
    const kinds = await db.adminRows('select proname, provolatile from pg_proc where proname = any ($1)', [writers]);
    assert.deepEqual(kinds.map((kind) => kind.proname).sort(), [...writers].sort());
    for (const kind of kinds) assert.equal(kind.provolatile, 'v', `${kind.proname} is volatile`);
  });
});
