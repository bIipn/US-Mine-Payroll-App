// Crew passcodes (migration 20261122000100). A crew member's passcode is kept only as a digest made
// with a key of the server's own and a salt of the account's own, in tables no API role can read. The
// server's copy of the passcode rule gives the app's answer (src/domain/passcode.ts) for every string.
// Wrong tries are counted on the account's row, under its row lock: 5 wrong in a row lock the account
// for 15 minutes and 10 until a supervisor's reset code, the right passcode included, and the right
// passcode clears the count. The server key keeps a passcode (crew_keep_passcode). Checking one
// (crew_check_passcode), the rule (crew_passcode_problem) and the sign-in password
// (crew_login_password) are for the sign-in functions inside the database: no API role calls them.
//
// The passcodes, accounts and addresses here are made up. No test message names a passcode, a key or
// a digest: the tests assert on them.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { EASY_PASSCODES, passcodeProblem } from '../../src/domain/passcode.ts';
import { BAD_INPUT, NO_PRIVILEGE, nobody, refused, startDatabase } from './harness.mjs';

// One that passes the rule, a wrong one, and another that passes it.
const PASSCODE = '583920';
const WRONG = '583921';
const OTHER = '904712';

const TABLES = ['crew_logins', 'crew_key'];
const API_ROLES = ['anon', 'authenticated', 'service_role'];
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const MINUTE = 60 * 1000;

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

/** The server key keeps a passcode for an account, as the crew-auth function will. */
const keep = (user, passcode) => db.serviceRole().call('crew_keep_passcode', { p_user: user, p_passcode: passcode });

/** A new account with a passcode kept for it. */
async function crewAccount(passcode = PASSCODE) {
  const user = await db.newAccount('crew');
  await keep(user, passcode);
  return user;
}

/** A passcode checked for an account, as the sign-in functions check it: in the database, as its owner. */
async function check(user, passcode) {
  const [{ answer }] = await db.adminRows('select public.crew_check_passcode($1, $2) as answer', [user, passcode]);
  return answer;
}

/** The account's count and lock, as kept. */
async function counts(user) {
  const [row] = await db.adminRows('select wrong_in_a_row, locked_until from public.crew_logins where user_id = $1', [user]);
  return row;
}

/** The 15 minutes go by: the lock's end moved into the past, as the owner can in the SQL editor. */
const moveTheClock = (user, by = '1 second') =>
  db.admin('update public.crew_logins set locked_until = now() - $2::interval where user_id = $1', [user, by]);

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((part) => Buffer.from(part)))).digest();

/** A pseudo-random sequence from a seed (mulberry32), so the random strings are the same each run. */
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * About 300 strings for the rule: the common list, every pattern at each length from 4 to 14 digits,
 * near misses, random digits, and letters, spaces, signs and the digits of other scripts.
 */
function passcodeCorpus() {
  const strings = new Set(['', '12341234', '332211', '583920583920', ...EASY_PASSCODES]);
  const up = '0123456789';
  const down = '9876543210';
  for (let length = 4; length <= 14; length += 1) {
    // Every digit the same.
    for (const digit of '0179') strings.add(digit.repeat(length));
    // A run up or down, from its first digit and from its last.
    if (length <= 10) for (const run of [up, down]) strings.add(run.slice(0, length)).add(run.slice(10 - length));
    // One block repeated, of each size from 2 up to half the length that divides it.
    for (let size = 2; size * 2 <= length; size += 1) if (length % size === 0) strings.add('5839207146'.slice(0, size).repeat(length / size));
    // Doubled digits counting up and down.
    if (length % 2 === 0) for (const run of [up, down]) strings.add([...run.slice(0, length / 2)].map((digit) => digit + digit).join(''));
    // A palindrome.
    const half = '5839207146'.slice(0, Math.ceil(length / 2));
    strings.add(half + [...half.slice(0, Math.floor(length / 2))].reverse().join(''));
  }
  // Near misses: a run with one digit off or wrapping round, a block that does not fill the length,
  // doubled digits that do not count by one, an odd number of doubled digits, a palindrome but one.
  for (const near of ['123457', '890123', '210987', '1231231', '12312312', '58375838', '889900', '113355', '112244', '1122334', '123320', '58392058392']) {
    strings.add(near);
  }
  const random = seeded(20261122);
  for (let i = 0; i < 150; i += 1) strings.add(Array.from({ length: 4 + (i % 11) }, () => Math.floor(random() * 10)).join(''));
  for (const other of [
    '58392a', 'a58392', 'abcdef', 'ABCDEF1234', 'passcode', '111O11', '583 920', ' 583920', '583920 ', ' ', '583920\n', '58\t3920',
    ' 583920', '-58392', '+583920', '5839.20', '583,920', '0x5839', '1e6', '５８３９２０',
    '٥٨٣٩٢٠', '५८४९२०', '58392٠', '583920\u{1F6A7}', 'é583920',
  ]) {
    strings.add(other);
  }
  return [...strings];
}

describe('crew_logins and crew_key', () => {
  it('no API role can read crew_logins or crew_key', async () => {
    await crewAccount();
    for (const session of [db.anon(), db.as(await db.newAccount('visitor')), db.noAccount(), db.serviceRole()]) {
      for (const table of TABLES) {
        await refused(session.query(`select * from public.${table}`), NO_PRIVILEGE, new RegExp(`permission denied for table ${table}`));
        await refused(session.query(`delete from public.${table}`), NO_PRIVILEGE, /permission denied/);
      }
    }
    // Nor is any of them granted anything on them, down to the column, and row level security is on.
    for (const role of API_ROLES) {
      for (const table of TABLES) {
        for (const privilege of TABLE_PRIVILEGES) {
          const [{ has }] = await db.adminRows('select has_table_privilege($1, $2, $3) as has', [role, `public.${table}`, privilege]);
          assert.equal(has, false, `${role} ${privilege} on ${table}`);
        }
        const [{ any }] = await db.adminRows("select has_any_column_privilege($1, $2, 'SELECT, INSERT, UPDATE, REFERENCES') as any", [role, `public.${table}`]);
        assert.equal(any, false, `${role} has a column privilege on ${table}`);
      }
    }
    const security = await db.adminRows(
      "select relname, relrowsecurity from pg_class where oid in ('public.crew_logins'::regclass, 'public.crew_key'::regclass) order by relname",
    );
    assert.deepEqual(security, [{ relname: 'crew_key', relrowsecurity: true }, { relname: 'crew_logins', relrowsecurity: true }]);
  });

  it('has one key, made at random, apart from the contact form', async () => {
    const keys = await db.adminRows('select key from public.crew_key');
    assert.equal(keys.length, 1);
    assert.ok(keys[0].key.length >= 64, 'a long key');
    await refused(db.admin("insert into public.crew_key (one, key) values (false, '\\x00')"), '23514');
    const [{ same }] = await db.adminRows('select (select key from public.crew_key) = (select key from public.contact_sender_key) as same');
    assert.equal(same, false, 'not the contact form key');
  });

  it('a login goes with its account', async () => {
    const crew = await crewAccount();
    await db.admin('delete from auth.users where id = $1', [crew]);
    assert.deepEqual(await db.adminRows('select user_id from public.crew_logins where user_id = $1', [crew]), []);
  });
});

describe('crew_passcode_problem', () => {
  it('the server and the app refuse the same passcodes', async () => {
    const strings = passcodeCorpus();
    assert.ok(strings.length >= 280 && strings.length <= 340, `${strings.length} strings`);
    const rows = await db.adminRows(
      'select public.crew_passcode_problem(t.p) as problem from pg_catalog.jsonb_array_elements_text($1::jsonb) with ordinality as t(p, i) order by t.i',
      [JSON.stringify(strings)],
    );
    assert.equal(rows.length, strings.length);
    const app = strings.map((passcode) => passcodeProblem(passcode));
    const differ = strings.filter((_, i) => rows[i].problem !== app[i]).length;
    assert.equal(differ, 0, `${differ} of ${strings.length} strings get another answer from the server than from the app`);
    // Every answer is in the corpus, many times.
    const answers = {};
    for (const problem of app) answers[problem ?? 'none'] = (answers[problem ?? 'none'] ?? 0) + 1;
    for (const answer of ['none', 'not_digits', 'too_short', 'too_long', 'easy']) {
      assert.ok((answers[answer] ?? 0) >= 15, `only ${answers[answer] ?? 0} strings answer ${answer}`);
    }
    // And the server's list of common passcodes is the app's, entry for entry.
    const [{ def }] = await db.adminRows("select pg_get_functiondef('public.crew_passcode_problem'::regproc) as def");
    const listed = [...def.matchAll(/'(\d{6})'/g)].map((m) => m[1]).sort();
    const easy = [...EASY_PASSCODES].sort();
    assert.equal(listed.length, easy.length, 'as many common passcodes on the server as in the app');
    assert.ok(listed.every((passcode, i) => passcode === easy[i]), 'the same common passcodes');
  });
});

describe('crew_keep_passcode', () => {
  it('keeps a passcode as a salted digest, never as typed', async () => {
    const one = await crewAccount(PASSCODE);
    const two = await crewAccount(PASSCODE);
    const [{ key }] = await db.adminRows('select key from public.crew_key');
    const rows = await db.adminRows('select salt, digest from public.crew_logins where user_id = any ($1::uuid[])', [[one, two]]);
    assert.equal(rows.length, 2);
    const typed = Buffer.from(PASSCODE, 'utf8');
    for (const row of rows) {
      const salt = Buffer.from(row.salt);
      const digest = Buffer.from(row.digest);
      assert.equal(salt.length, 16);
      assert.equal(digest.length, 32);
      assert.ok(!digest.includes(typed) && !salt.includes(typed), 'the passcode as typed is not kept');
      assert.ok(!digest.equals(sha256(typed)), 'not a plain hash, which anyone could work out');
      assert.ok(!digest.equals(sha256(salt, typed)), 'nor a salted one without the key');
      assert.ok(digest.equals(sha256(key, salt, typed)), 'sha256 of the key, the salt and the passcode');
    }
    assert.ok(!Buffer.from(rows[0].salt).equals(Buffer.from(rows[1].salt)), 'each account has a salt of its own');
    assert.ok(!Buffer.from(rows[0].digest).equals(Buffer.from(rows[1].digest)), 'one passcode, two digests');
  });

  it('refuses a passcode the app refuses, with the problem as the hint, and only the server key keeps one', async () => {
    const crew = await db.newAccount('crew');
    for (const passcode of ['58392a', '', '58392', '5839205839201', '123456', '112233', '12341234']) {
      const error = await refused(keep(crew, passcode), BAD_INPUT);
      assert.equal(error.hint, passcodeProblem(passcode));
    }
    assert.equal((await refused(keep(crew, null), BAD_INPUT)).hint, 'not_digits');
    assert.deepEqual(await db.adminRows('select user_id from public.crew_logins where user_id = $1', [crew]), []);
    for (const session of [db.anon(), db.as(crew), db.noAccount()]) {
      await refused(session.call('crew_keep_passcode', { p_user: crew, p_passcode: PASSCODE }), NO_PRIVILEGE, /permission denied for function crew_keep_passcode/);
    }
    // No API role checks a passcode, asks the rule or works out a sign-in password: the sign-in functions do.
    for (const session of [db.anon(), db.as(crew), db.serviceRole()]) {
      await refused(session.call('crew_check_passcode', { p_user: crew, p_passcode: PASSCODE }), NO_PRIVILEGE, /permission denied for function crew_check_passcode/);
      await refused(session.call('crew_passcode_problem', { passcode: PASSCODE }), NO_PRIVILEGE, /permission denied for function crew_passcode_problem/);
      await refused(session.call('crew_login_password', { email: 'crew-0@crew.minemuster.com' }), NO_PRIVILEGE, /permission denied for function crew_login_password/);
    }
  });
});

describe('crew_check_passcode', () => {
  it('a right passcode clears the count', async () => {
    const crew = await crewAccount();
    for (const left of [4, 3, 2]) assert.deepEqual(await check(crew, WRONG), { status: 'wrong', tries_left: left });
    assert.equal((await counts(crew)).wrong_in_a_row, 3);
    assert.deepEqual(await check(crew, PASSCODE), { status: 'ok' });
    assert.deepEqual(await counts(crew), { wrong_in_a_row: 0, locked_until: null });
    // The next wrong one counts from the start again.
    assert.deepEqual(await check(crew, WRONG), { status: 'wrong', tries_left: 4 });
  });

  it('five wrong in a row lock for 15 minutes, even against the right passcode', async () => {
    const crew = await crewAccount();
    for (let i = 0; i < 5; i += 1) await check(crew, WRONG);
    const locked = await check(crew, PASSCODE);
    assert.equal(locked.status, 'locked');
    const ahead = Date.parse(locked.until) - Date.now();
    assert.ok(ahead > 14 * MINUTE && ahead <= 15 * MINUTE + 1000, `locked for ${Math.round(ahead / 1000)} s more`);
    // While it is locked nothing is compared, and nothing is counted.
    assert.equal((await check(crew, WRONG)).status, 'locked');
    assert.equal((await counts(crew)).wrong_in_a_row, 5);
    await moveTheClock(crew);
    assert.deepEqual(await check(crew, PASSCODE), { status: 'ok' });
    assert.deepEqual(await counts(crew), { wrong_in_a_row: 0, locked_until: null });
  });

  it('ten wrong in a row lock until a reset', async () => {
    const crew = await crewAccount();
    for (let i = 0; i < 5; i += 1) await check(crew, WRONG);
    await moveTheClock(crew);
    for (let i = 0; i < 4; i += 1) await check(crew, WRONG);
    assert.deepEqual(await check(crew, WRONG), { status: 'locked', until: null });
    assert.deepEqual(await check(crew, PASSCODE), { status: 'locked', until: null });
    await moveTheClock(crew, '1 day');
    assert.deepEqual(await check(crew, PASSCODE), { status: 'locked', until: null });
    assert.equal((await counts(crew)).wrong_in_a_row, 10);
    // A new passcode kept for the account, as a reset keeps one, opens it, and the old one is wrong.
    await keep(crew, OTHER);
    assert.deepEqual(await counts(crew), { wrong_in_a_row: 0, locked_until: null });
    assert.deepEqual(await check(crew, OTHER), { status: 'ok' });
    assert.deepEqual(await check(crew, PASSCODE), { status: 'wrong', tries_left: 4 });
  });

  it('tries left count down from 5, then from 10', async () => {
    const crew = await crewAccount();
    const first = [];
    for (let i = 0; i < 5; i += 1) first.push(await check(crew, WRONG));
    assert.deepEqual(first.slice(0, 4), [4, 3, 2, 1].map((left) => ({ status: 'wrong', tries_left: left })));
    assert.equal(first[4].status, 'locked');
    assert.notEqual(first[4].until, null);
    await moveTheClock(crew);
    const then = [];
    for (let i = 0; i < 5; i += 1) then.push(await check(crew, WRONG));
    assert.deepEqual(then, [...[4, 3, 2, 1].map((left) => ({ status: 'wrong', tries_left: left })), { status: 'locked', until: null }]);
  });

  it('guesses sent together are each counted', async () => {
    const crew = await crewAccount();
    const answers = await Promise.all(Array.from({ length: 5 }, () => check(crew, WRONG)));
    assert.deepEqual(answers.map((answer) => answer.status).sort(), ['locked', 'wrong', 'wrong', 'wrong', 'wrong']);
    assert.deepEqual(answers.filter((answer) => answer.status === 'wrong').map((answer) => answer.tries_left).sort(), [1, 2, 3, 4]);
    assert.equal((await counts(crew)).wrong_in_a_row, 5);
    assert.equal((await check(crew, PASSCODE)).status, 'locked');
  });

  it("the check takes the account's row lock", async () => {
    const [{ def }] = await db.adminRows("select pg_get_functiondef('public.crew_check_passcode'::regproc) as def");
    const body = def.replace(/--[^\n]*/g, ' ');
    // The first statement that names the account's row reads it for update, so a guess sent at the
    // same time waits for this one to commit, and then reads the count this one left.
    const first = body.search(/\bpublic\.crew_logins\b/i);
    assert.ok(first > 0, 'it reads the account');
    const end = body.indexOf(';', first);
    const statement = body.slice(body.lastIndexOf(';', first) + 1, end).replace(/\s+/g, ' ');
    assert.match(statement, /\bselect\b.*\bwrong_in_a_row\b.*\bfrom public\.crew_logins\b.*\bwhere\b.*\buser_id = p_user\b.*\bfor update\s*$/i, 'the first read of the account takes its row lock');
    assert.equal([...body.matchAll(/\bfrom\s+public\.crew_logins\b/gi)].length, 1, 'and it is the only read of it');
    assert.ok(body.search(/\bupdate\s+public\.crew_logins\b/i) > end, 'the counts are written after the row is locked');
  });

  it('answers no_account for an account with no passcode kept, and counts nothing', async () => {
    const email = await db.newAccount('email');
    assert.deepEqual(await check(email, PASSCODE), { status: 'no_account' });
    assert.deepEqual(await check(nobody(), PASSCODE), { status: 'no_account' });
    assert.deepEqual(await db.adminRows('select user_id from public.crew_logins where user_id = $1', [email]), []);
  });
});

describe('crew_login_password', () => {
  it('works out the sign-in password from the hidden address and the key', async () => {
    const address = 'crew-0123456789abcdef0123456789abcdef@crew.minemuster.com';
    const password = async (email) => (await db.adminRows('select public.crew_login_password($1) as password', [email]))[0].password;
    const [{ key }] = await db.adminRows('select key from public.crew_key');
    const made = await password(address);
    assert.ok(made === sha256(key, `login:${address}`).toString('base64'), 'base64 of sha256(key || login: || the address)');
    assert.equal(made.length, 44);
    assert.ok((await password(address.toUpperCase())) === made, 'the same whatever its capitals');
    assert.ok((await password(address.replace('crew-0123', 'crew-3210'))) !== made, 'another address, another password');
    assert.ok(made !== sha256(`login:${address}`).toString('base64'), 'not a plain hash, which anyone could work out');
  });
});
