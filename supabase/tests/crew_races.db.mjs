// Crew sign-in, its passcodes and reset codes, and the supervisor invitations (migrations
// 20261122000100 and 20261122000200) when requests overlap, acted out on a real PostgreSQL server
// (see server.mjs; skipped without one). PGlite is one session and cannot overlap two
// transactions, so the PGlite suite checks these functions' locks only by reading them. These are
// the only tests that act them out, at READ COMMITTED, as PostgREST runs:
//
//  * many passcode tries at once on one account, by sign-in and by confirm, from many addresses:
//    each waits for the account's row and counts on from the count the one before left, so none
//    is lost. 5 wrong in a row lock the account for 15 minutes and 10 until a reset, the right
//    passcode included, and a right passcode among them gets the answer its place in line gives;
//  * many requests at once from one address: never more than 30 let through in 10 minutes;
//  * requests from two addresses at once, only one of which deletes the old tries;
//  * two sign-ups for one name: two new passcode accounts claiming one roster row at once. One
//    holds it and the other is told pending, already_claimed, which crew-auth answers
//    already_signed_up; once crew-auth deletes that account nothing of it is left;
//  * one passcode account claiming rows in two companies at once;
//  * an invitation accepted twice at once, and accepted while a supervisor invites someone else
//    onto its row, deletes the row or closes the company;
//  * reset codes: wrong ones at once spend the code after 5 tries in all, and two right ones at
//    once keep one new passcode;
//  * a row made a supervisor's while a passcode account claims it or keeps a passcode, which take
//    the account's lock, and roster writes over several supervisors' rows, which take none;
//  * a reset, which takes the account's lock and then its row, against a sign-in, a confirm and
//    crew_keep_passcode.
//
// Four of them once ended in a deadlock (40P01) where the code meant requests to take turns; each
// says how it came about and what has them take turns now. A third transaction that holds a lock
// for a moment (another write, or the owner in the SQL editor) is used where it lines two requests
// up the same way every run.
//
// All names, passcodes and addresses are made up (the addresses are from the ranges kept for
// documentation). No test message names a passcode, a code, an address or a login.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { skipWithoutServer, startServerDatabase } from './server.mjs';

let db;
before(async () => {
  if (!skipWithoutServer) db = await startServerDatabase();
});
after(async () => {
  await db?.drop();
});

// Passcodes the rule lets through, and one wrong for every account here.
const PASSCODE = '583920';
const WRONG = '583921';
const NEW_A = '904712';
const NEW_B = '671358';

const DEADLOCK = '40P01';

const LOOKUP = 'select public.crew_lookup(p_code => $1, p_address => $2) as answer';
const SIGN_UP = 'select public.crew_sign_up_check(p_code => $1, p_first => $2, p_last => $3, p_passcode => $4, p_address => $5) as answer';
const SIGN_IN = 'select public.crew_sign_in_check(p_code => $1, p_first => $2, p_last => $3, p_passcode => $4, p_address => $5) as answer';
const CONFIRM = 'select public.crew_confirm_check(p_user => $1, p_passcode => $2) as answer';
const RESET = 'select public.crew_reset_check(p_code => $1, p_first => $2, p_last => $3, p_reset_code => $4, p_new_passcode => $5, p_address => $6) as answer';
const KEEP = 'select public.crew_keep_passcode(p_user => $1, p_passcode => $2)';
const JOIN = 'select public.join_company(code => $1, first_name => $2, last_name => $3) as answer';
const INVITE = 'select public.invite_supervisor(p_roster_id => $1, p_email => $2) as answer';
const RESEND = 'select public.resend_supervisor_invitation(p_invitation_id => $1) as answer';
const ACCEPT = 'select public.accept_supervisor_invitation(p_invitation_id => $1) as answer';
const CLOSE = 'select public.close_company(p_company_id => $1, p_company_name => $2)';
const MAKE_SUPERVISOR = "update public.roster set role = 'supervisor' where id = $1";

const SUPERVISOR_NEEDS_EMAIL = 'A supervisor signs in with email, not a passcode.';
const ONE_COMPANY_ONLY = 'A passcode sign-in is for one company only.';
const INVITATION_CLOSED = 'That invitation has expired, or was cancelled or accepted.';
const ROW_TAKEN = 'That roster row is taken off the roster or held by an email sign-in.';
const NO_SUCH_INVITATION = 'No such invitation.';
const SOMEONE_CAN_TAKE_OVER = 'Someone else can take over this company. Make them a supervisor instead.';

let addresses = 0;
/** An address no request has come from yet, so each test's tries are its own. */
const anyAddress = () => `2001:db8:16::${(addresses += 1).toString(16)}`;

/** The server key's request, in a transaction of its own, as crew-auth's calls come through PostgREST. */
const asServer = () => db.request(null, 'read committed', 'service_role');

/** One whole request with the server key, committed: for setting a test up. */
async function serverOnce(sql, params) {
  const request = await asServer();
  try {
    const result = await request.query(sql, params);
    await request.commit();
    return result.rows;
  } finally {
    await request.end();
  }
}

/** Commit a request whose statement went through, or roll it back. A refusal at commit counts as the outcome. */
async function finish(request, outcome) {
  if (!outcome.ok) {
    await request.rollback();
    return outcome;
  }
  try {
    await request.commit();
    return outcome;
  } catch (error) {
    return { ok: false, code: error.code, message: error.message, atCommit: true };
  }
}

/** Whether a request's statement is waiting on a lock now. */
async function waiting(request) {
  const [{ n }] = await db.adminRows("select count(*)::int as n from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [request.pid]);
  return n === 1;
}

/**
 * Requests whose statements have been sent and may wait on each other: each is committed, or rolled
 * back, the moment its statement is through, so the others can go on. Requests that take turns on
 * one lock get through one at a time, so the order they get through in is the order the server took
 * them. Returns that order (each request's place in the list, and its outcome) and the outcomes in
 * the list's own order.
 */
async function throughInTurn(requests, settleds) {
  const left = new Map(settleds.map((settled, at) => [at, settled.then((outcome) => ({ at, outcome }))]));
  const order = [];
  const outcomes = [];
  while (left.size > 0) {
    const { at, outcome } = await Promise.race(left.values());
    left.delete(at);
    outcomes[at] = await finish(requests[at], outcome);
    order.push({ at, outcome: outcomes[at] });
  }
  return { order, outcomes };
}

/**
 * Calls sent all at once, each a request of its own, as PostgREST runs each in a transaction of
 * its own: every one is sent before any commits, and all but the first are checked to be waiting
 * for their turn, so they really did arrive at once. Then each commits the moment it is through.
 * Returns the order the server took them in, each call's place in the list with its outcome.
 */
async function allAtOnce(calls) {
  const requests = [];
  const settleds = [];
  try {
    for (const { open, sql, params } of calls) {
      const request = await open();
      requests.push(request);
      settleds.push((await request.start(sql, params)).settled);
    }
    const [{ n }] = await db.adminRows(
      "select count(*)::int as n from pg_stat_activity where pid = any ($1::int[]) and wait_event_type = 'Lock'",
      [requests.map((request) => request.pid)],
    );
    assert.equal(n, calls.length - 1, 'all but the first wait for their turn');
    return (await throughInTurn(requests, settleds)).order;
  } finally {
    for (const request of requests) await request.end();
  }
}

/** A company its supervisor, Sam Ortiz, has started, with these rows besides: [first, last, role]. */
async function company(name = 'Test Pit A', rows = []) {
  const owner = await db.newAccount();
  const [made] = await db.asAccount(
    owner,
    "select * from public.create_company(name => $1, state => 'CA', timezone => null, first_name => 'Sam', last_name => 'Ortiz')",
    [name],
  );
  const ids = {};
  for (const [first, last, role = 'employee'] of rows) {
    const [row] = await db.asAccount(
      owner,
      'insert into public.roster (company_id, first_name, last_name, role) values ($1, $2, $3, $4) returning id',
      [made.company_id, first, last, role],
    );
    ids[`${first} ${last}`] = row.id;
  }
  const [own] = await db.adminRows('select id from public.roster where user_id = $1', [owner]);
  return { id: made.company_id, code: made.join_code, name, owner, ownRow: own.id, rows: ids };
}

/** A crew member made as crew-auth makes one: an account, its passcode kept with the server key, and the name typed to join. */
async function crewMember(co, first, last, passcode = PASSCODE) {
  const account = await db.newAccount();
  await serverOnce(KEEP, [account, passcode]);
  const [{ answer }] = await db.asAccount(account, JOIN, [co.code, first, last]);
  return { account, joined: answer };
}

/** An email account whose address Supabase Auth has confirmed: its own, or the one given. */
async function confirmedAccount(email = null) {
  const account = await db.newAccount();
  await db.adminRows('update auth.users set email = coalesce($2, email), email_confirmed_at = now() where id = $1', [account, email]);
  return account;
}

const emailOf = async (account) => (await db.adminRows('select email from auth.users where id = $1', [account]))[0].email;
const rowOf = async (id) => (await db.adminRows('select user_id, role from public.roster where id = $1', [id]))[0] ?? null;

/** A passcode account's count and lock, as kept: the lock's end as the checks write it in their answers. */
async function countsOf(account) {
  const [row] = await db.adminRows(
    "select wrong_in_a_row, to_jsonb(locked_until) #>> '{}' as until, (extract(epoch from locked_until - now()) / 60)::float8 as minutes, reset_tries, reset_digest is not null as has_code from public.crew_logins where user_id = $1",
    [account],
  );
  return row;
}

/** Whether a passcode is the one kept for an account, read as the owner: nothing is counted. */
async function passcodeIs(account, passcode) {
  const [{ same }] = await db.adminRows(
    "select l.digest = sha256(k.key || l.salt || convert_to($2, 'UTF8')) as same from public.crew_logins l cross join public.crew_key k where l.user_id = $1",
    [account, passcode],
  );
  return same;
}

/** The 15 minutes go by: the lock's end moved into the past, as the owner can in the SQL editor. */
const moveTheClock = (account) => db.adminRows("update public.crew_logins set locked_until = now() - interval '1 second' where user_id = $1", [account]);

/** A request from a supervisor who typed their password a moment ago, as close_company needs (its amr claim). */
async function withPasswordTyped(account) {
  const request = await db.request(account);
  const claims = { sub: account, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] };
  await request.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  return request;
}

/** Neither outcome a deadlock, saying which one was if one was. */
function noDeadlock(outcomes) {
  for (const [name, outcome] of Object.entries(outcomes)) {
    assert.notEqual(outcome.code, DEADLOCK, `${name} was ended by a deadlock (40P01): ${outcome.message}`);
  }
}

// ---- Passcode tries ------------------------------------------------------------------------------

/**
 * What crew_check_passcode answers to tries taken one at a time, written out from its rules: 5 wrong
 * in a row lock the account for 15 minutes and 10 until a reset, the right passcode included; the
 * right passcode clears the count; a try while the account is locked is neither compared nor
 * counted. `rights` says which tries are the right passcode. Returns the answers, and the count and
 * lock left.
 */
function passcodeRules(rights, { wrong = 0, locked = false } = {}) {
  const answers = rights.map((right) => {
    if (wrong >= 10) return { status: 'locked', until: null };
    if (locked) return { status: 'locked', until: 'the lock' };
    if (right) {
      wrong = 0;
      return { status: 'ok' };
    }
    wrong += 1;
    if (wrong >= 10) return { status: 'locked', until: null };
    if (wrong === 5) {
      locked = true;
      return { status: 'locked', until: 'the lock' };
    }
    return { status: 'wrong', tries_left: (wrong < 5 ? 5 : 10) - wrong };
  });
  return { answers, wrong, locked };
}

/** An answer as passcodeRules writes it: its status, its tries left, and whether it names the lock kept now. */
function plain(answer, lockEnds) {
  if (answer.status === 'wrong') return { status: 'wrong', tries_left: answer.tries_left };
  if (answer.status === 'locked') return { status: 'locked', until: answer.until === null ? null : answer.until === lockEnds ? 'the lock' : answer.until };
  return { status: answer.status };
}

describe('many passcode tries at once on one account', { skip: skipWithoutServer }, () => {
  // crew_check_passcode reads the account's row for update before its counts: a try sent while
  // another holds the row waits for that one to commit, then reads the count it left. So every try
  // is counted, none is lost, and the answers are the rules taken one try at a time, in the order
  // the server took the tries. The sign-in check and the confirm check both call it.

  /** Lee Park, a crew member with a passcode account, in a company of their own. */
  async function leePark() {
    const co = await company('Test Pit A', [['Lee', 'Park']]);
    const { account, joined } = await crewMember(co, 'Lee', 'Park');
    assert.equal(joined.status, 'joined');
    return { co, lee: account };
  }

  const signIn = (co, passcode) => ({ open: asServer, sql: SIGN_IN, params: [co.code, 'Lee', 'Park', passcode, anyAddress()], right: passcode === PASSCODE });
  const confirm = (account, passcode) => ({ open: asServer, sql: CONFIRM, params: [account, passcode], right: passcode === PASSCODE });

  /** Tries sent at once: in the order the server took them, whether each was right and its answer. */
  async function triesAtOnce(tries) {
    const order = await allAtOnce(tries);
    return order.map(({ at, outcome }) => {
      assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
      return { right: tries[at].right, answer: outcome.rows[0].answer };
    });
  }

  it('counts each of 12 wrong ones sent at once by sign-in and confirm: 4 wrong, the 5th locks for 15 minutes, and the rest are told so and count nothing', async () => {
    const { co, lee } = await leePark();
    const tries = Array.from({ length: 12 }, (_, i) => (i % 3 === 2 ? confirm(lee, WRONG) : signIn(co, WRONG)));
    const taken = await triesAtOnce(tries);
    const kept = await countsOf(lee);
    const rules = passcodeRules(taken.map((t) => t.right));
    assert.deepEqual(taken.map((t) => plain(t.answer, kept.until)), rules.answers);
    assert.deepEqual(rules.answers.slice(0, 5), [
      { status: 'wrong', tries_left: 4 },
      { status: 'wrong', tries_left: 3 },
      { status: 'wrong', tries_left: 2 },
      { status: 'wrong', tries_left: 1 },
      { status: 'locked', until: 'the lock' },
    ]);
    assert.equal(kept.wrong_in_a_row, 5);
    assert.ok(kept.minutes > 14.9 && kept.minutes <= 15, `the lock ends ${kept.minutes} minutes from now`);
  });

  it('counts on from 5 once the 15 minutes have gone by: the 10th of them locks the account until a reset, and then the right passcode is locked out too', async () => {
    const { co, lee } = await leePark();
    await triesAtOnce(Array.from({ length: 5 }, () => signIn(co, WRONG)));
    await moveTheClock(lee);
    const taken = await triesAtOnce(Array.from({ length: 7 }, (_, i) => (i % 2 ? confirm(lee, WRONG) : signIn(co, WRONG))));
    const kept = await countsOf(lee);
    assert.deepEqual(taken.map((t) => plain(t.answer, kept.until)), passcodeRules(taken.map((t) => t.right), { wrong: 5 }).answers);
    assert.equal(kept.wrong_in_a_row, 10);
    assert.equal(kept.until, null);
    const [{ answer }] = await serverOnce(SIGN_IN, [co.code, 'Lee', 'Park', PASSCODE, anyAddress()]);
    assert.deepEqual(answer, { status: 'locked', until: null });
    assert.equal((await countsOf(lee)).wrong_in_a_row, 10);
  });

  it('lets the right passcode in when it is sent among 4 wrong ones, wherever it falls in line: ok, clearing the count, and the wrong ones after it count from 0', async () => {
    const { co, lee } = await leePark();
    const tries = [signIn(co, WRONG), signIn(co, WRONG), signIn(co, PASSCODE), confirm(lee, WRONG), signIn(co, WRONG)];
    const taken = await triesAtOnce(tries);
    const kept = await countsOf(lee);
    const rules = passcodeRules(taken.map((t) => t.right));
    assert.deepEqual(taken.map((t) => plain(t.answer, kept.until)), rules.answers);
    assert.deepEqual(taken.find((t) => t.right).answer.status, 'ok');
    assert.equal(kept.wrong_in_a_row, rules.wrong);
    assert.equal(kept.wrong_in_a_row, taken.length - 1 - taken.findIndex((t) => t.right), 'only the wrong ones after it are counted');
    assert.equal(kept.until, null);
  });

  it('locks out the right passcode sent just after the 5th wrong one, by sign-in and confirm alike: neither compared nor counted', async () => {
    const { co, lee } = await leePark();
    await triesAtOnce(Array.from({ length: 4 }, () => signIn(co, WRONG)));
    // The first holds the account's row before the others are sent, so it is the 5th wrong one.
    const taken = await triesAtOnce([signIn(co, WRONG), signIn(co, PASSCODE), confirm(lee, PASSCODE), signIn(co, WRONG)]);
    const kept = await countsOf(lee);
    assert.deepEqual(taken.map((t) => plain(t.answer, kept.until)), passcodeRules(taken.map((t) => t.right), { wrong: 4 }).answers);
    assert.deepEqual(taken.map((t) => t.answer.status), ['locked', 'locked', 'locked', 'locked']);
    assert.equal(kept.wrong_in_a_row, 5);
  });
});

// ---- The limit for one address ---------------------------------------------------------------------

/** How many tries are kept for an address, read as the owner. */
async function triesFrom(address) {
  const [{ n }] = await db.adminRows(
    "select count(*)::int as n from public.crew_sign_in_tries t cross join public.crew_key k where t.sender = sha256(k.key || convert_to(coalesce(lower(btrim($1)), ''), 'UTF8'))",
    [address],
  );
  return n;
}

describe('many requests at once from one address', { skip: skipWithoutServer }, () => {
  // crew_try_counted takes the address's lock before it counts, so requests from one address take
  // turns from the count to the commit, and each counts what the ones before it kept: never more
  // than 30 are let through in 10 minutes. A request turned away is not counted.
  it('let 30 of 34 through, turn the last 4 away, and keep 30 tries', async () => {
    const co = await company('Test Pit A');
    const address = anyAddress();
    const order = await allAtOnce(Array.from({ length: 34 }, () => ({ open: asServer, sql: LOOKUP, params: [co.code, address] })));
    const statuses = order.map(({ outcome }) => {
      assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
      return outcome.rows[0].answer.status;
    });
    assert.deepEqual(statuses, [...Array(30).fill('company'), ...Array(4).fill('busy')]);
    assert.equal(await triesFrom(address), 30);
  });
});

// ---- Two addresses deleting the same old tries --------------------------------------------------------

describe('requests from two addresses deleting the same old tries at once', { skip: skipWithoutServer }, () => {
  // A request deletes every try older than 10 minutes, whoever sent it, only when it gets the prune's
  // own lock, one for every address, which it tries for and never waits for. While one request is
  // deleting, a request from another address passes the old tries by: it is counted and let through
  // at once, and leaves them to the one at it. Its count reads only the last 10 minutes, so passing
  // them by changes no answer. Two deletes never run at once, so they never meet, whatever order
  // each would read the table in.
  const OLD = 200;
  const PRUNE = "explain delete from public.crew_sign_in_tries t where t.at <= now() - interval '10 minutes'";

  /** The plan of the delete, with these settings, read as the owner. */
  async function planOfThePrune(settings = null) {
    const owner = await db.asOwner();
    try {
      if (settings) await owner.query(settings);
      return (await owner.query(PRUNE)).rows.map((row) => row['QUERY PLAN']).join('\n');
    } finally {
      await owner.rollback();
      await owner.end();
    }
  }

  /** 200 tries of long ago, each older than the one before it, from as many addresses. */
  const oldTries = (batch) =>
    db.adminRows(
      "insert into public.crew_sign_in_tries (sender, at) select sha256(convert_to($1 || ' ' || g, 'UTF8')), now() - interval '20 minutes' - g * interval '1 second' from generate_series(1, $2::int) g",
      [batch, OLD],
    );
  /** The owner holds the 100th of a batch, the one in the middle, as a moment's delay would. */
  async function holdTheMiddle(batch) {
    const holder = await db.asOwner();
    const { rows } = await holder.query("select 1 from public.crew_sign_in_tries where sender = sha256(convert_to($1 || ' 100', 'UTF8')) for update", [batch]);
    assert.equal(rows.length, 1);
    return holder;
  }
  const oldLeft = async () => (await db.adminRows("select count(*)::int as n from public.crew_sign_in_tries where at <= now() - interval '10 minutes'"))[0].n;

  it('one deletes and the other passes the old tries by: the second is let through at once, and none are left once the first commits', async () => {
    const co = await company('Test Pit A');
    await oldTries('long ago, one after the other');
    const first = await asServer();
    const second = await asServer();
    try {
      assert.equal((await first.query(LOOKUP, [co.code, anyAddress()])).rows[0].answer.status, 'company');
      const { settled } = await second.start(LOOKUP, [co.code, anyAddress()]);
      assert.equal(await waiting(second), false, 'the second waits for nothing: the first holds the prune, so the second passes it by');
      const outcome = await finish(second, await settled);
      assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
      assert.equal(outcome.rows[0].answer.status, 'company');
      await first.commit();
      assert.equal(await oldLeft(), 0);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('the first stopped part way through, on a row a third transaction holds: the second passes the old tries by, and the first deletes them all once the row is let go', async () => {
    const co = await company('Test Pit A');
    const batch = 'long ago, both part way';
    await oldTries(batch);
    const holder = await holdTheMiddle(batch);
    const first = await asServer();
    const second = await asServer();
    try {
      const one = await first.start(LOOKUP, [co.code, anyAddress()]);
      assert.equal(await waiting(first), true, 'the first stops at the row held');
      const two = await second.start(LOOKUP, [co.code, anyAddress()]);
      assert.equal(await waiting(second), false, 'the second waits for nothing: it passes the prune by');
      const passed = await finish(second, await two.settled);
      assert.equal(passed.ok, true, `${passed.code} ${passed.message}`);
      assert.equal(passed.rows[0].answer.status, 'company');
      await holder.rollback();
      const outcome = await finish(first, await one.settled);
      noDeadlock({ 'the first request': outcome, 'the second request': passed });
      assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
      assert.equal(outcome.rows[0].answer.status, 'company');
      assert.equal(await oldLeft(), 0);
    } finally {
      await holder.end();
      await first.end();
      await second.end();
    }
  });

  it('do not deadlock when the two would delete the old rows in opposite orders: only one deletes', async () => {
    // Before the prune's lock, two requests from two addresses each deleted the old tries under their
    // own address's lock alone, and two deletes that met from opposite ends deadlocked (40P01), one
    // request failing before any passcode was checked. Here the orders are set with planner settings;
    // PostgreSQL itself can scan a large table from another row (a synchronized scan of a table over
    // a quarter of shared_buffers).
    const co = await company('Test Pit A');
    const batch = 'long ago, from both ends';
    await oldTries(batch);
    // The first reads the table from its start; the second would go by the index on at, oldest
    // first, so from the other end, as the tries were written newest first.
    const orders = {
      fromTheStart: 'set local enable_indexscan = off; set local enable_bitmapscan = off',
      oldestFirst: 'set local enable_seqscan = off; set local enable_bitmapscan = off',
    };
    assert.match(await planOfThePrune(orders.fromTheStart), /Seq Scan on crew_sign_in_tries/);
    assert.match(await planOfThePrune(orders.oldestFirst), /Index Scan using crew_sign_in_tries_at_idx/);
    const holder = await holdTheMiddle(batch);
    const first = await asServer();
    const second = await asServer();
    try {
      await first.query(orders.fromTheStart);
      await second.query(orders.oldestFirst);
      const one = await first.start(LOOKUP, [co.code, anyAddress()]);
      assert.equal(await waiting(first), true, 'the first stops at the row held, having deleted the newer half');
      const two = await second.start(LOOKUP, [co.code, anyAddress()]);
      // Noted, and asked once both are through: a deadlock, if there is one, is the first thing said.
      const secondWaited = await waiting(second);
      await holder.rollback();
      const { outcomes } = await throughInTurn([first, second], [one.settled, two.settled]);
      noDeadlock({ 'the request reading from the start': outcomes[0], 'the request reading oldest first': outcomes[1] });
      for (const outcome of outcomes) {
        assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
        assert.equal(outcome.rows[0].answer.status, 'company');
      }
      assert.equal(secondWaited, false, 'the second passed the prune by, so it never met the first');
      assert.equal(await oldLeft(), 0);
    } finally {
      await holder.end();
      await first.end();
      await second.end();
    }
  });
});

// ---- Two sign-ups for one name ------------------------------------------------------------------------

describe('two sign-ups for one name at once', { skip: skipWithoutServer }, () => {
  // crew-auth's sign-up asks crew_sign_up_check, which makes nothing, then makes the account, keeps
  // its passcode and joins as the new account, each a request of its own. Two sign-ups for one name
  // both pass the check before either has joined. The two new accounts then claim the one row at
  // once: join_company locks the row, so the second waits, finds the row held when the first
  // commits, and is told pending, already_claimed. crew-auth answers that already_signed_up and
  // deletes the account it made, and nothing of it is left.
  it('leave the row to one account, the other told already_claimed, with no deadlock and nothing of it left once deleted', async () => {
    const co = await company('Test Pit A', [['Lee', 'Park']]);
    const accounts = [];
    for (let i = 0; i < 2; i += 1) {
      const [{ answer }] = await serverOnce(SIGN_UP, [co.code, 'Lee', 'Park', PASSCODE, anyAddress()]);
      assert.equal(answer.status, 'ok', 'neither has joined yet, so both may sign up');
      const account = await db.newAccount();
      await serverOnce(KEEP, [account, PASSCODE]);
      accounts.push(account);
    }
    const [one, two] = accounts;
    const first = await db.request(one);
    const second = await db.request(two);
    let outcome;
    try {
      assert.equal((await first.query(JOIN, [co.code, 'Lee', 'Park'])).rows[0].answer.status, 'joined');
      const { settled } = await second.start(JOIN, [co.code, 'Lee', 'Park']);
      assert.equal(await waiting(second), true, 'the second claim waits for the row');
      await first.commit();
      outcome = await finish(second, await settled);
    } finally {
      await first.end();
      await second.end();
    }
    assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    assert.deepEqual(outcome.rows[0].answer, { status: 'pending', company_name: 'Test Pit A', reason: 'already_claimed' });
    assert.deepEqual(await rowOf(co.rows['Lee Park']), { user_id: one, role: 'employee' });
    assert.deepEqual(await db.adminRows('select id from public.roster where user_id = $1', [two]), []);

    // crew-auth deletes the account it made (Supabase Auth's admin delete): nothing of it is left.
    await db.adminRows('delete from auth.users where id = $1', [two]);
    for (const table of ['crew_logins', 'join_requests', 'join_holds']) {
      assert.deepEqual(await db.adminRows(`select 1 from public.${table} where user_id = $1`, [two]), [], `nothing in ${table}`);
    }
    assert.deepEqual(await db.adminRows("select 1 from public.notifications where company_id = $1 and kind = 'join_request'", [co.id]), []);
    // The name is the first account's: another sign-up is told to sign in, and signing in finds it.
    assert.equal((await serverOnce(SIGN_UP, [co.code, 'Lee', 'Park', PASSCODE, anyAddress()]))[0].answer.status, 'already_signed_up');
    const [{ answer: signedIn }] = await serverOnce(SIGN_IN, [co.code, 'Lee', 'Park', PASSCODE, anyAddress()]);
    assert.equal(signedIn.status, 'ok');
    assert.ok(signedIn.login_email === (await emailOf(one)), "the login is the first account's");
  });
});

describe('one passcode account claiming rows in two companies at once', { skip: skipWithoutServer }, () => {
  // A passcode account holds rows in one company only. The roster's write trigger takes the
  // account's lock before it looks for the account's other rows, so two claims at once take turns,
  // and the second sees the first (crew_sign_in.sql's roster_before_write).
  it('is refused the second claim (passcode_account_elsewhere), with no deadlock', async () => {
    const a = await company('Test Pit A', [['Lee', 'Park']]);
    const b = await company('Test Pit B', [['Lee', 'Park']]);
    const lee = await db.newAccount();
    await serverOnce(KEEP, [lee, PASSCODE]);
    const first = await db.request(lee);
    const second = await db.request(lee);
    let outcome;
    try {
      assert.equal((await first.query(JOIN, [a.code, 'Lee', 'Park'])).rows[0].answer.status, 'joined');
      const { settled } = await second.start(JOIN, [b.code, 'Lee', 'Park']);
      assert.equal(await waiting(second), true, "the second claim waits for the account's lock");
      await first.commit();
      outcome = await finish(second, await settled);
    } finally {
      await first.end();
      await second.end();
    }
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'PT409', outcome.message);
    assert.equal(outcome.message, ONE_COMPANY_ONLY);
    assert.deepEqual(await rowOf(a.rows['Lee Park']), { user_id: lee, role: 'employee' });
    assert.deepEqual(await rowOf(b.rows['Lee Park']), { user_id: null, role: 'employee' });
  });
});

// ---- Invitations ---------------------------------------------------------------------------------------

/**
 * Test Pit A with Riley J Quinn's row, held by a passcode account when `held` (a crew member being
 * made a supervisor), and an invitation onto it for an email account whose address is confirmed.
 */
async function invitedRow({ held = false } = {}) {
  const co = await company('Test Pit A', [['Riley J', 'Quinn']]);
  const row = co.rows['Riley J Quinn'];
  const crew = held ? (await crewMember(co, 'Riley J', 'Quinn')).account : null;
  const invitee = await confirmedAccount();
  const email = await emailOf(invitee);
  const [{ answer }] = await db.asAccount(co.owner, INVITE, [row, email]);
  return { co, row, crew, invitee, email, invitation: answer.invitation_id };
}

const invitationOf = async (id) =>
  (await db.adminRows('select accepted_by, cancelled_at is not null as cancelled from public.supervisor_invitations where id = $1', [id]))[0] ?? null;
const openInvitationsOf = async (row) =>
  db.adminRows('select email from public.supervisor_invitations where roster_id = $1 and accepted_at is null and cancelled_at is null', [row]);

/**
 * The first request's statement, held open, then the second's, which is checked to wait for the
 * first; the first commits and the second goes on. Returns the second's outcome.
 */
async function secondWaitsForFirst([firstRequest, firstSql, firstParams], [secondRequest, secondSql, secondParams]) {
  try {
    await firstRequest.query(firstSql, firstParams);
    const { settled } = await secondRequest.start(secondSql, secondParams);
    assert.equal(await waiting(secondRequest), true, 'the second waits for the first');
    await firstRequest.commit();
    return await finish(secondRequest, await settled);
  } finally {
    await firstRequest.end();
    await secondRequest.end();
  }
}

describe('an invitation accepted at the same moment as another change', { skip: skipWithoutServer }, () => {
  // accept_supervisor_invitation takes join_company's lock for the caller, then a share of the
  // company's row, then locks the row, then the invitation, and checks everything under those locks.
  // Inviting, sending again and deleting the row lock the row first too, so each of them and an
  // acceptance take turns on the row, the second sees what the first did, and none waits for a row
  // while it holds an invitation. close_company locks the company's row first, so it and an
  // acceptance take turns on the company's row.

  it('twice by the invited account: the second waits, then is told it was accepted', async () => {
    const { row, invitee, invitation } = await invitedRow();
    const outcome = await secondWaitsForFirst([await db.request(invitee), ACCEPT, [invitation]], [await db.request(invitee), ACCEPT, [invitation]]);
    assert.equal(outcome.code, 'PT409', outcome.message);
    assert.equal(outcome.message, INVITATION_CLOSED);
    assert.deepEqual(await rowOf(row), { user_id: invitee, role: 'supervisor' });
    assert.deepEqual(await invitationOf(invitation), { accepted_by: invitee, cancelled: false });
  });

  it('by two accounts with the invited address at once: one holds the row, and the other is told it was accepted', async () => {
    const { row, invitee, email, invitation } = await invitedRow();
    const twin = await confirmedAccount(email);
    const outcome = await secondWaitsForFirst([await db.request(invitee), ACCEPT, [invitation]], [await db.request(twin), ACCEPT, [invitation]]);
    assert.equal(outcome.code, 'PT409', outcome.message);
    assert.equal(outcome.message, INVITATION_CLOSED);
    assert.deepEqual(await rowOf(row), { user_id: invitee, role: 'supervisor' });
    assert.deepEqual(await db.adminRows('select id from public.roster where user_id = $1', [twin]), []);
  });

  it('while a supervisor invites someone else onto the row, the invitation first: the acceptance waits, then is told it was cancelled', async () => {
    const { co, row, invitee, invitation } = await invitedRow();
    const outcome = await secondWaitsForFirst(
      [await db.request(co.owner), INVITE, [row, 'someone.else@example.test']],
      [await db.request(invitee), ACCEPT, [invitation]],
    );
    assert.equal(outcome.code, 'PT409', outcome.message);
    assert.equal(outcome.message, INVITATION_CLOSED);
    assert.deepEqual(await rowOf(row), { user_id: null, role: 'employee' });
    assert.deepEqual(await openInvitationsOf(row), [{ email: 'someone.else@example.test' }]);
  });

  it('while a supervisor invites someone else onto the row, the acceptance first: the new invitation waits, then is told the row is taken', async () => {
    const { co, row, invitee, invitation } = await invitedRow();
    const outcome = await secondWaitsForFirst(
      [await db.request(invitee), ACCEPT, [invitation]],
      [await db.request(co.owner), INVITE, [row, 'someone.else@example.test']],
    );
    assert.equal(outcome.code, 'PT409', outcome.message);
    assert.equal(outcome.message, ROW_TAKEN);
    assert.deepEqual(await rowOf(row), { user_id: invitee, role: 'supervisor' });
    assert.deepEqual(await openInvitationsOf(row), []);
  });

  it('while the row is deleted, the delete first: the acceptance waits, then finds no invitation', async () => {
    const { co, row, invitee, invitation } = await invitedRow();
    const outcome = await secondWaitsForFirst(
      [await db.request(co.owner), 'delete from public.roster where id = $1', [row]],
      [await db.request(invitee), ACCEPT, [invitation]],
    );
    assert.equal(outcome.code, 'PT404', outcome.message);
    assert.equal(outcome.message, NO_SUCH_INVITATION);
    assert.equal(await rowOf(row), null);
    assert.equal(await invitationOf(invitation), null);
  });

  it('while the row is deleted, the acceptance first: the delete waits, then deletes the row the invitee now holds, and the invitation with it', async () => {
    const { co, row, invitee, invitation } = await invitedRow();
    const outcome = await secondWaitsForFirst(
      [await db.request(invitee), ACCEPT, [invitation]],
      [await db.request(co.owner), 'delete from public.roster where id = $1', [row]],
    );
    assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    assert.equal(await rowOf(row), null);
    assert.equal(await invitationOf(invitation), null);
    assert.deepEqual(await db.adminRows('select kind from public.join_holds where user_id = $1', [invitee]), [{ kind: 'released' }]);
  });

  it('while the company is closed, the closing first: the acceptance waits, then finds no invitation', async () => {
    const { co, invitee, invitation } = await invitedRow();
    const outcome = await secondWaitsForFirst([await withPasswordTyped(co.owner), CLOSE, [co.id, co.name]], [await db.request(invitee), ACCEPT, [invitation]]);
    assert.equal(outcome.code, 'PT404', outcome.message);
    assert.equal(outcome.message, NO_SUCH_INVITATION);
    assert.deepEqual(await db.adminRows('select 1 from public.companies where id = $1', [co.id]), []);
  });

  it('while the company is closed, the acceptance first: the closing waits for the acceptance, then finds the invitee can take over', async () => {
    const { co, row, invitee, invitation } = await invitedRow();
    const outcome = await secondWaitsForFirst([await db.request(invitee), ACCEPT, [invitation]], [await withPasswordTyped(co.owner), CLOSE, [co.id, co.name]]);
    assert.equal(outcome.code, 'PT409', outcome.message);
    assert.equal(outcome.message, SOMEONE_CAN_TAKE_OVER);
    assert.deepEqual(await rowOf(row), { user_id: invitee, role: 'supervisor' });
  });

  it("onto a passcode account's row while the company is closed, both waiting for a supervisor sending the invitation again: no deadlock", async () => {
    // Accepting onto a passcode account's row writes a released hold for that account, and the hold's
    // foreign key takes a share lock on the company's row. close_company locks the company's row for
    // update, then every roster row. Accepting takes its share of the company's row before the roster
    // row, in close_company's order, so neither ever holds the row the other waits for: before that, an
    // acceptance that had the roster row while close_company had the company deadlocked with it
    // (40P01). Here a supervisor sending the invitation again holds the roster row, so the acceptance
    // and the closing line up behind it.
    const { co, row, crew, invitee, invitation } = await invitedRow({ held: true });
    const resending = await db.request(co.owner);
    const accepting = await db.request(invitee);
    const closing = await withPasswordTyped(co.owner);
    try {
      await resending.query(RESEND, [invitation]);
      const accepted = await accepting.start(ACCEPT, [invitation]);
      assert.equal(await waiting(accepting), true, 'the acceptance waits for the row');
      const closed = await closing.start(CLOSE, [co.id, co.name]);
      assert.equal(await waiting(closing), true, 'the closing waits too');
      await resending.commit();
      const { outcomes } = await throughInTurn([accepting, closing], [accepted.settled, closed.settled]);
      noDeadlock({ 'the acceptance': outcomes[0], 'the closing': outcomes[1] });
      assert.equal(outcomes[0].ok, true, `${outcomes[0].code} ${outcomes[0].message}`);
      assert.equal(outcomes[1].message, SOMEONE_CAN_TAKE_OVER);
      assert.deepEqual(await rowOf(row), { user_id: invitee, role: 'supervisor' });
      assert.deepEqual(await db.adminRows('select kind from public.join_holds where user_id = $1', [crew]), [{ kind: 'released' }]);
    } finally {
      await resending.end();
      await accepting.end();
      await closing.end();
    }
  });
});

// ---- Reset codes ------------------------------------------------------------------------------------

/** What crew_reset_check answers to codes taken one at a time, from its rules: a code is good for 5 tries in all, the fifth wrong one spends it, and the right one keeps the new passcode and spends it too. */
function resetRules(rights) {
  let tries = 0;
  let spent = false;
  return rights.map((right) => {
    if (spent || tries >= 5) return { status: 'expired' };
    if (right) {
      spent = true;
      return { status: 'ok' };
    }
    tries += 1;
    return { status: 'bad_reset_code', tries_left: 5 - tries };
  });
}

/** Lee Park, a crew member with a passcode account, and a reset code a supervisor has just made for them. */
async function leeWithACode() {
  const co = await company('Test Pit A', [['Lee', 'Park']]);
  const { account } = await crewMember(co, 'Lee', 'Park');
  const [{ code }] = await db.asAccount(co.owner, 'select public.make_passcode_reset_code(p_roster_id => $1) as code', [co.rows['Lee Park']]);
  return { co, lee: account, code };
}

/** A code that is not the one made: the digits after it, counting round. */
const wrongCode = (code, by) => String((Number(code) + by) % 1000000).padStart(6, '0');

describe('reset codes at once', { skip: skipWithoutServer }, () => {
  // crew_reset_check reads the account's row for update before its code, as crew_check_passcode
  // does: codes sent at once are counted one by one. The right code keeps the new passcode, which
  // spends the code, so only one new passcode is ever kept with it.
  const reset = (co, code, passcode) => ({ open: asServer, sql: RESET, params: [co.code, 'Lee', 'Park', code, passcode, anyAddress()] });

  it('8 wrong ones at once: 5 counted, the fifth spending the code, and the rest, then the right one, told it is spent', async () => {
    const { co, lee, code } = await leeWithACode();
    const order = await allAtOnce(Array.from({ length: 8 }, (_, i) => reset(co, wrongCode(code, i + 1), NEW_A)));
    const answers = order.map(({ outcome }) => {
      assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
      return outcome.rows[0].answer;
    });
    assert.deepEqual(answers, resetRules(Array(8).fill(false)));
    assert.equal((await countsOf(lee)).reset_tries, 5);
    assert.deepEqual((await serverOnce(RESET, [co.code, 'Lee', 'Park', code, NEW_A, anyAddress()]))[0].answer, { status: 'expired' });
    assert.equal(await passcodeIs(lee, PASSCODE), true, 'the passcode is as it was');
  });

  it('two right ones at once keep one new passcode: the first through is ok, and the second is told the code is spent', async () => {
    const { co, lee, code } = await leeWithACode();
    const calls = [reset(co, code, NEW_A), reset(co, code, NEW_B)];
    const order = await allAtOnce(calls);
    for (const { outcome } of order) assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    assert.deepEqual(order.map(({ outcome }) => outcome.rows[0].answer.status), ['ok', 'expired']);
    const kept = order[0].at === 0 ? NEW_A : NEW_B;
    const spent = order[0].at === 0 ? NEW_B : NEW_A;
    assert.equal(await passcodeIs(lee, kept), true, "the first one's new passcode is kept");
    assert.equal(await passcodeIs(lee, spent), false, "the second one's is not");
    const after = await countsOf(lee);
    assert.deepEqual([after.reset_tries, after.has_code, after.wrong_in_a_row], [0, false, 0]);
  });

  it('a right one among wrong ones gets the answer of its place in line', async () => {
    const { co, lee, code } = await leeWithACode();
    const calls = Array.from({ length: 8 }, (_, i) => ({ ...reset(co, i === 3 ? code : wrongCode(code, i + 1), NEW_A), right: i === 3 }));
    const order = await allAtOnce(calls);
    const answers = order.map(({ outcome }) => {
      assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
      const { status, tries_left } = outcome.rows[0].answer;
      return status === 'bad_reset_code' ? { status, tries_left } : { status };
    });
    const rules = resetRules(order.map(({ at }) => calls[at].right));
    assert.deepEqual(answers, rules);
    assert.equal(await passcodeIs(lee, rules.some((answer) => answer.status === 'ok') ? NEW_A : PASSCODE), true);
  });
});

// ---- Supervisors' rows and passcode accounts -----------------------------------------------------------

/** An account that starts a company of its own, under its name: the company and its own row. */
async function startedBy(account, name, [first, last]) {
  const [made] = await db.asAccount(
    account,
    "select * from public.create_company(name => $1, state => 'CA', timezone => null, first_name => $2, last_name => $3)",
    [name, first, last],
  );
  const [own] = await db.adminRows('select id from public.roster where company_id = $1 and user_id = $2', [made.company_id, account]);
  return { id: made.company_id, code: made.join_code, ownRow: own.id };
}

let largeIds = 0;
/** A row id larger than any gen_random_uuid() gives, but for one in 2^32, and a new one each time. */
const largeId = () => `ffffffff-ffff-4fff-bfff-${String((largeIds += 1)).padStart(12, '0')}`;

/**
 * Another account made a supervisor of a company: a supervisor's row with the given id, written as
 * the owner, which the account types its name for and its supervisor approves it onto.
 */
async function madeSupervisor(co, by, account, [first, last], id) {
  await db.adminRows("insert into public.roster (id, company_id, first_name, last_name, role) values ($1, $2, $3, $4, 'supervisor')", [id, co.id, first, last]);
  const [{ answer }] = await db.asAccount(account, JOIN, [co.code, first, last]);
  assert.equal(answer.reason, 'supervisor_row');
  const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and company_id = $2 and status = 'pending'", [account, co.id]);
  await db.asAccount(by, 'select public.approve_join_request(request_id => $1, roster_id => $2)', [request.id, id]);
  return id;
}

describe("a row made a supervisor's while a passcode account claims it or keeps a passcode", { skip: skipWithoutServer }, () => {
  // A passcode account never holds a supervisor's row. The roster's write trigger takes the
  // account's lock for a write that puts an account on a row, or makes a row an account holds a
  // supervisor's, and crew_keep_passcode takes the same lock before it looks at the account's
  // rows: a row for the account and a passcode for it, written at once, take turns, and the second
  // sees what the first wrote. A write that changes neither takes no account's lock.

  it('the row made a supervisor\'s first: the claim waits for the row, then leaves a request (supervisor_row)', async () => {
    const co = await company('Test Pit A', [['Lee', 'Park']]);
    const lee = await db.newAccount();
    await serverOnce(KEEP, [lee, PASSCODE]);
    const outcome = await secondWaitsForFirst([await db.request(co.owner), MAKE_SUPERVISOR, [co.rows['Lee Park']]], [await db.request(lee), JOIN, [co.code, 'Lee', 'Park']]);
    assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    assert.deepEqual(outcome.rows[0].answer, { status: 'pending', company_name: 'Test Pit A', reason: 'supervisor_row' });
    assert.deepEqual(await rowOf(co.rows['Lee Park']), { user_id: null, role: 'supervisor' });
  });

  it('the claim first: making the row a supervisor\'s waits for it, then is refused (supervisor_needs_email)', async () => {
    const co = await company('Test Pit A', [['Lee', 'Park']]);
    const lee = await db.newAccount();
    await serverOnce(KEEP, [lee, PASSCODE]);
    const outcome = await secondWaitsForFirst([await db.request(lee), JOIN, [co.code, 'Lee', 'Park']], [await db.request(co.owner), MAKE_SUPERVISOR, [co.rows['Lee Park']]]);
    assert.equal(outcome.code, 'PT409', outcome.message);
    assert.equal(outcome.message, SUPERVISOR_NEEDS_EMAIL);
    assert.deepEqual(await rowOf(co.rows['Lee Park']), { user_id: lee, role: 'employee' });
  });

  it('a reset keeping a new passcode first: making the row a supervisor\'s waits for the account\'s lock, then is refused', async () => {
    // The other way round the role change is refused at once: the account has a passcode already.
    const { co, lee, code } = await leeWithACode();
    const outcome = await secondWaitsForFirst(
      [await asServer(), RESET, [co.code, 'Lee', 'Park', code, NEW_A, anyAddress()]],
      [await db.request(co.owner), MAKE_SUPERVISOR, [co.rows['Lee Park']]],
    );
    assert.equal(outcome.code, 'PT409', outcome.message);
    assert.equal(outcome.message, SUPERVISOR_NEEDS_EMAIL);
    assert.deepEqual(await rowOf(co.rows['Lee Park']), { user_id: lee, role: 'employee' });
    assert.equal(await passcodeIs(lee, NEW_A), true);
  });

  /** An email account whose request waits: it typed Riley J Quinn, whom the roster does not have. */
  async function waitingRiley() {
    const co = await company('Test Pit A');
    const riley = await db.newAccount();
    const [{ answer }] = await db.asAccount(riley, JOIN, [co.code, 'Riley J', 'Quinn']);
    assert.equal(answer.reason, 'not_on_roster');
    const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'pending'", [riley]);
    return { co, riley, request: request.id };
  }
  const APPROVE_AS_SUPERVISOR = "select public.approve_join_request(request_id => $1, role => 'supervisor')";

  it('approved onto a new supervisor\'s row first: a passcode kept for the account meanwhile waits for its lock, then is refused', async () => {
    const { co, riley, request } = await waitingRiley();
    const outcome = await secondWaitsForFirst([await db.request(co.owner), APPROVE_AS_SUPERVISOR, [request]], [await asServer(), KEEP, [riley, PASSCODE]]);
    assert.equal(outcome.code, 'PT409', outcome.message);
    assert.equal(outcome.message, SUPERVISOR_NEEDS_EMAIL);
    assert.deepEqual(await db.adminRows("select role from public.roster where user_id = $1", [riley]), [{ role: 'supervisor' }]);
    assert.deepEqual(await db.adminRows('select 1 from public.crew_logins where user_id = $1', [riley]), []);
  });

  it('a passcode kept first: approving the account onto a new supervisor\'s row waits for its lock, then is refused', async () => {
    const { co, riley, request } = await waitingRiley();
    const outcome = await secondWaitsForFirst([await asServer(), KEEP, [riley, PASSCODE]], [await db.request(co.owner), APPROVE_AS_SUPERVISOR, [request]]);
    assert.equal(outcome.code, 'PT409', outcome.message);
    assert.equal(outcome.message, SUPERVISOR_NEEDS_EMAIL);
    assert.deepEqual(await db.adminRows('select 1 from public.roster where user_id = $1', [riley]), []);
    assert.equal(await passcodeIs(riley, PASSCODE), true);
  });

  /**
   * Sam Ortiz starts Test Pit A and Riley J Quinn Test Pit B, and each is made a supervisor of the
   * other's company. In Test Pit A Sam's row comes first, and in Test Pit B Riley's, in the table and
   * by id alike: the second row of each is given the larger id, and the owner rewrites the table in
   * the order of its ids (CLUSTER), since a row is written wherever the table has room. So a write
   * over every row of a company comes to the two supervisors in opposite orders in the two companies.
   */
  async function twoSupervisorsInTwoCompanies() {
    const sam = await db.newAccount();
    const riley = await db.newAccount();
    const a = await startedBy(sam, 'Test Pit A', ['Sam', 'Ortiz']);
    const b = await startedBy(riley, 'Test Pit B', ['Riley J', 'Quinn']);
    const rileyInA = await madeSupervisor(a, sam, riley, ['Riley J', 'Quinn'], largeId());
    await madeSupervisor(b, riley, sam, ['Sam', 'Ortiz'], largeId());
    await db.adminRows('cluster public.roster using roster_pkey');
    const inTableOrder = async (co) => (await db.adminRows('select user_id from public.roster where company_id = $1 order by ctid', [co.id])).map((row) => row.user_id);
    assert.deepEqual(await inTableOrder(a), [sam, riley]);
    assert.deepEqual(await inTableOrder(b), [riley, sam]);
    return { sam, riley, a, b, rileyInA };
  }
  const EVERY_ROW = "update public.roster set title = 'Shift lead' where company_id = $1";
  const OWN_ROW = "update public.roster set title = 'Lead hand' where id = $1";

  it("two writes over every row of one company at once take turns on its rows, while a supervisor's own row is being written", async () => {
    const { sam, riley, a, rileyInA } = await twoSupervisorsInTwoCompanies();
    const own = await db.request(riley);
    const first = await db.request(sam);
    const second = await db.request(riley);
    try {
      await own.query(OWN_ROW, [rileyInA]);
      const one = await first.start(EVERY_ROW, [a.id]);
      assert.equal(await waiting(first), true, "the first waits for Riley's own row");
      const two = await second.start(EVERY_ROW, [a.id]);
      assert.equal(await waiting(second), true, 'the second waits for the first row the first wrote');
      await own.commit();
      const { outcomes } = await throughInTurn([first, second], [one.settled, two.settled]);
      noDeadlock({ "Sam's write": outcomes[0], "Riley's write": outcomes[1] });
      for (const outcome of outcomes) assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    } finally {
      await own.end();
      await first.end();
      await second.end();
    }
  });

  it('two writes over every row of two companies that share two supervisors do not deadlock', async () => {
    // The roster's write trigger takes an account's lock only for a write that puts the account on a
    // row or makes a row it holds a supervisor's: a job title written over every row takes none.
    // Before that, it took the lock of each supervisor's account whose row a statement wrote, row by
    // row, and two statements over every row of two companies that share two supervisors, coming to
    // them in opposite orders, deadlocked (40P01). Here a supervisor writing their own row holds a row
    // of Test Pit A, as it held one of the locks then. Only a hand-made API request writes many rows
    // at once: the dashboard writes one.
    const { sam, riley, a, b, rileyInA } = await twoSupervisorsInTwoCompanies();
    const own = await db.request(riley);
    const inA = await db.request(sam);
    const inB = await db.request(riley);
    try {
      await own.query(OWN_ROW, [rileyInA]);
      const one = await inA.start(EVERY_ROW, [a.id]);
      assert.equal(await waiting(inA), true, "Sam's write waits for Riley's row in Test Pit A");
      const two = await inB.start(EVERY_ROW, [b.id]);
      // Noted, and asked once both are through: a deadlock, if there is one, is the first thing said.
      const inBWaited = await waiting(inB);
      await own.commit();
      const { outcomes } = await throughInTurn([inA, inB], [one.settled, two.settled]);
      noDeadlock({ "Sam's write in Test Pit A": outcomes[0], "Riley's write in Test Pit B": outcomes[1] });
      for (const outcome of outcomes) assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
      assert.equal(inBWaited, false, "Riley's write in Test Pit B took no account's lock, so it waited for nothing");
    } finally {
      await own.end();
      await inA.end();
      await inB.end();
    }
  });
});

// ---- A reset against the other calls on the account ----------------------------------------------------

describe("a reset at the same moment as another call on the account's row or its lock", { skip: skipWithoutServer }, () => {
  // crew_reset_check takes the account's lock, then its crew_logins row, and takes the lock again,
  // which it holds, as it keeps the new passcode. crew_keep_passcode takes the lock, then the row: the
  // same order. A sign-in and a confirm take the row alone, and a supervisor's roster write the lock
  // alone (above: making the row a supervisor's), so with each of them a reset only takes turns.

  it('the reset first: a sign-in with the new passcode waits for the row, then is let in', async () => {
    const { co, code } = await leeWithACode();
    const outcome = await secondWaitsForFirst(
      [await asServer(), RESET, [co.code, 'Lee', 'Park', code, NEW_A, anyAddress()]],
      [await asServer(), SIGN_IN, [co.code, 'Lee', 'Park', NEW_A, anyAddress()]],
    );
    assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    assert.equal(outcome.rows[0].answer.status, 'ok');
  });

  it('a wrong sign-in first: the reset waits for the row, then keeps the new passcode and clears the count', async () => {
    const { co, lee, code } = await leeWithACode();
    const outcome = await secondWaitsForFirst(
      [await asServer(), SIGN_IN, [co.code, 'Lee', 'Park', WRONG, anyAddress()]],
      [await asServer(), RESET, [co.code, 'Lee', 'Park', code, NEW_A, anyAddress()]],
    );
    assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    assert.equal(outcome.rows[0].answer.status, 'ok');
    assert.equal((await countsOf(lee)).wrong_in_a_row, 0);
    assert.equal(await passcodeIs(lee, NEW_A), true);
  });

  it('the reset first: a confirm with the new passcode waits for the row, then is let in', async () => {
    const { co, lee, code } = await leeWithACode();
    const outcome = await secondWaitsForFirst(
      [await asServer(), RESET, [co.code, 'Lee', 'Park', code, NEW_A, anyAddress()]],
      [await asServer(), CONFIRM, [lee, NEW_A]],
    );
    assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    assert.equal(outcome.rows[0].answer.status, 'ok');
  });

  it('a confirm with the old passcode first: the reset waits for the row, then keeps the new one, and the old one is gone', async () => {
    const { co, lee, code } = await leeWithACode();
    const outcome = await secondWaitsForFirst([await asServer(), CONFIRM, [lee, PASSCODE]], [await asServer(), RESET, [co.code, 'Lee', 'Park', code, NEW_A, anyAddress()]]);
    assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
    assert.equal(outcome.rows[0].answer.status, 'ok');
    assert.equal(await passcodeIs(lee, NEW_A), true);
    assert.equal(await passcodeIs(lee, PASSCODE), false);
  });

  it('a reset and crew_keep_passcode for one account at once take turns on the account\'s lock, with no deadlock', async () => {
    // crew_reset_check takes the account's lock before the account's row, as crew_keep_passcode
    // called on its own does, so the two take turns on the lock. Before that, the reset took the row
    // first and the lock second, and the two deadlocked (40P01). crew-auth never calls
    // crew_keep_passcode on its own for an account a reset can find, so only a call with the server
    // key by hand met it. Here the account's lock is held a moment (by the owner, as the roster's
    // trigger takes it) so the two line up behind it.
    const { co, lee, code } = await leeWithACode();
    const holder = await db.asOwner();
    const keeping = await asServer();
    const resetting = await asServer();
    try {
      await holder.query("select pg_advisory_xact_lock(hashtextextended('crew_logins ' || $1::text, 0))", [lee]);
      const kept = await keeping.start(KEEP, [lee, NEW_B]);
      assert.equal(await waiting(keeping), true, "crew_keep_passcode waits for the account's lock");
      const reset = await resetting.start(RESET, [co.code, 'Lee', 'Park', code, NEW_A, anyAddress()]);
      assert.equal(await waiting(resetting), true, 'the reset waits too');
      await holder.commit();
      const { order, outcomes } = await throughInTurn([keeping, resetting], [kept.settled, reset.settled]);
      noDeadlock({ crew_keep_passcode: outcomes[0], 'the reset': outcomes[1] });
      for (const outcome of outcomes) assert.equal(outcome.ok, true, `${outcome.code} ${outcome.message}`);
      // Keeping a passcode spends the reset code: a reset after it finds none to try. A reset before
      // it keeps its new passcode, which the passcode kept after it replaces.
      const keptFirst = order[0].at === 0;
      assert.equal(outcomes[1].rows[0].answer.status, keptFirst ? 'expired' : 'ok');
      assert.equal(await passcodeIs(lee, NEW_B), true, 'the passcode kept last is the one kept');
    } finally {
      await holder.end();
      await keeping.end();
      await resetting.end();
    }
  });
});
