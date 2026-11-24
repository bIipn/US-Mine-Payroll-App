// Two push_records calls at the same instant, acted out on a real PostgreSQL
// server (see server.mjs; skipped without one). PGlite is one session and
// cannot overlap two transactions, so these are the only tests that show:
//
//  * one company's calls taking turns on its row in record_counters, so the
//    second call's versions get later seq numbers than the first's, and a
//    client pulling by seq never misses a version that committed late;
//  * two calls making the same new record: the second waits, then finds the
//    first one's record and answers as it would for any record already there,
//    not with a duplicate-key error;
//  * at REPEATABLE READ, where a function or a direct connection may run, the
//    second call is told to try again (40001) rather than counting from an
//    older snapshot;
//  * two companies' calls not waiting for each other.
//  * the one 40001 push_records raises itself ("Another phone was sending the
//    same record. Try again."): a record written by something other than
//    push_records, as the owner can in the SQL editor, between push_records'
//    read and its write. PostgREST retries a 40001 with no limit, so this
//    shows the condition does not last: the call made again, as PostgREST
//    makes it, finds the record and answers as for any record already there.
//
// All names are made up.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { skipWithoutServer, startServerDatabase } from './server.mjs';

let db;
before(async () => {
  if (!skipWithoutServer) db = await startServerDatabase();
});
after(async () => {
  await db?.drop();
});

const revOf = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 20);
let made = 0;
const newId = () => `sh_race_${(made += 1)}`;
const shift = (id, employeeId = 'emp_a') => ({ id, employeeId, clockIn: { at: 1763300000000 }, lunches: [], breaks: [] });
const change = (id, record) => ({ key: `shift:${id}`, kind: 'shift', id, rev: revOf(record), record });
const PUSH = 'select public.push_records(company_id => $1, changes => $2::jsonb) as result';

/** A company with its supervisor and one employee, each with an account. */
async function company(name) {
  const owner = await db.newAccount();
  const crew = await db.newAccount();
  const [made] = await db.asAccount(
    owner,
    'select * from public.create_company(name => $1, state => \'CA\', timezone => null, first_name => \'Sam\', last_name => \'Ortiz\')',
    [name],
  );
  await db.asAccount(owner, "insert into public.roster (company_id, first_name, last_name) values ($1, 'Riley J', 'Quinn')", [made.company_id]);
  await db.asAccount(crew, "select public.join_company(code => $1, first_name => 'Riley', last_name => 'Quinn')", [made.join_code]);
  return { id: made.company_id, owner, crew };
}

async function seqOf(companyId, id) {
  const [row] = await db.adminRows("select seq::int from public.records where company_id = $1 and kind = 'shift' and id = $2", [companyId, id]);
  return row?.seq;
}

describe('two calls from one company at once', { skip: skipWithoutServer }, () => {
  it('take turns, so the one that commits second has the later seq', async () => {
    const co = await company('Test Pit A');
    const [x, y] = [newId(), newId()];
    const first = await db.request(co.crew);
    await first.query(PUSH, [co.id, JSON.stringify([change(x, shift(x))])]);
    const second = await db.request(co.owner);
    const { settled } = await second.start(PUSH, [co.id, JSON.stringify([change(y, shift(y, 'emp_b'))])]);
    // The second call waits for the first's counter.
    const [{ waiting }] = await db.adminRows("select count(*)::int as waiting from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [second.pid]);
    assert.equal(waiting, 1);
    // A pull right now sees neither.
    assert.equal(await seqOf(co.id, x), undefined);
    await first.commit();
    const outcome = await settled;
    assert.equal(outcome.ok, true, outcome.message);
    await second.commit();
    assert.ok((await seqOf(co.id, y)) > (await seqOf(co.id, x)));
    await first.end();
    await second.end();
  });

  it('making the same new record: the second finds the first one\'s, with no duplicate-key error', async () => {
    const co = await company('Test Pit A2');
    const id = newId();
    const first = await db.request(co.crew);
    await first.query(PUSH, [co.id, JSON.stringify([change(id, shift(id))])]);
    const second = await db.request(co.owner);
    const theirs = change(id, shift(id, 'emp_b'));
    const { settled } = await second.start(PUSH, [co.id, JSON.stringify([theirs])]);
    await first.commit();
    const outcome = await settled;
    assert.equal(outcome.ok, true, outcome.message);
    await second.commit();
    // The record is the crew member's: the supervisor's copy, made without a base, is set aside.
    assert.deepEqual(outcome.rows[0].result, { accepted: [], ignored: [{ key: theirs.key, rev: theirs.rev, reason: 'taken' }] });
    const [{ n }] = await db.adminRows('select count(*)::int as n from public.record_history where company_id = $1 and id = $2', [co.id, id]);
    assert.equal(n, 1);
    await first.end();
    await second.end();
  });

  it('at REPEATABLE READ, the second is told to try again', async () => {
    const co = await company('Test Pit A3');
    const [x, y] = [newId(), newId()];
    const first = await db.request(co.crew, 'repeatable read');
    await first.query(PUSH, [co.id, JSON.stringify([change(x, shift(x))])]);
    const second = await db.request(co.owner, 'repeatable read');
    const { settled } = await second.start(PUSH, [co.id, JSON.stringify([change(y, shift(y, 'emp_b'))])]);
    await first.commit();
    const outcome = await settled;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, '40001');
    await second.rollback();
    assert.equal(await seqOf(co.id, y), undefined);
    await first.end();
    await second.end();
  });
});

describe('two companies at once', { skip: skipWithoutServer }, () => {
  it('do not wait for each other', async () => {
    const [one, two] = [await company('Test Pit B'), await company('Test Pit C')];
    const [x, y] = [newId(), newId()];
    const first = await db.request(one.crew);
    await first.query(PUSH, [one.id, JSON.stringify([change(x, shift(x))])]);
    const second = await db.request(two.crew);
    const result = await second.query(PUSH, [two.id, JSON.stringify([change(y, shift(y))])]);
    assert.equal(result.rows[0].result.accepted.length, 1);
    await second.commit();
    await first.commit();
    await first.end();
    await second.end();
  });
});

describe('a record written by the owner while push_records is making it', { skip: skipWithoutServer }, () => {
  const TRY_AGAIN = 'Another phone was sending the same record. Try again.';
  const OWNERS = "insert into public.records (company_id, kind, id, rev, data, seq) values ($1, 'shift', $2, 'r-owner', $3::jsonb, 1000000)";

  /** push_records waits on the owner's new row, which it could not see when it read; the owner then commits or rolls back. */
  async function sentWhileTheOwnerWrites(co, id, ending) {
    const owner = await db.asOwner();
    await owner.query(OWNERS, [co.id, id, JSON.stringify(shift(id, 'emp_owner'))]);
    const sending = await db.request(co.crew);
    const { settled } = await sending.start(PUSH, [co.id, JSON.stringify([change(id, shift(id))])]);
    const [{ waiting }] = await db.adminRows("select count(*)::int as waiting from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [sending.pid]);
    assert.equal(waiting, 1, 'push_records waits on the row the owner is writing');
    await (ending === 'commit' ? owner.commit() : owner.rollback());
    const outcome = await settled;
    await (outcome.ok ? sending.commit() : sending.rollback());
    await owner.end();
    await sending.end();
    return outcome;
  }

  /** The same call again, in a transaction of its own, as PostgREST makes it after a 40001. */
  async function sentAgain(co, id) {
    const again = await db.request(co.crew);
    const outcome = await again.query(PUSH, [co.id, JSON.stringify([change(id, shift(id))])]);
    await again.commit();
    await again.end();
    return outcome.rows[0].result;
  }

  it('is the one time it says "try again" (40001), and the call made again is answered at once', async () => {
    const co = await company('Test Pit D');
    const id = newId();
    const outcome = await sentWhileTheOwnerWrites(co, id, 'commit');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, '40001');
    assert.equal(outcome.message, TRY_AGAIN);

    // Made again, it reads the owner's record and sets the phone's copy aside, as for any record it did not make.
    const theirs = change(id, shift(id));
    assert.deepEqual(await sentAgain(co, id), { accepted: [], ignored: [{ key: theirs.key, rev: theirs.rev, reason: 'taken' }] });
    // And again: nothing lasting is left to raise on.
    assert.deepEqual(await sentAgain(co, id), { accepted: [], ignored: [{ key: theirs.key, rev: theirs.rev, reason: 'taken' }] });
    const [{ n }] = await db.adminRows("select count(*)::int as n from public.records where company_id = $1 and kind = 'shift' and id = $2", [co.id, id]);
    assert.equal(n, 1);
  });

  it('is not raised when the owner rolls back: the phone\'s record is written', async () => {
    const co = await company('Test Pit E');
    const id = newId();
    const outcome = await sentWhileTheOwnerWrites(co, id, 'rollback');
    assert.equal(outcome.ok, true, outcome.message);
    const theirs = change(id, shift(id));
    assert.deepEqual(outcome.rows[0].result, { accepted: [{ key: theirs.key, rev: theirs.rev }], ignored: [] });
  });

  it('is never raised by two phones making the same record: the second waits for the first and finds it', async () => {
    // As "making the same new record" above: the company's counter makes them take turns before either reads.
    const co = await company('Test Pit F');
    const id = newId();
    const first = await db.request(co.crew);
    await first.query(PUSH, [co.id, JSON.stringify([change(id, shift(id))])]);
    const second = await db.request(co.crew);
    const { settled } = await second.start(PUSH, [co.id, JSON.stringify([change(id, shift(id))])]);
    await first.commit();
    const outcome = await settled;
    assert.equal(outcome.ok, true, outcome.message);
    await second.commit();
    const mine = change(id, shift(id));
    assert.deepEqual(outcome.rows[0].result, { accepted: [{ key: mine.key, rev: mine.rev }], ignored: [] });
    await first.end();
    await second.end();
  });
});
