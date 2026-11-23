// The delete-account edge function (supabase/functions/delete-account), run under Node on the stand-ins
// in stand-ins.mjs: Supabase Auth's /auth/v1/user and its admin delete, and PostgREST's /rest/v1/rpc/*,
// each passed to a local database, answering as Supabase Auth v2.198.0 answered on the private local scan
// stack. Every database function it calls is the person's own: none goes with the server key.
//
// The keys, tokens, ids and names here are made up.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { join, newMember, secondSupervisor, startCompany, startDatabase } from './harness.mjs';
import { adminDeletes, b64, ENV, json, NOW, PUBLISHABLE_KEY as PUBLISHABLE, SECRET_KEY, serveFunction, SUPABASE_URL as URL_ } from './stand-ins.mjs';

const FUNCTION = new URL('../functions/delete-account/', import.meta.url);
const { ALLOWED_ORIGIN, MAX_BODY_BYTES, MAX_CLOSE, PASSWORD_FRESH_SECONDS, makeHandler, passwordTypedAt } = await import(new URL('handler.ts', FUNCTION));
const { keyHeaders, publishableKeyFrom, serverFrom } = await import(new URL('../functions/_shared/server.ts', import.meta.url));

const ENDPOINT = `${URL_}/functions/v1/delete-account`;

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const said = { logs: [], bodies: [] };
const handler = ({ env = ENV } = {}) => serveFunction(makeHandler, db, { env, said });

function post(token, body = {}, { origin = null, raw = null } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: PUBLISHABLE };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  return new Request(ENDPOINT, { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
}

const accountExists = async (id) => (await db.adminRows('select count(*)::int as n from auth.users where id = $1', [id]))[0].n === 1;
const companyExists = async (id) => (await db.adminRows('select count(*)::int as n from public.companies where id = $1', [id]))[0].n === 1;
const revOf = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 20);

describe('the request', () => {
  it('answers a browser’s preflight from the office dashboard alone, and takes POST only', async () => {
    const { ask, auth } = handler();
    const preflight = await ask(new Request(ENDPOINT, { method: 'OPTIONS', headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, apikey, content-type, x-client-info' } }));
    assert.equal(ALLOWED_ORIGIN, 'https://app.minemuster.com');
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
    for (const header of ['authorization', 'apikey', 'content-type', 'x-client-info']) assert.match(preflight.headers.get('access-control-allow-headers'), new RegExp(header));
    assert.match(preflight.headers.get('vary') ?? '', /Origin/);

    const elsewhere = await ask(new Request(ENDPOINT, { method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'POST' } }));
    assert.equal(elsewhere.status, 403);
    assert.equal(elsewhere.headers.get('access-control-allow-origin'), null);
    // A POST from another site's page is turned away before anything is asked.
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const forged = await ask(post(auth.tokenFor(riley), {}, { origin: 'https://example.test' }));
    assert.deepEqual([forged.status, forged.body.error], [403, 'origin_not_allowed']);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const answer = await ask(new Request(ENDPOINT, { method }));
      assert.equal(answer.status, 405, method);
      assert.match(answer.headers.get('allow'), /POST/);
    }
    assert.deepEqual(auth.calls, []);
    assert.ok(await accountExists(riley));
  });

  it('answers 401 with no token, and with one Supabase Auth does not take', async () => {
    const { ask, auth } = handler();
    const none = await ask(post(null));
    assert.deepEqual([none.status, none.body.error], [401, 'signed_out']);
    assert.deepEqual(auth.calls, []);
    const forged = `${b64({ alg: 'none' })}.${b64({ sub: randomUUID(), amr: [{ method: 'password', timestamp: NOW }] })}.`;
    const unknown = await ask(post(forged));
    assert.deepEqual([unknown.status, unknown.body.error], [401, 'signed_out']);
    assert.deepEqual(auth.calls.map((c) => c.path), ['/auth/v1/user']);
  });

  it('answers 413, reading no further, for a body said to be or found larger than 16 KB', async () => {
    assert.equal(MAX_BODY_BYTES, 16_384);
    const { ask, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const token = auth.tokenFor(riley);
    // Said to be larger: none of it is read.
    let pulled = 0;
    // highWaterMark 0: a chunk is made only when someone reads.
    const endless = () =>
      new ReadableStream(
        {
          pull(controller) {
            pulled += 1024;
            controller.enqueue(new Uint8Array(1024).fill(32));
          },
        },
        { highWaterMark: 0 },
      );
    const big = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const declared = await ask(new Request(ENDPOINT, { method: 'POST', headers: { ...big, 'Content-Length': String(MAX_BODY_BYTES + 1) }, body: endless(), duplex: 'half' }));
    assert.deepEqual([declared.status, declared.body.error, pulled], [413, 'too_large', 0]);
    // Not said, and longer than it may be: read up to the limit and no further.
    const streamed = await ask(new Request(ENDPOINT, { method: 'POST', headers: big, body: endless(), duplex: 'half' }));
    assert.deepEqual([streamed.status, streamed.body.error], [413, 'too_large']);
    assert.ok(pulled <= MAX_BODY_BYTES + 2 * 1024, `read ${pulled} bytes`);
    const long = await ask(post(token, null, { raw: `{${' '.repeat(MAX_BODY_BYTES)}}` }));
    assert.deepEqual([long.status, long.body.error], [413, 'too_large']);
    const malformed = await ask(new Request(ENDPOINT, { method: 'POST', headers: { ...big, 'Content-Length': 'lots' }, body: '{}' }));
    assert.deepEqual([malformed.status, malformed.body.error], [400, 'bad_request']);
    assert.deepEqual(auth.calls, [], 'Auth is not asked about a body that is turned back');
    // At the limit exactly, it is read: padded {} is a plain deletion.
    const exact = await ask(post(token, null, { raw: `{${' '.repeat(MAX_BODY_BYTES - 2)}}` }));
    assert.deepEqual([exact.status, exact.body], [200, { deleted: true, closed: [] }]);
  });

  it('answers by Supabase Auth’s own reason: 410 for an account it no longer has, 401 for a session signed out, 500 when the key is refused', async () => {
    const { ask, auth, logged } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const signedOut = auth.tokenFor(riley);
    auth.signOut(signedOut);
    const out = await ask(post(signedOut, {}));
    assert.deepEqual([out.status, out.body.error], [401, 'signed_out']);

    // The gateway turns the key down before Auth sees the request: a setup problem, never a deletion.
    auth.when('user', () => json(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }));
    const refused = await ask(post(auth.tokenFor(riley), {}));
    assert.deepEqual([refused.status, refused.body.error], [500, 'not_set_up']);
    assert.match(logged.at(-1), /no reason of its own \(401\)/);
    auth.when('user', () => json(503, { message: 'upstream connect error' }));
    const down = await ask(post(auth.tokenFor(riley), {}));
    assert.deepEqual([down.status, down.body.error], [500, 'try_again']);
    auth.when('user', null);
    assert.deepEqual(adminDeletes(auth.calls), []);
    assert.ok(await accountExists(riley));

    // Deleted from somewhere else: the token's signature still checks out, and the account is gone.
    const before = auth.tokenFor(riley);
    await db.admin('delete from auth.users where id = $1', [riley]);
    const gone = await ask(post(before, {}));
    assert.deepEqual([gone.status, gone.body.error], [410, 'already_deleted']);
    assert.deepEqual(adminDeletes(auth.calls), []);
  });

  it('turns back a body that names an account, or anything but the companies to close, and deletes nothing', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Lee', last: 'Park' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const lee = await newMember(db, company, 'Lee', 'Park');
    const token = auth.tokenFor(riley);
    const one = { company_id: company.id, name: 'Test Pit A' };
    for (const body of [
      { user_id: lee },
      { id: lee },
      { email: 'lee-3@example.test' },
      { close: [], user_id: lee },
      { close: 'Test Pit A' },
      { close: [{ ...one, user_id: lee }] },
      { close: [{ company_id: 'not-a-uuid', name: 'Test Pit A' }] },
      { close: [{ company_id: company.id }] },
      { close: [one, one] },
      { close: Array.from({ length: MAX_CLOSE + 1 }, () => ({ company_id: randomUUID(), name: 'Test Pit A' })) },
    ]) {
      const answer = await ask(post(token, body));
      assert.deepEqual([answer.status, answer.body.error], [400, 'bad_request'], JSON.stringify(body).slice(0, 80));
    }
    for (const raw of ['[]', 'null', '"x"', 'not json', '{"close": [}', '{"close": [] }\u0000']) {
      const answer = await ask(post(token, null, { raw }));
      assert.deepEqual([answer.status, answer.body.error], [400, 'bad_request'], raw.slice(0, 20));
    }
    assert.equal(MAX_CLOSE, 20);
    assert.deepEqual(adminDeletes(auth.calls), []);
    assert.ok(await accountExists(riley));
    assert.ok(await accountExists(lee));
  });

  it(`needs the password typed in the last ${PASSWORD_FRESH_SECONDS / 60} minutes, by the token’s amr, and deletes nothing without it`, async () => {
    assert.equal(PASSWORD_FRESH_SECONDS, 600);
    const { ask, auth, clock } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const now = Math.floor(clock.now / 1000);
    for (const amr of [
      [{ method: 'password', timestamp: now - 601 }],
      [],
      ['password'],
      [{ method: 'otp', timestamp: now }],
      [{ method: 'password' }],
      [{ method: 'password', timestamp: String(now) }],
      [{ method: 'password', timestamp: now + 3600 }],
      'password',
    ]) {
      const answer = await ask(post(auth.tokenFor(riley, { amr }), {}));
      assert.deepEqual([answer.status, answer.body.error], [403, 'password_needed'], JSON.stringify(amr));
    }
    const noAmr = await ask(post(auth.tokenFor(riley, { noAmr: true }), {}));
    assert.deepEqual([noAmr.status, noAmr.body.error], [403, 'password_needed']);
    assert.deepEqual(adminDeletes(auth.calls), []);
    assert.ok(await accountExists(riley));
    // Ten minutes to the second still counts.
    const answer = await ask(post(auth.tokenFor(riley, { typedAgo: 600 }), {}));
    assert.deepEqual([answer.status, answer.body], [200, { deleted: true, closed: [] }]);
  });

  it('reads the time of the latest password entry in the amr', () => {
    assert.equal(passwordTypedAt([{ method: 'password', timestamp: 10 }, { method: 'otp', timestamp: 50 }, { method: 'password', timestamp: 30 }]), 30);
    assert.equal(passwordTypedAt([{ method: 'otp', timestamp: 50 }]), null);
    for (const amr of [undefined, null, 'password', ['password'], [{ method: 'password', timestamp: Number.NaN }], [null]]) assert.equal(passwordTypedAt(amr), null);
  });

  it('answers 500 not_set_up, asking nothing, when the project’s address or a key is missing', async () => {
    for (const env of [
      { ...ENV, SUPABASE_URL: undefined },
      { ...ENV, SUPABASE_SECRET_KEYS: undefined },
      { ...ENV, SUPABASE_PUBLISHABLE_KEYS: undefined },
    ]) {
      const { ask, auth, logged } = handler({ env });
      const answer = await ask(post('a.b.c'));
      assert.deepEqual([answer.status, answer.body.error], [500, 'not_set_up']);
      assert.deepEqual(auth.calls, []);
      assert.equal(logged.length, 1);
    }
  });

  it('answers 500 try_again when Supabase Auth cannot be reached', async () => {
    const logged = [];
    const failing = makeHandler({ env: (name) => ENV[name], fetch: async () => { throw new TypeError('fetch failed'); }, now: () => NOW * 1000, log: (l) => logged.push(l) });
    const response = await failing(post('a.b.c'));
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, 'try_again');
    assert.equal(logged.length, 1);
  });
});

describe('the keys', () => {
  it('reads the publishable key from SUPABASE_PUBLISHABLE_KEYS, else the legacy anon key', () => {
    assert.equal(publishableKeyFrom((n) => ENV[n]), PUBLISHABLE);
    assert.equal(publishableKeyFrom((n) => ({ SUPABASE_ANON_KEY: ' eyJ.anon.legacy ' })[n]), 'eyJ.anon.legacy');
    assert.equal(publishableKeyFrom((n) => ({ SUPABASE_PUBLISHABLE_KEYS: 'not json', SUPABASE_ANON_KEY: 'eyJ.anon.legacy' })[n]), 'eyJ.anon.legacy');
    assert.equal(publishableKeyFrom(() => undefined), null);
    // The server key is read as the stripe-webhook reads it, from the same shared file.
    assert.deepEqual(serverFrom((n) => ENV[n]), { url: URL_, key: SECRET_KEY });
    assert.deepEqual(keyHeaders(SECRET_KEY), { apikey: SECRET_KEY });
  });
});

describe('deleting', () => {
  it('deletes a crew member’s account, keeps their roster row and records with the company, and knows the token no more', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const record = { id: 'sh-1', employeeId: 'emp-1', clockIn: 1763300000000, clockOut: null, edits: [] };
    await db.as(riley).call('push_records', { company_id: company.id, changes: JSON.stringify([{ key: 'shift:sh-1', kind: 'shift', id: 'sh-1', rev: revOf(record), record }]) });
    const token = auth.tokenFor(riley);

    const answer = await ask(post(token, {}));
    assert.deepEqual([answer.status, answer.body], [200, { deleted: true, closed: [] }]);
    assert.equal(await accountExists(riley), false);
    // Who was deleted came from Auth: the call went to that account's own id, and only once.
    assert.deepEqual(adminDeletes(auth.calls).map((c) => c.path), [`/auth/v1/admin/users/${riley}`]);
    const [row] = await db.adminRows('select user_id, active, first_name from public.roster where company_id = $1 and last_name = $2', [company.id, 'Quinn']);
    assert.deepEqual(row, { user_id: null, active: true, first_name: 'Riley J' });
    const [kept] = await db.adminRows("select created_by from public.records where company_id = $1 and kind = 'shift' and id = 'sh-1'", [company.id]);
    assert.deepEqual(kept, { created_by: null });

    // The same token again: Auth has checked its signature and has no such account, so it is deleted already.
    const again = await ask(post(token, {}));
    assert.deepEqual([again.status, again.body.error], [410, 'already_deleted']);
    assert.equal(adminDeletes(auth.calls).length, 1);
  });

  it('answers 409 for a company’s last supervisor, naming who could take over, and deletes nothing', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    await newMember(db, company, 'Riley', 'Quinn');
    const answer = await ask(post(auth.tokenFor(company.owner), {}));
    assert.equal(answer.status, 409);
    assert.deepEqual(answer.body.companies, [
      {
        id: company.id,
        name: 'Test Pit A',
        successors: [{ roster_id: company.rows['Riley J Quinn'], first_name: 'Riley J', last_name: 'Quinn' }],
        can_close: false,
        close_from: null,
        running: 0,
      },
    ]);
    assert.equal(answer.body.error, 'last_supervisor');
    assert.deepEqual(adminDeletes(auth.calls), []);
    assert.ok(await accountExists(company.owner));
    // Asking to close it does not get around handing over: someone can take over.
    const closing = await ask(post(auth.tokenFor(company.owner), { close: [{ company_id: company.id, name: 'Test Pit A' }] }));
    assert.deepEqual([closing.status, closing.body.error, closing.body.reason, closing.body.closed], [409, 'close_refused', 'someone_can_take_over', []]);
    assert.ok(await companyExists(company.id));
  });

  it('deletes a supervisor’s account once another supervisor can sign in', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db);
    const second = await secondSupervisor(db, company);
    const answer = await ask(post(auth.tokenFor(company.owner), {}));
    assert.deepEqual([answer.status, answer.body], [200, { deleted: true, closed: [] }]);
    assert.equal(await accountExists(company.owner), false);
    assert.ok(await accountExists(second));
  });

  it('closes a company nobody else can take over, then deletes the account', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db, { name: 'Test Pit C', roster: [{ first: 'Lee', last: 'Park' }] });
    const answer = await ask(post(auth.tokenFor(company.owner), { close: [{ company_id: company.id, name: ' test pit c ' }] }));
    assert.deepEqual([answer.status, answer.body], [200, { deleted: true, closed: [company.id] }]);
    assert.equal(await companyExists(company.id), false);
    assert.equal(await accountExists(company.owner), false);
  });

  it('turns back a close on a wrong name or a running subscription, or of a company not the caller’s to close, and says why', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db, { name: 'Test Pit C' });
    const token = () => auth.tokenFor(company.owner);
    const wrong = await ask(post(token(), { close: [{ company_id: company.id, name: 'Test Pit Q' }] }));
    assert.deepEqual([wrong.status, wrong.body.error, wrong.body.reason, wrong.body.company_id, wrong.body.closed], [409, 'close_refused', 'wrong_name', company.id, []]);

    await db.admin("insert into public.billing_subscriptions (subscription_id, company_id, status) values ('sub_test_running', $1, 'active')", [company.id]);
    const running = await ask(post(token(), { close: [{ company_id: company.id, name: 'Test Pit C' }] }));
    assert.deepEqual([running.status, running.body.reason], [409, 'subscription_running']);
    await db.admin("update public.billing_subscriptions set status = 'canceled' where subscription_id = 'sub_test_running'");

    const other = await startCompany(db, { name: 'Test Pit O' });
    const theirs = await ask(post(token(), { close: [{ company_id: other.id, name: 'Test Pit O' }] }));
    assert.deepEqual([theirs.status, theirs.body.reason], [409, 'not_found']);
    assert.ok(await companyExists(company.id));
    assert.ok(await companyExists(other.id));
    assert.ok(await accountExists(company.owner));
    assert.deepEqual(adminDeletes(auth.calls), []);
  });

  it('says what it already closed when a later close is turned back', async () => {
    const { ask, auth } = handler();
    const first = await startCompany(db, { name: 'Test Pit K' });
    const owner = first.owner;
    // The same account is the only supervisor of a second company it started.
    const [made] = await db.as(owner).callRows('create_company', { name: 'Test Pit L', state: 'CA', timezone: null, first_name: 'Sam', last_name: 'Ortiz', title: null });
    await db.admin("insert into public.billing_overrides (company_id, reason) values ($1, 'A test company')", [made.company_id]);
    const answer = await ask(post(auth.tokenFor(owner), { close: [{ company_id: first.id, name: 'Test Pit K' }, { company_id: made.company_id, name: 'Test Pit X' }] }));
    assert.deepEqual([answer.status, answer.body.reason, answer.body.company_id, answer.body.closed], [409, 'wrong_name', made.company_id, [first.id]]);
    assert.equal(await companyExists(first.id), false);
    assert.ok(await companyExists(made.company_id));
    assert.ok(await accountExists(owner));
  });

  it('answers 500 try_again when the admin delete fails, and 409 when the person became the last supervisor meanwhile', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    auth.when('admin_delete', () => json(500, { code: 'unexpected_failure', msg: 'Database error deleting user' }));
    const failed = await ask(post(auth.tokenFor(riley), {}));
    assert.deepEqual([failed.status, failed.body.error, failed.body.closed], [500, 'try_again', []]);
    assert.ok(await accountExists(riley));

    // Two supervisors; the other steps down between the check and the delete, so the guard refuses it.
    const pit = await startCompany(db, { name: 'Test Pit R' });
    const second = await secondSupervisor(db, pit, 'Ana', 'Diaz');
    auth.when('admin_delete', async () => {
      await db.as(second).query("update public.roster set role = 'employee' where id = $1", [pit.rows['Ana Diaz']]);
      return null;
    });
    const raced = await ask(post(auth.tokenFor(pit.owner), {}));
    assert.equal(raced.status, 409);
    assert.equal(raced.body.error, 'last_supervisor');
    assert.deepEqual(raced.body.companies.map((c) => c.name), ['Test Pit R']);
    assert.ok(await accountExists(pit.owner));
  });

  it('does not close a company while someone taken off lately could come back, and says from when', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db, { name: 'Test Pit W', roster: [{ first: 'Lee', last: 'Park' }] });
    await newMember(db, company, 'Lee', 'Park');
    await db.as(company.owner).query('update public.roster set active = false where id = $1', [company.rows['Lee Park']]);
    // Deleting without closing: the last supervisor, nobody to hand over to, and not yet a company to close.
    const asked = await ask(post(auth.tokenFor(company.owner), {}));
    assert.equal(asked.status, 409);
    const [named] = asked.body.companies;
    assert.deepEqual([named.name, named.successors, named.can_close], ['Test Pit W', [], false]);
    const thirtyDays = Date.now() + 30 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(Date.parse(named.close_from) - thirtyDays) < 60_000, named.close_from);
    const closing = await ask(post(auth.tokenFor(company.owner), { close: [{ company_id: company.id, name: 'Test Pit W' }] }));
    assert.deepEqual([closing.status, closing.body.reason, closing.body.closed], [409, 'someone_can_take_over', []]);
    assert.ok(Math.abs(Date.parse(closing.body.close_from) - thirtyDays) < 60_000);
    assert.ok(await companyExists(company.id));
    assert.ok(await accountExists(company.owner));
  });

  it('answers 403 password_needed when the database finds the password too old to close a company, and closes nothing', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db, { name: 'Test Pit V', roster: [{ first: 'Lee', last: 'Park' }] });
    // The function's clock and the database's disagree by more than the ten minutes: the database's word goes.
    const token = auth.tokenFor(company.owner, { databaseAmr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 700 }] });
    const answer = await ask(post(token, { close: [{ company_id: company.id, name: 'Test Pit V' }] }));
    assert.deepEqual([answer.status, answer.body.error], [403, 'password_needed']);
    assert.ok(await companyExists(company.id));
    assert.ok(await accountExists(company.owner));
    assert.deepEqual(adminDeletes(auth.calls), []);
  });

  it('asks Supabase Auth again when the delete goes unanswered: deleted when the account is gone, 504 not_known while it is there', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Lee', last: 'Park' }, { first: 'Bo', last: 'Lark' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const lee = await newMember(db, company, 'Lee', 'Park');
    const bo = await newMember(db, company, 'Bo', 'Lark');

    // The delete went through, and its answer was lost on the way back.
    auth.when('admin_delete', async (_call, { id }) => {
      await db.admin('delete from auth.users where id = $1', [id]);
      throw new TypeError('fetch failed');
    });
    const lost = await ask(post(auth.tokenFor(riley), {}));
    assert.deepEqual([lost.status, lost.body], [200, { deleted: true, closed: [] }]);
    assert.equal(await accountExists(riley), false);

    // No answer, and the account is still there: it may yet be deleted, so nothing is promised either way.
    auth.when('admin_delete', () => {
      throw new TypeError('fetch failed');
    });
    const silent = await ask(post(auth.tokenFor(lee), {}));
    assert.deepEqual([silent.status, silent.body.error, silent.body.closed], [504, 'not_known', []]);
    assert.ok(await accountExists(lee));

    // A gateway's timeout is no answer from Auth either.
    auth.when('admin_delete', () => json(504, { message: 'The upstream server is timing out' }));
    const timedOut = await ask(post(auth.tokenFor(bo), {}));
    assert.deepEqual([timedOut.status, timedOut.body.error], [504, 'not_known']);

    // Auth's own refusal, for a delete Auth answered: nothing was deleted.
    auth.when('admin_delete', () => json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error deleting user' }));
    const turnedDown = await ask(post(auth.tokenFor(bo), {}));
    assert.deepEqual([turnedDown.status, turnedDown.body.error], [500, 'try_again']);
    assert.ok(await accountExists(bo));
  });

  it('deletes an account that is on no roster at all, such as one that only ever asked to join', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db);
    const asker = await db.newAccount('asker');
    assert.equal((await join(db, asker, company.code, 'Pat', 'Cole')).status, 'pending');
    const answer = await ask(post(auth.tokenFor(asker), {}));
    assert.deepEqual([answer.status, answer.body], [200, { deleted: true, closed: [] }]);
    assert.deepEqual(await db.adminRows('select id from public.join_requests where user_id = $1', [asker]), []);
  });
});

describe('what it says', () => {
  it('never writes a token, a key, an email or an account’s id in its log or its answers', async () => {
    const { ask, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const [{ email }] = await db.adminRows('select email from auth.users where id = $1', [riley]);
    const tokens = [auth.tokenFor(riley, { typedAgo: 900 }), auth.tokenFor(company.owner), auth.tokenFor(riley)];
    for (const token of tokens) await ask(post(token, {}));
    const everything = [...said.logs, ...said.bodies].join('\n');
    assert.ok(said.logs.length > 0);
    for (const secret of [SECRET_KEY, PUBLISHABLE, email, riley, company.owner, ...tokens]) assert.ok(!everything.includes(secret), `said ${secret.slice(0, 12)}...`);
  });
});
