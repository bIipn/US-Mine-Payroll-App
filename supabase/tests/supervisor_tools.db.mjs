// The supervisor-tools edge function (supabase/functions/supervisor-tools), run under Node on the stand-ins in
// stand-ins.mjs: PostgREST's /rest/v1/rpc/* over a local database, where invite_supervisor,
// resend_supervisor_invitation and crew_sign_in_to_delete run as the supervisor, with their own token, and
// account_for_email with the server key; and Supabase Auth's /auth/v1/user, its invite and its admin delete.
// The invite answers as Supabase Auth's source says it does (see stand-ins.mjs).
//
// The keys, tokens, ids and names here are made up, and every email address is on example.test. What every
// test sends, logs and is answered, every token the stand-ins mint and every account a test makes is kept
// (said), and the last test holds every log in the file to none of it.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { addToRoster, join, newMember, nobody, rosterRow, secondSupervisor, startCompany, startDatabase } from './harness.mjs';
import { adminDeletes, b64, ENV, json, PUBLISHABLE_KEY as PUBLISHABLE, SECRET_KEY, serveFunction, SUPABASE_URL } from './stand-ins.mjs';

const FUNCTION = new URL('../functions/supervisor-tools/', import.meta.url);
const { ALLOWED_ORIGIN, INVITE_LINK, MAX_BODY_BYTES, makeHandler } = await import(new URL('handler.ts', FUNCTION));
const { CALL_TIMEOUT_MS, DASHBOARD_CORS, DASHBOARD_ORIGIN, UUID, dashboardGate, tokenAndBody } = await import(new URL('../functions/_shared/http.ts', import.meta.url));
const { settingsFrom } = await import(new URL('../functions/_shared/server.ts', import.meta.url));
/** delete-account, the other function the dashboard calls, which shares the dashboard's gate. */
const deleteAccount = await import(new URL('../functions/delete-account/handler.ts', import.meta.url));

const ENDPOINT = `${SUPABASE_URL}/functions/v1/supervisor-tools`;
/** The one database function supervisor-tools calls with the server key: it calls the others as the supervisor. */
const SERVER_FUNCTIONS = ['account_for_email'];
/** A passcode that passes the passcode rule. */
const PASSCODE = '583920';
const SENT = { status: 'sent' };
const DELETED = { status: 'deleted' };
const TOO_MANY = { code: 429, error_code: 'over_email_send_rate_limit', msg: 'Email rate limit exceeded' };
const NO_ANSWER = () => {
  throw new TypeError('fetch failed');
};

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

/** What every test in this file sent, logged and was answered, every token minted and every account made. */
const said = { logs: [], bodies: [], sent: [], minted: [], accounts: [] };
/** Every stand-in the file made, for the calls each was sent. */
const stands = [];

function handler({ env = ENV } = {}) {
  const served = serveFunction(makeHandler, db, { env, said, serverFunctions: SERVER_FUNCTIONS });
  stands.push(served.auth);
  return { ...served, send: (token, body, options) => served.ask(post(token, body, options)) };
}

/**
 * A request as the dashboard sends one with supabase-js: POST, JSON, from the dashboard's origin, with the
 * supervisor's token. `origin` null sends none. What it sends is kept, for the last test.
 */
function post(token, body, { origin = ALLOWED_ORIGIN, raw = null } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: PUBLISHABLE, 'x-client-info': 'supabase-js-web/2.119.0' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  said.sent.push({ body, raw, headers });
  return new Request(ENDPOINT, { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
}

const invite = (rosterId, email) => ({ action: 'invite', roster_id: rosterId, email });
const resend = (invitationId) => ({ action: 'resend', invitation_id: invitationId });
const deleteSignIn = (rosterId) => ({ action: 'delete_crew_sign_in', roster_id: rosterId });

let mailed = 0;
/** An email address no test has used yet. */
const newAddress = (who) => `${who}-${(mailed += 1)}@example.test`;
/** The same address with a capital at the start of each part and spaces around it, as someone might type it. */
const asTyped = (address) => `  ${address.replace(/(^|[.@])([a-z])/g, (_, mark, letter) => mark + letter.toUpperCase())} `;

/** An account with this address, as Supabase Auth keeps one: confirmed once its link was opened. */
async function accountWith(email, { confirmed = true } = {}) {
  const id = randomUUID();
  await db.admin('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, case when $3::boolean then now() end)', [id, email, confirmed]);
  said.accounts.push(id);
  return id;
}

/** Whether each account at an address is confirmed. */
const confirmedAt = async (email) => (await db.adminRows('select email_confirmed_at is not null as confirmed from auth.users where lower(email) = lower($1)', [email])).map((a) => a.confirmed);
/** The address's account is confirmed, as when its person opens the link Supabase Auth sent. */
const confirmAt = (email) => db.admin('update auth.users set email_confirmed_at = now() where lower(email) = lower($1)', [email]);

/** A crew member's passcode account, made as crew-auth makes one: an account, its passcode kept, and the name typed to join. */
async function crewMember(company, first, last) {
  const account = await db.newAccount('crew');
  said.accounts.push(account);
  await db.serviceRole().call('crew_keep_passcode', { p_user: account, p_passcode: PASSCODE });
  assert.equal((await join(db, account, company.code, first, last)).status, 'joined', `${first} ${last} joins`);
  return account;
}

/** The invitations onto a row, oldest first. */
const invitationsOn = (rowId) => db.adminRows('select * from public.supervisor_invitations where roster_id = $1 order by created_at, id', [rowId]);
/** The row's open invitation, neither accepted nor cancelled, or null. */
async function openOn(rowId) {
  const open = (await invitationsOn(rowId)).filter((i) => i.accepted_at === null && i.cancelled_at === null);
  assert.ok(open.length <= 1, 'a row has one open invitation at most');
  return open[0] ?? null;
}
const takeOff = (company, rowId) => db.as(company.owner).query('update public.roster set active = false where id = $1', [rowId]);
const accountExists = async (id) => (await db.adminRows('select count(*)::int as n from auth.users where id = $1', [id]))[0].n === 1;
const routes = (calls) => calls.map((c) => `${c.method} ${c.path}`);
/** How many times Supabase Auth's invite was asked, of these calls. */
const invitesOf = (calls) => calls.filter((c) => c.path === '/auth/v1/invite').length;
const revOf = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 20);
/** How far ahead of now a time is, in days. */
const daysAhead = (time) => (new Date(time).getTime() - Date.now()) / (24 * 60 * 60 * 1000);

describe('the request', () => {
  it("only the dashboard's origin may call it, with a supervisor's token", async () => {
    const { ask, send, auth } = handler();
    assert.equal(ALLOWED_ORIGIN, 'https://app.minemuster.com');
    const company = await startCompany(db, { roster: [{ first: 'Jo', last: 'Vale', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }] });
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const row = company.rows['Jo Vale'];
    const rileyRow = company.rows['Riley J Quinn'];
    const owner = () => auth.tokenFor(company.owner);

    // The dashboard's preflight is answered, and nobody else's.
    const preflight = await ask(
      new Request(ENDPOINT, {
        method: 'OPTIONS',
        headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, apikey, content-type, x-client-info' },
      }),
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
    for (const header of ['authorization', 'apikey', 'content-type', 'x-client-info']) assert.match(preflight.headers.get('access-control-allow-headers'), new RegExp(header));
    assert.match(preflight.headers.get('vary') ?? '', /Origin/);
    const elsewhere = await ask(new Request(ENDPOINT, { method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'POST' } }));
    assert.deepEqual([elsewhere.status, elsewhere.body.error], [403, 'origin_not_allowed']);
    assert.equal(elsewhere.headers.get('access-control-allow-origin'), null);

    // Another site's page is turned away before anything is asked, whatever it asks, a supervisor's token and all.
    for (const origin of ['https://example.test', 'http://app.minemuster.com', 'https://app.minemuster.com.example.test', 'null']) {
      for (const body of [invite(row, newAddress('jo')), resend(nobody()), deleteSignIn(rileyRow)]) {
        const answer = await send(owner(), body, { origin });
        assert.deepEqual([answer.status, answer.body.error], [403, 'origin_not_allowed']);
        assert.equal(answer.headers.get('access-control-allow-origin'), null);
      }
    }
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const answer = await ask(new Request(ENDPOINT, { method, headers: { Origin: ALLOWED_ORIGIN } }));
      assert.deepEqual([answer.status, answer.body.error], [405, 'method_not_allowed'], method);
      assert.equal(answer.headers.get('allow'), 'POST, OPTIONS');
    }
    const none = await send(null, invite(row, newAddress('jo')));
    assert.deepEqual([none.status, none.body.error], [401, 'signed_out']);
    assert.deepEqual(auth.calls, [], 'nothing is asked for a request turned back');

    // A token Supabase Auth did not sign, a session signed out and an account deleted are signed out, and only
    // Auth is asked, whose each token is.
    const forged = `${b64({ alg: 'none' })}.${b64({ sub: company.owner, role: 'authenticated' })}.`;
    const signedOut = owner();
    auth.signOut(signedOut);
    const ana = await secondSupervisor(db, company, 'Ana', 'Diaz');
    said.accounts.push(ana);
    const deleted = auth.tokenFor(ana);
    await db.admin('delete from auth.users where id = $1', [ana]);
    for (const token of [forged, signedOut, deleted]) {
      for (const body of [invite(row, newAddress('jo')), resend(nobody()), deleteSignIn(rileyRow)]) {
        const answer = await send(token, body);
        assert.deepEqual([answer.status, answer.body.error], [401, 'signed_out']);
      }
    }
    assert.ok(auth.calls.every((c) => c.path === '/auth/v1/user'), 'only Auth was asked');

    // A supervisor of the row's company, from the dashboard: answered, with the dashboard's CORS headers.
    const sent = await send(owner(), invite(row, newAddress('jo')));
    assert.deepEqual([sent.status, sent.body], [200, SENT]);
    assert.equal(sent.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.match(sent.headers.get('vary') ?? '', /Origin/);
    const open = await openOn(row);

    // Anyone else: to a crew member, or a supervisor of another company, the row or the invitation is not there.
    const before = auth.calls.length;
    for (const caller of [riley, other.owner]) {
      for (const body of [invite(row, newAddress('jo')), resend(open.id), deleteSignIn(rileyRow)]) {
        const answer = await send(auth.tokenFor(caller), body);
        assert.deepEqual([answer.status, answer.body.error], [404, 'not_found']);
        assert.equal(answer.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
      }
    }
    assert.equal((await openOn(row)).id, open.id, 'the invitation is as it was');
    assert.ok(await accountExists(riley));
    assert.deepEqual(adminDeletes(auth.calls), []);
    assert.equal(invitesOf(auth.calls.slice(before)), 0);

    // A request with no Origin is no web page's: it is taken, as delete-account takes one, with no CORS headers.
    const direct = await send(owner(), resend(open.id), { origin: null });
    assert.deepEqual([direct.status, direct.body], [200, SENT]);
    assert.equal(direct.headers.get('access-control-allow-origin'), null);
  });

  it('answers 413, reading no further, for a body said to be or found larger than 16 KB', async () => {
    assert.equal(MAX_BODY_BYTES, 16_384);
    const { ask, send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Jo', last: 'Vale', role: 'supervisor' }] });
    const token = auth.tokenFor(company.owner);
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
    const headers = { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const declared = await ask(new Request(ENDPOINT, { method: 'POST', headers: { ...headers, 'Content-Length': String(MAX_BODY_BYTES + 1) }, body: endless(), duplex: 'half' }));
    assert.deepEqual([declared.status, declared.body.error, pulled], [413, 'too_large', 0]);
    const streamed = await ask(new Request(ENDPOINT, { method: 'POST', headers, body: endless(), duplex: 'half' }));
    assert.deepEqual([streamed.status, streamed.body.error], [413, 'too_large']);
    assert.ok(pulled <= MAX_BODY_BYTES + 2 * 1024, `read ${pulled} bytes`);
    const body = JSON.stringify(invite(company.rows['Jo Vale'], newAddress('jo')));
    const long = await send(token, null, { raw: `${body.slice(0, -1)}${' '.repeat(MAX_BODY_BYTES)}}` });
    assert.deepEqual([long.status, long.body.error], [413, 'too_large']);
    const lots = await ask(new Request(ENDPOINT, { method: 'POST', headers: { ...headers, 'Content-Length': 'lots' }, body }));
    assert.deepEqual([lots.status, lots.body.error], [400, 'bad_request']);
    assert.deepEqual(auth.calls, [], 'nothing is asked for a body turned back');
    // At the limit exactly, it is read.
    const exact = await send(token, null, { raw: `${body.slice(0, -1)}${' '.repeat(MAX_BODY_BYTES - body.length)}}` });
    assert.deepEqual([exact.status, exact.body], [200, SENT]);
  });

  it('turns back a body that is not one action with the fields it takes, each of them text and each id a uuid', async () => {
    const { ask, send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Jo', last: 'Vale', role: 'supervisor' }] });
    const token = auth.tokenFor(company.owner);
    const row = company.rows['Jo Vale'];
    const email = newAddress('jo');
    const bodies = [
      {},
      { action: 'invite' },
      { action: 'invite', roster_id: row },
      { action: 'invite', email },
      { action: 'invite', roster_id: row, email, company_id: company.id },
      { action: 'invite', roster_id: row, email: [email] },
      { action: 'invite', roster_id: 'not-a-uuid', email },
      { action: 'invite', roster_id: null, email },
      { action: 'resend' },
      { action: 'resend', invitation_id: 42 },
      { action: 'resend', invitation_id: `${row}0` },
      { action: 'resend', roster_id: row },
      { action: 'delete_crew_sign_in', roster_id: row, user_id: company.owner },
      { action: 'delete_crew_sign_in', user_id: company.owner },
      { action: 'delete_crew_sign_in', roster_id: `{${row}}` },
      { action: 'cancel', invitation_id: row },
      { action: ['invite'], roster_id: row, email },
    ];
    for (const [i, body] of bodies.entries()) {
      const answer = await send(token, body);
      assert.deepEqual([answer.status, answer.body.error], [400, 'bad_request'], `body ${i}`);
    }
    for (const [i, raw] of ['', '[]', 'null', '"invite"', 'not json', `{"action": "invite", "roster_id": "${row}"`].entries()) {
      const answer = await send(token, null, { raw });
      assert.deepEqual([answer.status, answer.body.error], [400, 'bad_request'], `raw ${i}`);
    }
    // Bytes that are not UTF-8.
    const bytes = await ask(new Request(ENDPOINT, { method: 'POST', headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: new Uint8Array([0x7b, 0xff, 0x7d]) }));
    assert.deepEqual([bytes.status, bytes.body.error], [400, 'bad_request']);
    assert.deepEqual(auth.calls, [], 'nothing is asked for a body turned back');
    assert.deepEqual(await invitationsOn(row), []);
  });

  it('answers 500 not_set_up, asking nothing, when the project’s address or a key is missing', async () => {
    for (const env of [
      { ...ENV, SUPABASE_URL: undefined },
      { ...ENV, SUPABASE_SECRET_KEYS: undefined },
      { ...ENV, SUPABASE_PUBLISHABLE_KEYS: undefined },
    ]) {
      const { send, auth, logged } = handler({ env });
      const answer = await send('a.b.c', resend(nobody()));
      assert.deepEqual([answer.status, answer.body.error], [500, 'not_set_up']);
      assert.deepEqual(auth.calls, []);
      assert.equal(logged.length, 1);
    }
  });
});

describe('what the dashboard’s functions share', () => {
  it('the dashboard’s gate refuses another site’s page in the function’s own words, answers a preflight, refuses any method but POST, and puts CORS on what it lets through for the dashboard alone', async () => {
    assert.equal(DASHBOARD_ORIGIN, 'https://app.minemuster.com');
    assert.equal(INVITE_LINK, `${DASHBOARD_ORIGIN}/?invited=1`);
    const logs = [];
    const gate = (method, origin) => dashboardGate(new Request(ENDPOINT, { method, headers: origin ? { Origin: origin } : {} }), 'Use the office dashboard.', (code) => logs.push(code));

    const refused = gate('POST', 'https://example.test');
    assert.ok(refused instanceof Response);
    assert.deepEqual([refused.status, await refused.json()], [403, { error: 'origin_not_allowed', message: 'Use the office dashboard.' }]);
    assert.equal(refused.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(logs, ['origin_not_allowed']);
    const preflight = gate('OPTIONS', DASHBOARD_ORIGIN);
    assert.equal(preflight.status, 204);
    assert.deepEqual(Object.fromEntries(preflight.headers), Object.fromEntries(new Headers(DASHBOARD_CORS)));
    const get = gate('GET', DASHBOARD_ORIGIN);
    assert.deepEqual([get.status, (await get.json()).error, get.headers.get('allow'), get.headers.get('access-control-allow-origin')], [405, 'method_not_allowed', 'POST, OPTIONS', DASHBOARD_ORIGIN]);

    // What it lets through gets a responder: JSON, with the CORS headers for the dashboard and none for a
    // request with no Origin, which is no web page's.
    for (const [origin, cors] of [
      [DASHBOARD_ORIGIN, DASHBOARD_ORIGIN],
      [null, null],
    ]) {
      const respond = gate('POST', origin);
      assert.equal(typeof respond, 'function');
      const answer = respond({ status: 409, body: { error: 'row_taken' }, headers: { 'Retry-After': '1' } });
      assert.deepEqual([answer.status, await answer.json(), answer.headers.get('content-type'), answer.headers.get('retry-after')], [409, { error: 'row_taken' }, 'application/json', '1']);
      assert.equal(answer.headers.get('access-control-allow-origin'), cors);
    }
    assert.equal(logs.length, 1);
  });

  it('delete-account and supervisor-tools answer the dashboard’s gate alike, but for their own words', async () => {
    assert.equal(deleteAccount.ALLOWED_ORIGIN, DASHBOARD_ORIGIN);
    assert.equal(ALLOWED_ORIGIN, DASHBOARD_ORIGIN);
    assert.equal(deleteAccount.MAX_BODY_BYTES, MAX_BODY_BYTES);
    const fetch = async () => assert.fail('nothing is asked of a request the gate or the start turns back');
    const [ours, theirs] = [makeHandler, deleteAccount.makeHandler].map((make) => make({ env: (name) => ENV[name], fetch, log: () => {} }));
    const requests = [
      ['OPTIONS', { Origin: DASHBOARD_ORIGIN, 'Access-Control-Request-Method': 'POST' }],
      ['OPTIONS', { Origin: 'https://example.test', 'Access-Control-Request-Method': 'POST' }],
      ['POST', { Origin: 'https://example.test', Authorization: 'Bearer a.b.c' }],
      ['GET', { Origin: DASHBOARD_ORIGIN }],
      ['PUT', {}],
      ['POST', { Origin: DASHBOARD_ORIGIN }],
      ['POST', { Origin: DASHBOARD_ORIGIN, Authorization: 'Bearer a.b.c', 'Content-Length': String(MAX_BODY_BYTES + 1) }],
    ];
    for (const [i, [method, headers]] of requests.entries()) {
      const make = () => new Request(ENDPOINT, { method, headers, body: method === 'POST' ? '{}' : undefined });
      const [a, b] = [await ours(make()), await theirs(make())];
      const [bodyA, bodyB] = [await a.text(), await b.text()];
      assert.deepEqual([a.status, Object.fromEntries(a.headers)], [b.status, Object.fromEntries(b.headers)], `request ${i}`);
      // Another site's page is told where to go, in each function's own words; every other answer is the same.
      if (a.status === 403) assert.deepEqual([JSON.parse(bodyA).error, JSON.parse(bodyB).error], ['origin_not_allowed', 'origin_not_allowed']);
      else assert.equal(bodyA, bodyB, `request ${i}`);
    }
  });

  it('the start both share: 401 without a token, 413 past the limit with no more read, else the token and the text; and the settings or what is missing', async () => {
    const logs = [];
    const said = (code) => logs.push(code);
    const request = (headers, body) => new Request(ENDPOINT, { method: 'POST', headers, body });
    const token = { Authorization: 'Bearer a.b.c' };
    assert.deepEqual(await tokenAndBody(request({}, '{}'), 10, said), { refused: { status: 401, body: { error: 'signed_out', message: 'Sign in first.' } } });
    assert.deepEqual(await tokenAndBody(request({ Authorization: 'Basic a.b.c' }, '{}'), 10, said), { refused: { status: 401, body: { error: 'signed_out', message: 'Sign in first.' } } });
    assert.deepEqual(logs, [], 'a request with no token is not logged');
    for (const body of ['{"x":"12345678"}', new Uint8Array(11).fill(32)]) {
      assert.deepEqual(await tokenAndBody(request(token, body), 10, said), { refused: { status: 413, body: { error: 'too_large', message: 'The body is at most 10 bytes.' } } });
    }
    assert.deepEqual(logs, ['too_large', 'too_large']);
    // At the limit exactly, it is read.
    assert.deepEqual(await tokenAndBody(request(token, '{"x":"12"}'), 10, said), { token: 'a.b.c', text: '{"x":"12"}' });
    // Bytes that are not UTF-8, or a length that is not a number: the token, and no text, for the function to turn back.
    assert.deepEqual(await tokenAndBody(request(token, new Uint8Array([0x7b, 0xff, 0x7d])), 10, said), { token: 'a.b.c', text: null });
    assert.deepEqual(await tokenAndBody(request({ ...token, 'Content-Length': 'lots' }, '{}'), 10, said), { token: 'a.b.c', text: null });
    assert.equal(logs.length, 2);

    // A uuid in either case, and nothing else.
    const id = randomUUID();
    assert.ok(UUID.test(id) && UUID.test(id.toUpperCase()));
    for (const junk of ['', 'not-a-uuid', `{${id}}`, `${id}0`, ` ${id}`, id.replace(/-/g, '')]) assert.ok(!UUID.test(junk), `junk ${junk.length}`);

    // The project's address and keys; with one missing, none, and the names of the settings to look at.
    assert.deepEqual(settingsFrom((name) => ENV[name], said), { server: { url: SUPABASE_URL, key: SECRET_KEY }, publishable: PUBLISHABLE });
    for (const missing of ['SUPABASE_URL', 'SUPABASE_SECRET_KEYS', 'SUPABASE_PUBLISHABLE_KEYS']) {
      logs.length = 0;
      assert.equal(settingsFrom((name) => (name === missing ? undefined : ENV[name]), said), null);
      assert.deepEqual(logs, [
        'not set up: SUPABASE_URL, the server key (SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY) or the publishable key (SUPABASE_PUBLISHABLE_KEYS or SUPABASE_ANON_KEY) is missing',
      ]);
    }
  });
});

describe('invite', () => {
  it('invite answers sent whether or not the email has an account, and asks Auth to invite only a new email', async () => {
    // A new email is one no confirmed account has: an address with no account, or one whose account was never
    // confirmed, to which Supabase Auth sends again.
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Kit', last: 'Marlow' }] });
    const row = company.rows['Ana Diaz'];
    const inviteOnce = async (rowId, typed) => {
      const calls = auth.calls.length;
      const answer = await send(auth.tokenFor(company.owner), invite(rowId, typed));
      return { answer, calls: auth.calls.slice(calls) };
    };

    // An address with no account: the invitation is made as the supervisor, the address looked up with the
    // server key, and Supabase Auth asked to invite it, with the company's name and the dashboard's link.
    const fresh = newAddress('ana');
    const first = await inviteOnce(row, fresh);
    assert.deepEqual([first.answer.status, first.answer.body], [200, SENT]);
    assert.deepEqual(routes(first.calls), ['GET /auth/v1/user', 'POST /rest/v1/rpc/invite_supervisor', 'POST /rest/v1/rpc/account_for_email', 'POST /auth/v1/invite']);
    const [whose, made, looked, invited] = first.calls;
    assert.deepEqual([whose.apikey, made.apikey, looked.apikey, invited.apikey], [PUBLISHABLE, PUBLISHABLE, SECRET_KEY, SECRET_KEY]);
    assert.ok(made.authorization !== null && made.authorization === whose.authorization, 'invite_supervisor goes with the supervisor’s own token');
    assert.deepEqual(JSON.parse(made.body), { p_roster_id: row, p_email: fresh });
    assert.deepEqual(JSON.parse(looked.body), { p_email: fresh });
    assert.equal(INVITE_LINK, 'https://app.minemuster.com/?invited=1');
    // The body is the address and data, and the link goes in the query, where Supabase Auth reads it.
    assert.deepEqual(JSON.parse(invited.body), { email: fresh, data: { company_name: 'Test Pit A' } });
    assert.deepEqual(auth.invites.at(-1), { email: fresh, data: { company_name: 'Test Pit A' }, redirect_to: INVITE_LINK });
    // Auth made the address's account, not confirmed until its link is opened; nobody is put on the row.
    assert.deepEqual(await confirmedAt(fresh), [false]);
    const open = await openOn(row);
    assert.deepEqual([open.email, open.invited_by], [fresh, company.owner]);
    assert.equal((await rosterRow(db, row)).user_id, null);

    // Again, while that account is not confirmed: Auth is asked again and sends again, and the new invitation
    // takes the old one's place.
    const second = await inviteOnce(row, fresh);
    assert.equal(invitesOf(second.calls), 1);
    assert.notEqual((await openOn(row)).id, open.id);
    assert.deepEqual(await confirmedAt(fresh), [false]);

    // An account never confirmed, however it came about, is sent one too, at the address as the database keeps
    // it, however it was typed.
    const unconfirmed = newAddress('kit');
    await accountWith(unconfirmed, { confirmed: false });
    const third = await inviteOnce(company.rows['Kit Marlow'], asTyped(unconfirmed));
    assert.equal(invitesOf(third.calls), 1);
    assert.deepEqual(JSON.parse(third.calls.at(-1).body), { email: unconfirmed, data: { company_name: 'Test Pit A' } });
    assert.equal((await openOn(company.rows['Kit Marlow'])).email, unconfirmed);

    // A confirmed account is never sent one: Auth is not asked, and the invitation waits on the dashboard until
    // the account signs in. So too once the first address's account is confirmed.
    const confirmed = newAddress('lee');
    await accountWith(confirmed);
    const fourth = await inviteOnce(row, asTyped(confirmed));
    assert.deepEqual(routes(fourth.calls), ['GET /auth/v1/user', 'POST /rest/v1/rpc/invite_supervisor', 'POST /rest/v1/rpc/account_for_email']);
    assert.equal((await openOn(row)).email, confirmed);
    await confirmAt(fresh);
    const fifth = await inviteOnce(row, fresh);
    assert.equal(invitesOf(fifth.calls), 0);
    assert.equal((await openOn(row)).email, fresh);

    // The inviter's answer is the same every time.
    for (const { answer } of [first, second, third, fourth, fifth]) assert.deepEqual([answer.status, answer.body], [200, SENT]);
  });

  it("invite refuses a caller who is not a supervisor of the row's company", async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, {
      roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }, { first: 'Lee', last: 'Park' }],
    });
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'], roster: [{ first: 'Jo', last: 'Vale', role: 'supervisor' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const lee = await newMember(db, company, 'Lee', 'Park');
    said.accounts.push(lee);
    // A supervisor who stepped down is no longer one.
    const kit = await secondSupervisor(db, company, 'Kit', 'Marlow');
    said.accounts.push(kit);
    await db.as(company.owner).query("update public.roster set role = 'employee' where id = $1", [company.rows['Kit Marlow']]);
    const row = company.rows['Ana Diaz'];
    const calls = auth.calls.length;

    // To anyone who is not a supervisor of the row's company, the row is not there, word for word as an id
    // nobody has.
    const madeUp = await send(auth.tokenFor(company.owner), invite(nobody(), newAddress('ana')));
    assert.deepEqual([madeUp.status, madeUp.body], [404, { error: 'not_found', message: 'No such roster row.' }]);
    for (const [caller, rowId] of [
      [riley, row],
      [lee, row],
      [kit, row],
      [other.owner, row],
      [company.owner, other.rows['Jo Vale']],
      [other.owner, nobody()],
    ]) {
      const answer = await send(auth.tokenFor(caller), invite(rowId, newAddress('ana')));
      assert.deepEqual([answer.status, answer.body], [madeUp.status, madeUp.body]);
    }
    // Nothing was made, and no address was looked up or sent an email.
    assert.deepEqual(await invitationsOn(row), []);
    assert.deepEqual(await invitationsOn(other.rows['Jo Vale']), []);
    assert.ok(routes(auth.calls.slice(calls)).every((route) => route === 'GET /auth/v1/user' || route === 'POST /rest/v1/rpc/invite_supervisor'));
  });

  it('invite refuses a row taken and an address that is not one, and sends nothing', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, {
      roster: [{ first: 'Lee', last: 'Park' }, { first: 'Kit', last: 'Marlow' }, { first: 'Ana', last: 'Diaz', role: 'supervisor' }],
    });
    said.accounts.push(await newMember(db, company, 'Lee', 'Park'));
    await takeOff(company, company.rows['Kit Marlow']);
    const owner = () => auth.tokenFor(company.owner);
    // A row an email account holds (the supervisor's own, or a crew member's, whom a role change makes a
    // supervisor), and a row taken off the roster.
    for (const rowId of [company.rows['Lee Park'], company.ownRow, company.rows['Kit Marlow']]) {
      const answer = await send(owner(), invite(rowId, newAddress('ana')));
      assert.deepEqual([answer.status, answer.body.error], [409, 'row_taken']);
      assert.deepEqual(await invitationsOn(rowId), []);
    }
    // Something that is not an email address.
    for (const email of ['', 'not an address', 'ana@example', '@example.test', `${'a'.repeat(250)}@example.test`]) {
      const answer = await send(owner(), invite(company.rows['Ana Diaz'], email));
      assert.deepEqual([answer.status, answer.body], [400, { error: 'bad_request', message: 'Type the email address to send the invitation to.' }]);
    }
    assert.deepEqual(await invitationsOn(company.rows['Ana Diaz']), []);
    assert.ok(!auth.calls.some((c) => c.path === '/auth/v1/invite' || c.path === '/rest/v1/rpc/account_for_email'));
  });
});

describe('resend', () => {
  it('resend sends again only for an open invitation', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, {
      roster: [
        { first: 'Ana', last: 'Diaz', role: 'supervisor' },
        { first: 'Kit', last: 'Marlow', role: 'supervisor' },
        { first: 'Jo', last: 'Vale', role: 'supervisor' },
        { first: 'Bo', last: 'Ellison', role: 'supervisor' },
        { first: 'Riley J', last: 'Quinn' },
      ],
    });
    const lee = await secondSupervisor(db, company, 'Lee', 'Park');
    said.accounts.push(lee);
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'], roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }] });
    const owner = () => auth.tokenFor(company.owner);
    const inviteOnto = async (name, email) => {
      assert.deepEqual((await send(owner(), invite(company.rows[name], email))).body, SENT);
      return openOn(company.rows[name]);
    };

    // An open invitation to an address whose account is not confirmed: sent again, good for 7 days from now, and
    // vouched for from then on by the supervisor who sent it again.
    const anaAddress = newAddress('ana');
    const ana = await inviteOnto('Ana Diaz', anaAddress);
    await db.admin("update public.supervisor_invitations set expires_at = now() + interval '1 day' where id = $1", [ana.id]);
    let calls = auth.calls.length;
    const again = await send(auth.tokenFor(lee), resend(ana.id));
    assert.deepEqual([again.status, again.body], [200, SENT]);
    assert.deepEqual(routes(auth.calls.slice(calls)), ['GET /auth/v1/user', 'POST /rest/v1/rpc/resend_supervisor_invitation', 'POST /rest/v1/rpc/account_for_email', 'POST /auth/v1/invite']);
    const [, renewed, looked, invited] = auth.calls.slice(calls);
    assert.deepEqual([renewed.apikey, looked.apikey, invited.apikey], [PUBLISHABLE, SECRET_KEY, SECRET_KEY]);
    assert.deepEqual(JSON.parse(renewed.body), { p_invitation_id: ana.id });
    assert.deepEqual(auth.invites.at(-1), { email: anaAddress, data: { company_name: 'Test Pit A' }, redirect_to: INVITE_LINK });
    const now = await openOn(company.rows['Ana Diaz']);
    assert.deepEqual([now.id, now.invited_by], [ana.id, lee]);
    assert.ok(daysAhead(now.expires_at) > 6.9, 'good for 7 days more');

    // Once the address's account is confirmed, it is renewed and nothing is sent: it waits on the dashboard.
    await confirmAt(anaAddress);
    calls = auth.calls.length;
    assert.deepEqual((await send(owner(), resend(ana.id))).body, SENT);
    assert.equal(invitesOf(auth.calls.slice(calls)), 0);
    assert.equal((await openOn(company.rows['Ana Diaz'])).invited_by, company.owner);

    // Closed, by expiring, by being cancelled or by being accepted: refused, and nothing is sent.
    const kit = await inviteOnto('Kit Marlow', newAddress('kit'));
    await db.admin("update public.supervisor_invitations set expires_at = now() - interval '1 second' where id = $1", [kit.id]);
    const jo = await inviteOnto('Jo Vale', newAddress('jo'));
    await db.as(company.owner).call('cancel_supervisor_invitation', { p_invitation_id: jo.id });
    const [{ id: anaAccount }] = await db.adminRows('select id from auth.users where email = $1', [anaAddress]);
    said.accounts.push(anaAccount);
    assert.equal((await db.as(anaAccount).call('accept_supervisor_invitation', { p_invitation_id: ana.id })).company_id, company.id);
    // Taken off the roster while it is open: its row is no longer one to invite onto.
    const bo = await inviteOnto('Bo Ellison', newAddress('bo'));
    await takeOff(company, company.rows['Bo Ellison']);
    // An invitation of another company's, one nobody has, and anyone who is not a supervisor of its company.
    const theirs = await db.as(other.owner).call('invite_supervisor', { p_roster_id: other.rows['Ana Diaz'], p_email: newAddress('ana') });

    calls = auth.calls.length;
    for (const id of [kit.id, jo.id, ana.id]) {
      const answer = await send(owner(), resend(id));
      assert.deepEqual([answer.status, answer.body], [409, { error: 'invitation_closed', message: 'That invitation has expired, or was cancelled or accepted.' }]);
    }
    const taken = await send(owner(), resend(bo.id));
    assert.deepEqual([taken.status, taken.body.error], [409, 'row_taken']);
    const madeUp = await send(owner(), resend(nobody()));
    assert.deepEqual([madeUp.status, madeUp.body], [404, { error: 'not_found', message: 'No such invitation.' }]);
    for (const [caller, id] of [
      [company.owner, theirs.invitation_id],
      [riley, bo.id],
      [other.owner, kit.id],
    ]) {
      const answer = await send(auth.tokenFor(caller), resend(id));
      assert.deepEqual([answer.status, answer.body], [madeUp.status, madeUp.body]);
    }
    assert.ok(routes(auth.calls.slice(calls)).every((route) => route === 'GET /auth/v1/user' || route === 'POST /rest/v1/rpc/resend_supervisor_invitation'));
    // The expired one is still expired: a refused resend renews nothing.
    assert.ok(daysAhead((await invitationsOn(company.rows['Kit Marlow']))[0].expires_at) < 0);
  });
});

describe('the same answer', () => {
  it('invite and resend answer sent for every address and whatever Auth answers, and the invitation stays', async () => {
    const { send, auth, logged } = handler();
    const company = await startCompany(db, { name: 'Test Pit E' });
    const owner = () => auth.tokenFor(company.owner);
    // What the address is, the call made to answer otherwise than it would, whether Auth's invite is asked, and
    // what the log says: the answer is the same, and the log, never seen by the inviter, says what happened,
    // by its code.
    const cases = [
      { what: 'no account', address: 'none', asked: true, log: 'sent, with the invite email, to an address with no account' },
      { what: 'an unconfirmed account', address: 'unconfirmed', asked: true, log: 'sent, with the invite email, to an address with an account not confirmed' },
      { what: 'a confirmed account', address: 'confirmed', asked: false, log: "sent, with no invite email: the address's account is confirmed, and the invitation waits on the dashboard" },
      { what: 'Auth answering 429', address: 'none', route: 'invite', reply: () => json(429, TOO_MANY), asked: true, log: 'sent, but the invite email answered 429 over_email_send_rate_limit' },
      {
        what: 'Auth answering 500',
        address: 'none',
        route: 'invite',
        reply: () => json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Error sending invite email' }),
        asked: true,
        log: 'sent, but the invite email answered 500 unexpected_failure',
      },
      { what: 'Auth giving no answer', address: 'none', route: 'invite', reply: NO_ANSWER, asked: true, log: 'sent, but the invite email got no answer' },
      {
        what: 'Auth’s own refusal of a confirmed address',
        address: 'none',
        route: 'invite',
        reply: () => json(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' }),
        asked: true,
        log: 'sent, but the invite email answered 422 email_exists',
      },
      {
        what: 'the account not found out',
        address: 'unconfirmed',
        route: 'rpc:account_for_email',
        reply: () => json(500, { code: 'XX000', message: 'internal error', details: null, hint: null }),
        asked: false,
        log: 'sent, with no invite email: account_for_email answered 500 XX000',
      },
      {
        what: 'the account found out as nothing this can read',
        address: 'none',
        route: 'rpc:account_for_email',
        reply: () => json(200, { user_id: null }),
        asked: false,
        log: 'sent, with no invite email: account_for_email answered something this cannot read',
      },
    ];
    const answers = [];
    for (const action of ['invite', 'resend']) {
      for (const { what, address, route, reply, asked, log } of cases) {
        const label = `${action}, ${what}`;
        const email = newAddress('pat');
        if (address !== 'none') await accountWith(email, { confirmed: address === 'confirmed' });
        const rowId = await addToRoster(db, company.owner, company.id, { first: 'Pat', last: 'Cole', role: 'supervisor' });
        // For resend, an invitation made by the database alone: no email went with it, so the address is as it was.
        const made = action === 'resend' ? await db.as(company.owner).call('invite_supervisor', { p_roster_id: rowId, p_email: email }) : null;
        if (route) auth.when(route, reply);
        const calls = auth.calls.length;
        const lines = logged.length;
        const answer = await send(owner(), action === 'invite' ? invite(rowId, email) : resend(made.invitation_id));
        if (route) auth.when(route, null);
        answers.push([label, answer]);
        assert.equal(invitesOf(auth.calls.slice(calls)), asked ? 1 : 0, label);
        assert.deepEqual(logged.slice(lines), [`supervisor-tools: ${action} ${log}`], label);
        // The invitation is open, for the address, either way: Send again sends it once more.
        const open = await openOn(rowId);
        assert.ok(open !== null && open.email === email, label);
        if (made) assert.equal(open.id, made.invitation_id, label);
      }
    }
    // The same status, body and headers every time, however the address and Auth stood.
    const [, first] = answers[0];
    for (const [label, answer] of answers) {
      assert.deepEqual([answer.status, answer.body], [200, SENT], label);
      assert.deepEqual([...answer.headers], [...first.headers], label);
    }
  });
});

describe('delete_crew_sign_in', () => {
  it("delete_crew_sign_in deletes a passcode account of the caller's company, and nothing else", async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, {
      roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }, { first: 'Lee', last: 'Park' }, { first: 'Jo', last: 'Vale' }],
    });
    const ana = await secondSupervisor(db, company, 'Ana', 'Diaz');
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'], roster: [{ first: 'Bo', last: 'Ellison' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const kit = await crewMember(company, 'Kit', 'Marlow');
    await takeOff(company, company.rows['Kit Marlow']);
    const lee = await newMember(db, company, 'Lee', 'Park');
    const bo = await crewMember(other, 'Bo', 'Ellison');
    said.accounts.push(ana, lee);
    const everyone = [company.owner, ana, riley, kit, lee, other.owner, bo];

    // To anyone who is not a supervisor of the row's company the row is not there, word for word as an id nobody
    // has; and a row of their own company that no passcode account holds has no sign-in to delete.
    const madeUp = await send(auth.tokenFor(company.owner), deleteSignIn(nobody()));
    assert.deepEqual([madeUp.status, madeUp.body], [404, { error: 'not_found', message: 'No such roster row.' }]);
    for (const [caller, rowId] of [
      [company.owner, other.rows['Bo Ellison']],
      [ana, other.rows['Bo Ellison']],
      [other.owner, company.rows['Riley J Quinn']],
      [riley, company.rows['Kit Marlow']],
      [lee, company.rows['Riley J Quinn']],
      [bo, company.rows['Riley J Quinn']],
    ]) {
      const answer = await send(auth.tokenFor(caller), deleteSignIn(rowId));
      assert.deepEqual([answer.status, answer.body], [madeUp.status, madeUp.body]);
    }
    for (const rowId of [company.rows['Lee Park'], company.rows['Jo Vale'], company.ownRow, company.rows['Ana Diaz']]) {
      const answer = await send(auth.tokenFor(company.owner), deleteSignIn(rowId));
      assert.deepEqual([answer.status, answer.body], [409, { error: 'not_a_passcode_account', message: 'That roster row has no passcode sign-in.' }]);
    }
    assert.deepEqual(adminDeletes(auth.calls), []);
    for (const account of everyone) assert.ok(await accountExists(account));

    // A supervisor of the company deletes the passcode account on its row, on the roster or taken off it: found
    // as the supervisor, deleted with the server key, and that account alone.
    const calls = auth.calls.length;
    const deleted = await send(auth.tokenFor(company.owner), deleteSignIn(company.rows['Riley J Quinn']));
    assert.deepEqual([deleted.status, deleted.body], [200, DELETED]);
    assert.deepEqual(routes(auth.calls.slice(calls)), ['GET /auth/v1/user', 'POST /rest/v1/rpc/crew_sign_in_to_delete', `DELETE /auth/v1/admin/users/${riley}`]);
    const [whose, found, removed] = auth.calls.slice(calls);
    assert.ok(found.apikey === PUBLISHABLE && found.authorization === whose.authorization, 'found with the supervisor’s own token');
    assert.deepEqual(JSON.parse(found.body), { p_roster_id: company.rows['Riley J Quinn'] });
    assert.equal(removed.apikey, SECRET_KEY);
    assert.deepEqual((await send(auth.tokenFor(ana), deleteSignIn(company.rows['Kit Marlow']))).body, DELETED);
    assert.deepEqual((await send(auth.tokenFor(other.owner), deleteSignIn(other.rows['Bo Ellison']))).body, DELETED);
    assert.deepEqual(adminDeletes(auth.calls).map((c) => c.path), [riley, kit, bo].map((id) => `/auth/v1/admin/users/${id}`));
    for (const account of [riley, kit, bo]) assert.equal(await accountExists(account), false);
    for (const account of [company.owner, ana, lee, other.owner]) assert.ok(await accountExists(account));
    // Deleted, the row has no passcode sign-in left to delete.
    const again = await send(auth.tokenFor(company.owner), deleteSignIn(company.rows['Riley J Quinn']));
    assert.deepEqual([again.status, again.body.error], [409, 'not_a_passcode_account']);
    assert.equal(adminDeletes(auth.calls).length, 3);
  });

  it('delete_crew_sign_in leaves the row with no account, so the person can sign up for it again', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const rowId = company.rows['Riley J Quinn'];
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const shift = { id: 'sh-1', employeeId: 'emp-1', clockIn: 1763300000000, clockOut: null, edits: [] };
    await db.as(riley).call('push_records', { company_id: company.id, changes: JSON.stringify([{ key: 'shift:sh-1', kind: 'shift', id: 'sh-1', rev: revOf(shift), record: shift }]) });
    const phone = auth.tokenFor(riley);

    const answer = await send(auth.tokenFor(company.owner), deleteSignIn(rowId));
    assert.deepEqual([answer.status, answer.body], [200, DELETED]);
    // The row stays on the roster with nobody on it, and the record stays with the company, the link to the
    // account cleared. The passcode went with the account, and the phone's session is signed out for good.
    const [row] = await db.adminRows('select user_id, active, role, first_name, last_name from public.roster where id = $1', [rowId]);
    assert.deepEqual(row, { user_id: null, active: true, role: 'employee', first_name: 'Riley J', last_name: 'Quinn' });
    const [kept] = await db.adminRows("select created_by from public.records where company_id = $1 and kind = 'shift' and id = 'sh-1'", [company.id]);
    assert.deepEqual(kept, { created_by: null });
    assert.deepEqual(await db.adminRows('select user_id from public.crew_logins where user_id = $1', [riley]), []);
    assert.equal(await auth.accountOf(phone), null);

    // Signing up again: crew-auth's check finds the name free to sign up with, and a new passcode account
    // joins onto the same row.
    const check = await db.serviceRole().call('crew_sign_up_check', { p_code: company.code, p_first: 'Riley', p_last: 'Quinn', p_passcode: PASSCODE, p_address: '2001:db8:9::1' });
    assert.equal(check.status, 'ok');
    const back = await crewMember(company, 'Riley', 'Quinn');
    assert.notEqual(back, riley);
    assert.equal((await rosterRow(db, rowId)).user_id, back);
  });

  it('delete_crew_sign_in answers 500 try_again when the admin delete fails, and deleted when the account is gone already', async () => {
    const { send, auth, logged } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const kit = await crewMember(company, 'Kit', 'Marlow');
    const owner = () => auth.tokenFor(company.owner);
    /** What a delete is answered, and what it logs, by its code. */
    const deleting = async (name) => {
      const lines = logged.length;
      const answer = await send(owner(), deleteSignIn(company.rows[name]));
      return { answer, said: logged.slice(lines) };
    };
    for (const [i, [failure, log]] of [
      [() => json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error deleting user' }), 'the admin delete answered 500 unexpected_failure'],
      [NO_ANSWER, 'the admin delete got no answer'],
      [() => json(504, { message: 'The upstream server is timing out' }), 'the admin delete answered 504'],
      [() => json(404, { message: 'no Route matched with those values' }), 'the admin delete answered 404'],
    ].entries()) {
      auth.when('admin_delete', failure);
      const { answer, said: lines } = await deleting('Riley J Quinn');
      assert.deepEqual([answer.status, answer.body.error], [500, 'try_again'], `failure ${i}`);
      assert.deepEqual(lines, [`supervisor-tools: delete_crew_sign_in: ${log}`], `failure ${i}`);
      assert.ok(await accountExists(riley));
    }
    // Deleted meanwhile, by the person themselves: Supabase Auth has no such account, and the sign-in is gone all the same.
    auth.when('admin_delete', async (_call, { id }) => {
      await db.admin('delete from auth.users where id = $1', [id]);
      return null;
    });
    const gone = await deleting('Kit Marlow');
    assert.deepEqual([gone.answer.status, gone.answer.body, gone.said], [200, DELETED, ['supervisor-tools: delete_crew_sign_in deleted (Supabase Auth had no such account any more)']]);
    assert.equal(await accountExists(kit), false);
    auth.when('admin_delete', null);
    // With nothing in the way, it goes through.
    const done = await deleting('Riley J Quinn');
    assert.deepEqual([done.answer.body, done.said], [DELETED, ['supervisor-tools: delete_crew_sign_in deleted']]);
    assert.equal(await accountExists(riley), false);
  });
});

describe('the calls it makes', () => {
  it('answers 500 try_again when Supabase Auth cannot be reached', async () => {
    const { ask, logged } = serveFunction(makeHandler, db, { said, fetch: NO_ANSWER });
    for (const body of [invite(nobody(), newAddress('ana')), resend(nobody()), deleteSignIn(nobody())]) {
      const answer = await ask(post('a.b.c', body));
      assert.deepEqual([answer.status, answer.body.error], [500, 'try_again']);
    }
    assert.equal(logged.length, 3);
  });

  it('answers by what PostgREST and Supabase Auth say: 401 for a token turned down, 500 for anything it does not know', async () => {
    const { send, auth, logged } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }] });
    const riley = await crewMember(company, 'Riley', 'Quinn');
    const owner = () => auth.tokenFor(company.owner);
    const row = company.rows['Ana Diaz'];
    const rileyRow = company.rows['Riley J Quinn'];
    /** A request with a test's answer in place of a route's, and what it logs. */
    const asking = async (route, reply, body) => {
      auth.when(route, reply);
      const lines = logged.length;
      const answer = await send(owner(), body);
      auth.when(route, null);
      return { answer, said: logged.slice(lines) };
    };

    // Supabase Auth turning the request down with no reason of its own, such as the gateway refusing the key, is a
    // setup problem; out of reach, it is try_again.
    const refused = await asking('user', () => json(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }), resend(nobody()));
    assert.deepEqual([refused.answer.status, refused.answer.body.error], [500, 'not_set_up']);
    assert.deepEqual(refused.said, ['supervisor-tools: resend: auth turned the request down with no reason of its own (401): is the publishable key right?']);
    const down = await asking('user', () => json(503, { message: 'upstream connect error' }), resend(nobody()));
    assert.deepEqual([down.answer.status, down.answer.body.error, down.said], [500, 'try_again', ['supervisor-tools: resend: auth answered 503']]);

    // A token PostgREST turns down (it expired since Auth was asked), and the database's 42501, are signed out.
    for (const [action, fn, body] of [
      ['invite', 'invite_supervisor', invite(row, newAddress('ana'))],
      ['resend', 'resend_supervisor_invitation', resend(nobody())],
      ['delete_crew_sign_in', 'crew_sign_in_to_delete', deleteSignIn(rileyRow)],
    ]) {
      for (const [reply, code] of [
        [() => json(401, { code: 'PGRST303', message: 'JWT expired', details: null, hint: null }), '401 PGRST303'],
        [() => json(403, { code: '42501', message: 'Sign in first.', details: null, hint: null }), '403 42501'],
      ]) {
        const { answer, said: lines } = await asking(`rpc:${fn}`, reply, body);
        assert.deepEqual([answer.status, answer.body.error], [401, 'signed_out'], fn);
        assert.deepEqual(lines, [`supervisor-tools: ${action} signed_out (${fn} answered ${code})`]);
      }
    }

    // What the database answers that this does not know is try_again, and nothing is sent or deleted. The log
    // says what it answered, by its codes.
    const internal = () => json(500, { code: 'XX000', message: 'internal error', details: null, hint: null });
    const unread = 'answered something this cannot read';
    for (const [i, [route, body, reply, log]] of [
      ['rpc:invite_supervisor', invite(row, newAddress('ana')), internal, 'invite: invite_supervisor answered 500 XX000'],
      ['rpc:invite_supervisor', invite(row, newAddress('ana')), NO_ANSWER, 'invite: invite_supervisor got no answer'],
      [
        'rpc:invite_supervisor',
        invite(row, newAddress('ana')),
        () => json(404, { code: 'PGRST202', message: 'Could not find the function', details: null, hint: null }),
        'invite: invite_supervisor answered 404 PGRST202',
      ],
      [
        'rpc:invite_supervisor',
        invite(row, newAddress('ana')),
        () => json(409, { code: 'PT409', message: 'Something new.', details: null, hint: 'something_new' }),
        'invite: invite_supervisor answered 409 PT409 something_new',
      ],
      // A hint of another action's refusals.
      [
        'rpc:invite_supervisor',
        invite(row, newAddress('ana')),
        () => json(409, { code: 'PT409', message: 'That invitation has expired.', details: null, hint: 'invitation_closed' }),
        'invite: invite_supervisor answered 409 PT409 invitation_closed',
      ],
      ['rpc:invite_supervisor', invite(row, newAddress('ana')), () => json(200, { invitation_id: randomUUID(), company_name: 'Test Pit A' }), `invite: invite_supervisor ${unread}`],
      ['rpc:resend_supervisor_invitation', resend(nobody()), internal, 'resend: resend_supervisor_invitation answered 500 XX000'],
      ['rpc:resend_supervisor_invitation', resend(nobody()), () => json(200, { email: newAddress('ana') }), `resend: resend_supervisor_invitation ${unread}`],
      ['rpc:crew_sign_in_to_delete', deleteSignIn(rileyRow), internal, 'delete_crew_sign_in: crew_sign_in_to_delete answered 500 XX000'],
      [
        'rpc:crew_sign_in_to_delete',
        deleteSignIn(rileyRow),
        () => json(409, { code: 'PT409', message: 'That roster row is taken.', details: null, hint: 'row_taken' }),
        'delete_crew_sign_in: crew_sign_in_to_delete answered 409 PT409 row_taken',
      ],
      ['rpc:crew_sign_in_to_delete', deleteSignIn(rileyRow), () => json(200, 'not an account'), `delete_crew_sign_in: crew_sign_in_to_delete ${unread}`],
      ['rpc:crew_sign_in_to_delete', deleteSignIn(rileyRow), () => json(204), `delete_crew_sign_in: crew_sign_in_to_delete ${unread}`],
    ].entries()) {
      const { answer, said: lines } = await asking(route, reply, body);
      assert.deepEqual([answer.status, answer.body], [500, { error: 'try_again', message: 'That did not go through just now. Try again in a few minutes.' }], `answer ${i}`);
      assert.deepEqual(lines, [`supervisor-tools: ${log}`], `answer ${i}`);
    }
    assert.ok(!auth.calls.some((c) => c.path === '/auth/v1/invite' || c.path === '/rest/v1/rpc/account_for_email'));
    assert.deepEqual(adminDeletes(auth.calls), []);
    assert.ok(await accountExists(riley));
    assert.deepEqual(await invitationsOn(row), []);
  });

  it('gives every call to Supabase Auth and the database 15 seconds, and calls each database function by POST', async () => {
    assert.equal(CALL_TIMEOUT_MS, 15_000);
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }] });
    await crewMember(company, 'Riley', 'Quinn');
    const owner = () => auth.tokenFor(company.owner);
    const limits = [];
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => {
      limits.push(ms);
      return timeout.call(AbortSignal, ms);
    };
    try {
      await send(owner(), invite(company.rows['Ana Diaz'], newAddress('ana')));
      await send(owner(), resend((await openOn(company.rows['Ana Diaz'])).id));
      await send(owner(), deleteSignIn(company.rows['Riley J Quinn']));
    } finally {
      AbortSignal.timeout = timeout;
    }
    assert.deepEqual([...new Set(auth.calls.map((c) => `${c.method} ${c.path.replace(/[0-9a-f-]{36}$/, '<id>')}`))].sort(), [
      'DELETE /auth/v1/admin/users/<id>',
      'GET /auth/v1/user',
      'POST /auth/v1/invite',
      'POST /rest/v1/rpc/account_for_email',
      'POST /rest/v1/rpc/crew_sign_in_to_delete',
      'POST /rest/v1/rpc/invite_supervisor',
      'POST /rest/v1/rpc/resend_supervisor_invitation',
    ]);
    assert.ok(auth.calls.every((c) => c.signal instanceof AbortSignal), 'each call has a time limit');
    assert.equal(limits.length, auth.calls.length);
    assert.ok(limits.every((ms) => ms === CALL_TIMEOUT_MS), 'of 15 seconds');
  });
});

describe('what it says', () => {
  it('never logs an email, a name, a token, a key or an id', async () => {
    const { send, auth, logged } = handler();
    const company = await startCompany(db, {
      name: 'Test Pit L',
      roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }, { first: 'Lee', last: 'Park' }],
    });
    await crewMember(company, 'Riley', 'Quinn');
    said.accounts.push(await newMember(db, company, 'Lee', 'Park'));
    const owner = () => auth.tokenFor(company.owner);
    const row = company.rows['Ana Diaz'];
    const rileyRow = company.rows['Riley J Quinn'];
    const confirmed = newAddress('lee');
    await accountWith(confirmed);
    const answers = [];
    /** A request, and something said of it, unless it has no token: that is turned back before anything, as delete-account turns one back, unlogged. */
    const run = async (token, body, options) => {
      const lines = logged.length;
      answers.push(await send(token, body, options));
      if (token) assert.ok(logged.length > lines, `something is said of request ${answers.length}`);
    };
    const failing = async (route, reply, work) => {
      auth.when(route, reply);
      await work();
      auth.when(route, null);
    };

    // Every action, and every way each can go: sent with an email or with none, refused, failed, deleted.
    await run(owner(), invite(row, asTyped(newAddress('ana'))));
    await run(owner(), invite(row, confirmed));
    await failing('invite', () => json(429, TOO_MANY), () => run(owner(), invite(row, newAddress('ana'))));
    // Auth's words for an address it will not send to hold the address: only the code is logged.
    const refusedAddress = newAddress('ana');
    await failing('invite', () => json(400, { code: 400, error_code: 'email_address_not_authorized', msg: `Email address "${refusedAddress}" cannot be used as it is not authorized` }), () => run(owner(), invite(row, refusedAddress)));
    await failing('invite', NO_ANSWER, () => run(owner(), invite(row, newAddress('ana'))));
    await failing('rpc:account_for_email', () => json(500, { code: 'XX000', message: 'internal error', details: null, hint: null }), () => run(owner(), invite(row, newAddress('ana'))));
    await run(owner(), invite(company.rows['Lee Park'], newAddress('lee')));
    await run(owner(), invite(row, 'not an address'));
    await run(auth.tokenFor(company.owner), invite(nobody(), newAddress('riley')));
    const open = await openOn(row);
    await run(owner(), resend(open.id));
    await run(owner(), resend(nobody()));
    await db.admin("update public.supervisor_invitations set expires_at = now() - interval '1 second' where id = $1", [open.id]);
    await run(owner(), resend(open.id));
    await failing('admin_delete', () => json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error deleting user' }), () => run(owner(), deleteSignIn(rileyRow)));
    await run(owner(), deleteSignIn(rileyRow));
    await run(owner(), deleteSignIn(rileyRow));
    await run(owner(), deleteSignIn(nobody()));
    await run(null, invite(row, newAddress('ana')));
    await run(owner(), { ...invite(row, newAddress('ana')), user_id: company.owner });
    await run(owner(), invite(row, newAddress('ana')), { origin: 'https://example.test' });
    assert.equal(answers.length, 19);

    // Over every test in this file, this one last: no log holds anything any test sent (the addresses typed, the
    // ids, the tokens), nor any token the stand-ins minted, nor a key, nor any account's, company's, row's or
    // invitation's id or address, nor any company's code or name, nor, as a word, any name on any roster.
    const allLogs = said.logs.join('\n');
    const lowered = allLogs.toLowerCase();
    const { texts, names } = await whatNoLogHolds();
    assert.ok(texts.size > 100 && names.size > 10, `${texts.size} values and ${names.size} names looked for`);
    for (const [i, text] of [...texts].entries()) assert.ok(!lowered.includes(text.toLowerCase()), `a log holds value ${i}`);
    for (const name of names) assert.doesNotMatch(allLogs, new RegExp(`\\b${name}\\b`, 'i'));
    // Nor does any answer in this file.
    const allBodies = said.bodies.join('\n').toLowerCase();
    for (const [i, text] of [...texts].entries()) assert.ok(!allBodies.includes(text.toLowerCase()), `an answer holds value ${i}`);
  });
});

/**
 * What no log may hold, from every test in this file: each text a test sent but the action, each bearer token
 * it sent, each token the stand-ins minted, the keys, every account a test made or the database has (its id and
 * address), every account an admin delete named, every company's id, code and name, every roster row's id, and
 * every invitation's id and address; and, as words, every name on any roster.
 */
async function whatNoLogHolds() {
  const texts = new Set([SECRET_KEY, PUBLISHABLE, ...said.minted, ...said.accounts]);
  for (const { body, raw, headers } of said.sent) {
    let fields = body;
    if (typeof raw === 'string') {
      try {
        fields = JSON.parse(raw);
      } catch {
        fields = null;
      }
    }
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      for (const [key, value] of Object.entries(fields)) if (key !== 'action' && typeof value === 'string' && value.trim().length >= 4) texts.add(value.trim());
    }
    if (headers.Authorization) texts.add(headers.Authorization.replace(/^Bearer\s+/, ''));
  }
  for (const auth of stands) for (const call of adminDeletes(auth.calls)) texts.add(decodeURIComponent(call.path.slice('/auth/v1/admin/users/'.length)));
  for (const { id, email } of await db.adminRows('select id::text as id, email from auth.users')) {
    texts.add(id);
    if (email) texts.add(email);
  }
  for (const { id, join_code, name } of await db.adminRows('select id::text as id, join_code, name from public.companies')) for (const value of [id, join_code, name]) texts.add(value);
  for (const { id, email } of await db.adminRows('select id::text as id, email from public.supervisor_invitations')) for (const value of [id, email]) texts.add(value);
  const names = new Set();
  for (const { id, first_name, last_name } of await db.adminRows('select id::text as id, first_name, last_name from public.roster')) {
    texts.add(id);
    for (const word of `${first_name} ${last_name}`.split(/\s+/).map((w) => w.replace(/^\W+|\W+$/g, ''))) if (word.length >= 2) names.add(word.toLowerCase());
  }
  return { texts, names };
}
