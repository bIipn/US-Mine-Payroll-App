// The crew-auth edge function (supabase/functions/crew-auth), run under Node: Node strips the types from
// its .ts files, and there is no Deno here. A stand-in for fetch plays Supabase over the local database,
// as delete_account.db.mjs's does: PostgREST's /rest/v1/rpc/* (by POST only, since a GET would run a
// function in a read-only transaction), Supabase Auth's /auth/v1/user and its admin delete, answering as
// that file describes, and besides them
//   POST /auth/v1/admin/users                makes the account, an auth.users row whose address is
//                                            confirmed when email_confirm is true, and answers the user;
//   POST /auth/v1/token?grant_type=password  signs in when the password is the one crew_login_password
//                                            works out in the database for the address (and the one the
//                                            account was made with), answering a session whose access
//                                            token carries a password entry in its amr; 400
//                                            invalid_credentials otherwise, and 429
//                                            over_request_rate_limit while a test turns that switch on;
//   POST /auth/v1/logout?scope=others        signs out every other session of the token's account.
// Those three answer in the shapes of Supabase Auth's API (the user; { access_token, token_type,
// expires_in, expires_at, refresh_token, user }; 204), which no live or local Auth has been asked here.
//
// The keys, tokens, ids, names, passcodes, codes and addresses here are made up (the addresses are from
// the ranges kept for documentation). No test message names a passcode, an address or a login: the
// tests assert on them.

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { addToRoster, join, newMember, NOT_FOUND, refused, startCompany, startDatabase } from './harness.mjs';

const FUNCTION = new URL('../functions/crew-auth/', import.meta.url);
const { CREW_DOMAIN, MAX_BODY_BYTES, clientAddress, makeHandler } = await import(new URL('handler.ts', FUNCTION));
const { CALL_TIMEOUT_MS } = await import(new URL('../functions/_shared/http.ts', import.meta.url));

const URL_ = 'https://project.example.test';
const ENDPOINT = `${URL_}/functions/v1/crew-auth`;
const PUBLISHABLE = 'sb_publishable_test_madeup';
const SECRET_KEY = 'sb_secret_test_madeup';
const ENV = { SUPABASE_URL: URL_, SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }), SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }) };
const NOW = 1795000000;
const MINUTE = 60 * 1000;

// Three that pass the passcode rule, and one that is wrong for all of them.
const PASSCODE = '583920';
const OTHER = '904712';
const THIRD = '275019';
const WRONG = '583921';

const HIDDEN_ADDRESS = /^crew-[0-9a-f]{32}@crew\.minemuster\.com$/;

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const json = (status, body) => (body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const bearer = (headers) => /^Bearer (\S+)$/.exec(headers.get('authorization') ?? '')?.[1] ?? null;
/** The HTTP status PostgREST gives a SQLSTATE: PTnnn is nnn, 42501 is 403 with a token, 22023 and 23514 are 400. */
const statusOf = (code) => (/^PT\d{3}$/.test(code) ? Number(code.slice(2)) : code === '42501' ? 403 : /^(22|23)/.test(code) ? 400 : 500);
const loginPassword = async (email) => (await db.adminRows('select public.crew_login_password($1) as password', [email]))[0].password;
const TOO_MANY = { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' };

/** Every address, password and email the admin create was given, in every test, for the check of the logs. */
const EVER_MADE = [];

/** The route a call goes to, as the stand-in and the tests name it. */
function routeOf(method, path) {
  if (path.startsWith('/rest/v1/rpc/')) return `rpc:${path.slice('/rest/v1/rpc/'.length)}`;
  if (path === '/auth/v1/user') return 'user';
  if (path === '/auth/v1/admin/users' && method === 'POST') return 'admin_create';
  if (path.startsWith('/auth/v1/admin/users/') && method === 'DELETE') return 'admin_delete';
  if (path === '/auth/v1/token' && method === 'POST') return 'token';
  if (path === '/auth/v1/logout' && method === 'POST') return 'logout';
  return 'unknown';
}

/** Supabase, as far as the function reaches it, over the local database. */
function supabase({ clock }) {
  /** Access tokens Supabase Auth signed, with the account and the session of each. */
  const tokens = new Map();
  const signedOut = new Set();
  /** What the admin create was given for each account it made. */
  const made = new Map();
  const calls = [];
  const logouts = [];
  /** A test's own answer for a route, in place of the route's: it answers, or returns null to go on. */
  const instead = new Map();
  let tooMany = false;

  /** An access token for an account, as Supabase Auth signs one at a password sign-in, in a session of its own. */
  const tokenFor = (sub, session = randomUUID()) => {
    const at = Math.floor(clock.now / 1000);
    const claims = { sub, aud: 'authenticated', role: 'authenticated', iat: at, exp: at + 3600, session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: at }] };
    const token = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'test' })}.${b64(claims)}.${randomBytes(32).toString('base64url')}`;
    tokens.set(token, { sub, session, amr: claims.amr });
    return token;
  };

  /** Whose a token is, as Supabase Auth's /auth/v1/user finds it: { sub }, or { error_code }. */
  const whose = async (token) => {
    const held = tokens.get(token ?? '');
    if (!held) return { error_code: 'bad_jwt' };
    if (signedOut.has(held.session)) return { error_code: 'session_not_found' };
    const [user] = await db.adminRows('select id from auth.users where id = $1', [held.sub]);
    return user ? { sub: held.sub } : { error_code: 'user_not_found' };
  };
  const appMetadataOf = (id) => made.get(id)?.app_metadata ?? { provider: 'email', providers: ['email'] };

  const fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    const call = { method, path: pathname, query: searchParams.toString(), apikey: headers.get('apikey'), authorization: headers.get('authorization'), body: init.body ?? null, signal: init.signal ?? null };
    calls.push(call);
    const route = routeOf(method, pathname);
    const held = tokens.get(bearer(headers) ?? '');
    const hook = instead.get(route);
    if (hook) {
      const answer = await hook(call, held?.sub ?? null);
      if (answer) return answer;
    }

    if (route === 'user') {
      assert.equal(call.apikey, PUBLISHABLE, 'Auth is asked with the publishable key');
      if (!bearer(headers)) return json(401, { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a valid Bearer token' });
      const found = await whose(bearer(headers));
      if (found.error_code === 'bad_jwt') return json(403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT: unable to parse or verify signature' });
      if (found.error_code === 'session_not_found') return json(403, { code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' });
      if (found.error_code === 'user_not_found') return json(403, { code: 403, error_code: 'user_not_found', msg: 'User from sub claim in JWT does not exist' });
      const [user] = await db.adminRows('select id, email from auth.users where id = $1', [found.sub]);
      return json(200, { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: appMetadataOf(user.id) });
    }

    if (route.startsWith('rpc:')) {
      assert.equal(method, 'POST', 'a database function is called by POST: a GET runs it in a read-only transaction');
      const name = route.slice('rpc:'.length);
      let as;
      if (call.apikey === SECRET_KEY) {
        assert.equal(call.authorization, null, 'a secret key is sent as apikey only');
        as = db.serviceRole();
      } else {
        assert.equal(call.apikey, PUBLISHABLE, 'a person’s own calls go with the publishable key');
        // PostgREST takes any token the project signed until it expires: it does not ask Auth.
        if (!held) return json(401, { code: 'PGRST301', message: 'JWT could not be decoded' });
        as = db.as(held.sub, { amr: held.amr });
      }
      try {
        const result = await as.call(name, JSON.parse(init.body || '{}'));
        call.answer = result;
        return result === '' || result === null ? json(204) : json(200, result);
      } catch (error) {
        call.answer = { code: error.code };
        return json(statusOf(error.code), { code: error.code, message: error.message, details: null, hint: error.hint ?? null });
      }
    }

    if (route === 'admin_create') {
      assert.equal(call.apikey, SECRET_KEY, 'the admin create goes with the server key');
      assert.equal(call.authorization, null, 'a secret key is sent as apikey only');
      const body = JSON.parse(init.body);
      const [taken] = await db.adminRows('select id from auth.users where lower(email) = lower($1)', [body.email]);
      if (taken) return json(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
      const id = randomUUID();
      await db.admin('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, case when $3::boolean then now() end)', [id, body.email, body.email_confirm === true]);
      const app_metadata = { provider: 'email', providers: ['email'], ...(body.app_metadata ?? {}) };
      made.set(id, { email: body.email, password: body.password, email_confirm: body.email_confirm, app_metadata });
      EVER_MADE.push(body.email, body.password);
      const [user] = await db.adminRows('select email_confirmed_at from auth.users where id = $1', [id]);
      return json(200, { id, aud: 'authenticated', role: 'authenticated', email: body.email, email_confirmed_at: user.email_confirmed_at, app_metadata, user_metadata: {}, identities: [] });
    }

    if (route === 'token') {
      assert.equal(searchParams.get('grant_type'), 'password');
      assert.equal(call.apikey, PUBLISHABLE, 'a sign-in goes with the publishable key, as a phone’s own would');
      if (tooMany) return json(429, TOO_MANY);
      const { email, password } = JSON.parse(init.body);
      const invalid = () => json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      const [user] = await db.adminRows('select id, email from auth.users where lower(email) = lower($1)', [typeof email === 'string' ? email : '']);
      if (!user || typeof password !== 'string') return invalid();
      if (password !== (await loginPassword(user.email))) return invalid();
      if (made.has(user.id) && made.get(user.id).password !== password) return invalid();
      const at = Math.floor(clock.now / 1000);
      return json(200, {
        access_token: tokenFor(user.id),
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: at + 3600,
        refresh_token: randomBytes(16).toString('hex'),
        user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: appMetadataOf(user.id) },
      });
    }

    if (route === 'logout') {
      assert.equal(call.apikey, PUBLISHABLE, 'a sign-out goes with the publishable key and the session’s own token');
      const found = await whose(bearer(headers));
      if (!found.sub) return json(403, { code: 403, error_code: found.error_code, msg: 'The session could not be found' });
      const scope = searchParams.get('scope') ?? 'global';
      logouts.push({ scope, sub: held.sub, session: held.session });
      for (const other of tokens.values()) {
        if (other.sub !== held.sub) continue;
        if (scope === 'global' || (scope === 'others') === (other.session !== held.session)) signedOut.add(other.session);
      }
      return json(204);
    }

    if (route === 'admin_delete') {
      assert.equal(call.apikey, SECRET_KEY, 'the admin delete goes with the server key');
      assert.equal(call.authorization, null, 'a secret key is sent as apikey only');
      assert.deepEqual(JSON.parse(init.body), { should_soft_delete: false });
      const id = decodeURIComponent(pathname.slice('/auth/v1/admin/users/'.length));
      try {
        const removed = await db.admin('delete from auth.users where id = $1', [id]);
        return removed.affectedRows ? json(200, {}) : json(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
      } catch (error) {
        return json(500, { code: error.code, msg: error.message });
      }
    }
    return json(404, { message: 'no such route' });
  };

  return {
    fetch,
    calls,
    made,
    logouts,
    tokenFor,
    /** The account Supabase Auth says a token signs in, or null. Not a call of the function's. */
    accountOf: async (token) => (await whose(token)).sub ?? null,
    /** The session is signed out: Auth turns its token down, and PostgREST still takes it until it expires. */
    signOut: (token) => signedOut.add(tokens.get(token).session),
    /** The switch: the password grant answers 429, too many sign-ins, while it is on. */
    tooManySignIns: (on) => (tooMany = on),
    /** A test's own answer for a route ('rpc:<name>', 'user', 'admin_create', 'admin_delete', 'token', 'logout'), or null to take it off. */
    when: (route, answer) => (answer ? instead.set(route, answer) : instead.delete(route)),
    /** Something done once, as the account a sign-up made joins, just before join_company runs: it gets that account. */
    beforeJoin: (work) =>
      instead.set('rpc:join_company', async (_call, sub) => {
        instead.delete('rpc:join_company');
        await work(sub);
        return null;
      }),
  };
}

const said = { logs: [], bodies: [] };
function handler({ env = ENV } = {}) {
  const clock = { now: NOW * 1000 };
  const auth = supabase({ clock });
  const logged = [];
  const handle = makeHandler({
    env: (name) => env[name],
    fetch: auth.fetch,
    now: () => clock.now,
    log: (line) => {
      logged.push(line);
      said.logs.push(line);
    },
  });
  const ask = async (request) => {
    const response = await handle(request);
    const text = await response.text();
    said.bodies.push(text);
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return { ask, send: (body, options) => ask(post(body, options)), handle, auth, clock, logged };
}

let sent = 0;
/** An address no request has come from yet, so each test's tries are its own. */
const anyAddress = () => `2001:db8:6::${(sent += 1).toString(16)}`;

/**
 * A request as the app sends it: POST, JSON and no Origin, from the phone's address as Supabase's edge
 * hands it on (cf-connecting-ip). `address` null sends none.
 */
function post(body, { address = anyAddress(), bearer: token = null, origin = null, raw = null, headers = {} } = {}) {
  const sending = { 'Content-Type': 'application/json', ...headers };
  if (address !== null) sending['cf-connecting-ip'] = address;
  if (token) sending.Authorization = `Bearer ${token}`;
  if (origin) sending.Origin = origin;
  return new Request(ENDPOINT, { method: 'POST', headers: sending, body: raw ?? JSON.stringify(body) });
}

const lookup = (code) => ({ action: 'lookup', code });
const signUp = (code, first, last, passcode = PASSCODE) => ({ action: 'sign_up', code, first_name: first, last_name: last, passcode });
const signIn = (code, first, last, passcode = PASSCODE) => ({ action: 'sign_in', code, first_name: first, last_name: last, passcode });
const reset = (code, first, last, resetCode, newPasscode) => ({ action: 'reset', code, first_name: first, last_name: last, reset_code: resetCode, new_passcode: newPasscode });
const confirm = (passcode = PASSCODE) => ({ action: 'confirm', passcode });

/** Everything a request could make or change, as the owner sees it. */
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

const accountExists = async (id) => (await db.adminRows('select count(*)::int as n from auth.users where id = $1', [id]))[0].n === 1;
const holderOf = async (rowId) => (await db.adminRows('select user_id from public.roster where id = $1', [rowId]))[0].user_id;
const countsOf = async (account) => (await db.adminRows('select wrong_in_a_row from public.crew_logins where user_id = $1', [account]))[0];
const adminDeletes = (calls) => calls.filter((c) => c.method === 'DELETE');
const routes = (calls) => calls.map((c) => `${c.method} ${c.path}`);
const revOf = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 20);
const resetCodeFor = (company, name) => db.as(company.owner).call('make_passcode_reset_code', { p_roster_id: company.rows[name] });
/** Another code than this one: its last digit moved on by one. */
const otherThan = (code) => code.slice(0, 5) + String((Number(code[5]) + 1) % 10);

/** A signed-in answer's session: its shape, and the account Supabase Auth says its access token signs in. */
async function sessionAccount(auth, session, clock = { now: NOW * 1000 }) {
  assert.deepEqual(Object.keys(session).sort(), ['access_token', 'expires_at', 'refresh_token', 'user_id']);
  assert.ok(typeof session.access_token === 'string' && session.access_token.length > 0, 'an access token');
  assert.ok(typeof session.refresh_token === 'string' && session.refresh_token.length > 0, 'a refresh token');
  assert.equal(session.expires_at, Math.floor(clock.now / 1000) + 3600, 'when the access token expires, in seconds, as Supabase Auth says');
  assert.equal(await auth.accountOf(session.access_token), session.user_id);
  return session.user_id;
}

/** A crew account made as crew-auth makes one: a hidden address, and its passcode kept with the server key. */
async function crewAccount(passcode) {
  const id = randomUUID();
  await db.admin('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())', [id, `crew-${randomBytes(16).toString('hex')}@${CREW_DOMAIN}`]);
  await db.serviceRole().call('crew_keep_passcode', { p_user: id, p_passcode: passcode });
  return id;
}

describe('lookup', () => {
  it('lookup answers the company for a good code and no_company otherwise', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { name: 'Test Pit A', state: 'NV' });
    const address = '203.0.113.31';
    const found = await send(lookup(company.code), { address });
    assert.deepEqual([found.status, found.body], [200, { status: 'company', name: 'Test Pit A', state: 'NV' }]);
    // The code is read as joining reads it: capitals, spaces and dashes aside.
    const typed = `${company.code.slice(0, 4).toLowerCase()}-${company.code.slice(4).toLowerCase()}`;
    assert.deepEqual((await send(lookup(typed))).body, { status: 'company', name: 'Test Pit A', state: 'NV' });
    for (const code of ['ZZZZZZZZ', '', 'not a code']) {
      const none = await send(lookup(code));
      assert.deepEqual([none.status, none.body], [200, { status: 'no_company' }]);
    }
    // Each is crew_lookup, called by POST with the server key and handed the phone's address.
    assert.deepEqual(routes(auth.calls), Array(5).fill('POST /rest/v1/rpc/crew_lookup'));
    assert.ok(auth.calls.every((c) => c.apikey === SECRET_KEY));
    assert.ok(JSON.parse(auth.calls[0].body).p_address === address, "the phone's address");
  });

  it('counts every request but confirm against the phone’s address: the 31st in 10 minutes is busy', async () => {
    const { send } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = (await send(signUp(company.code, 'Riley', 'Quinn'))).body.session;
    const address = '203.0.113.62';
    for (let i = 0; i < 10; i += 1) assert.equal((await send(lookup(company.code), { address })).body.status, 'company');
    for (let i = 0; i < 10; i += 1) assert.equal((await send(signIn(company.code, 'Pat', 'Cole'), { address })).body.status, 'no_account');
    for (let i = 0; i < 10; i += 1) assert.equal((await send(signUp('ZZZZZZZZ', 'Pat', 'Cole'), { address })).body.status, 'no_company');
    // The 31st from that address is busy, whatever it asks, and no passcode or code is tried.
    for (const body of [lookup(company.code), signIn(company.code, 'Riley', 'Quinn'), signUp(company.code, 'Jo', 'Vale'), reset(company.code, 'Riley', 'Quinn', '000000', OTHER)]) {
      assert.deepEqual((await send(body, { address })).body, { status: 'busy' });
    }
    // Confirming goes by the account signed in, which its own lock limits, not by the address.
    assert.equal((await send(confirm(), { address, bearer: riley.access_token })).body.status, 'signed_in');
    // Another address is not affected, and X-Forwarded-For is read when the edge gives no cf-connecting-ip.
    assert.equal((await send(lookup(company.code), { address: '198.51.100.62' })).body.status, 'company');
    assert.deepEqual((await send(lookup(company.code), { address: null, headers: { 'x-forwarded-for': `${address}, 198.51.100.1` } })).body, { status: 'busy' });
    // What is not an address counts as no address, and every request with none is one sender: junk splits nothing.
    for (let i = 0; i < 30; i += 1) assert.equal((await send(lookup(company.code), { address: `junk-${i}` })).body.status, 'company');
    assert.deepEqual((await send(lookup(company.code), { address: null })).body, { status: 'busy' });
    assert.deepEqual((await send(lookup(company.code), { address: 'junk', headers: { 'x-forwarded-for': '198.51.100.63' } })).body, { status: 'busy' });
    // The tries are taken away, so the shared sender is free for the tests after this one.
    await db.admin('delete from public.crew_sign_in_tries');
  });
});

describe('the phone’s address', () => {
  it('clientAddress reads cf-connecting-ip, else the first X-Forwarded-For entry, and nothing that is not an IPv4 or IPv6 address', () => {
    const from = (headers) => clientAddress(new Request(ENDPOINT, { method: 'POST', headers }));
    assert.equal(from({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' }), '203.0.113.9');
    assert.equal(from({ 'x-forwarded-for': ' 198.51.100.1 ,203.0.113.9' }), '198.51.100.1');
    assert.equal(from({ 'x-forwarded-for': '2001:db8::5, 198.51.100.1' }), '2001:db8::5');
    for (const good of ['192.0.2.1', '0.0.0.0', '255.255.255.255', '::', '::1', '1::', '2001:DB8::7', '2001:db8:0:0:0:0:2:1', '1:2:3:4:5:6:7::', '::ffff:192.0.2.128', '64:ff9b::192.0.2.33', '1:2:3:4:5:6:192.0.2.1']) {
      assert.ok(from({ 'cf-connecting-ip': good }) === good, `address ${good.length}`);
    }
    const junk = ['', 'unknown', '256.1.1.1', '192.0.2', '192.0.2.1.5', '01.2.3.4', '192.0.2.1/24', '[2001:db8::1]', '2001:db8::1%eth0', '1::2::3', '1:2:3:4:5:6:7:8:9', ':::', '1:2:3:4:5:6:7', '12345::1', 'g::1', '1.2.3.4::', '::1.2.3', '::ffff:256.1.1.1', 'x'.repeat(100)];
    for (const [i, value] of junk.entries()) {
      // A cf-connecting-ip that is not an address is not passed over for X-Forwarded-For, which a caller can write.
      assert.equal(from({ 'cf-connecting-ip': value, 'x-forwarded-for': '198.51.100.1' }), '', `junk ${i}`);
      assert.equal(from({ 'x-forwarded-for': `${value}, 198.51.100.1` }), '', `junk ${i} first in X-Forwarded-For`);
    }
    assert.equal(from({}), '');
  });
});

describe('sign_up', () => {
  it('sign_up makes a hidden account, keeps the passcode, joins the company and answers a session', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const before = await everything();
    const address = '203.0.113.41';
    const answer = await send(signUp(company.code, 'Riley', 'Quinn'), { address });
    assert.equal(answer.status, 200);
    const { session, ...rest } = answer.body;
    assert.deepEqual(rest, {
      status: 'signed_in',
      company: { id: company.id, name: 'Test Pit A' },
      waiting: false,
      join: { status: 'joined', company_name: 'Test Pit A', role: 'employee' },
    });
    const riley = await sessionAccount(auth, session);

    // The check, the account, the passcode, the sign-in and the join, in that order: the check, the
    // account and the passcode with the server key, the sign-in with the publishable key, and the join as
    // the new account, with its own token.
    assert.deepEqual(routes(auth.calls), ['POST /rest/v1/rpc/crew_sign_up_check', 'POST /auth/v1/admin/users', 'POST /rest/v1/rpc/crew_keep_passcode', 'POST /auth/v1/token', 'POST /rest/v1/rpc/join_company']);
    const [check, create, keep, token, joining] = auth.calls;
    assert.deepEqual([check.apikey, create.apikey, keep.apikey, token.apikey, joining.apikey], [SECRET_KEY, SECRET_KEY, SECRET_KEY, PUBLISHABLE, PUBLISHABLE]);
    assert.ok(JSON.parse(check.body).p_address === address, "the check is handed the phone's address");
    assert.equal(JSON.parse(keep.body).p_user, riley);
    assert.ok(joining.authorization === `Bearer ${session.access_token}`, 'joined as the new account');
    assert.deepEqual(JSON.parse(joining.body), { code: company.code, first_name: 'Riley', last_name: 'Quinn' });

    // One account more, with its passcode: a hidden address on crew.minemuster.com, confirmed so that no
    // mail is ever sent, marked a passcode sign-in, and made with the password the database works out.
    assert.equal(CREW_DOMAIN, 'crew.minemuster.com');
    const now = await everything();
    assert.deepEqual([now.accounts, now.logins], [before.accounts + 1, before.logins + 1]);
    const asked = JSON.parse(create.body);
    assert.deepEqual(Object.keys(asked).sort(), ['app_metadata', 'email', 'email_confirm', 'password']);
    assert.deepEqual([asked.email_confirm, asked.app_metadata], [true, { sign_in: 'passcode' }]);
    const [user] = await db.adminRows('select email, email_confirmed_at from auth.users where id = $1', [riley]);
    assert.ok(HIDDEN_ADDRESS.test(user.email) && user.email.endsWith(`@${CREW_DOMAIN}`), 'a hidden address on crew.minemuster.com');
    assert.notEqual(user.email_confirmed_at, null);
    assert.equal(auth.made.get(riley).app_metadata.sign_in, 'passcode');
    assert.ok(asked.password === (await loginPassword(user.email)), 'made with the password the database works out from the address');
    // The person holds the row now, and the passcode signs in.
    assert.equal(await holderOf(company.rows['Riley J Quinn']), riley);
    const again = await send(signIn(company.code, 'Riley', 'Quinn'));
    assert.deepEqual([again.body.status, again.body.session.user_id], ['signed_in', riley]);
    assert.deepEqual(adminDeletes(auth.calls), []);
  });

  it('sign_up with a name not on the roster answers a session that waits for a supervisor', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const answer = await send(signUp(company.code, 'Pat', 'Cole'));
    const { session, ...rest } = answer.body;
    assert.deepEqual([answer.status, rest], [
      200,
      { status: 'signed_in', company: { id: company.id, name: 'Test Pit A' }, waiting: true, join: { status: 'pending', company_name: 'Test Pit A', reason: 'not_on_roster' } },
    ]);
    const pat = await sessionAccount(auth, session);
    // The account stays, with a request for a supervisor under the name typed.
    assert.ok(await accountExists(pat));
    assert.deepEqual(await db.adminRows("select first_name, last_name, reason from public.join_requests where user_id = $1 and status = 'pending'", [pat]), [
      { first_name: 'Pat', last_name: 'Cole', reason: 'not_on_roster' },
    ]);
    assert.deepEqual(adminDeletes(auth.calls), []);
    // Signing in finds the person by that request, still waiting.
    const back = await send(signIn(company.code, 'Pat', 'Cole'));
    assert.deepEqual([back.body.status, back.body.waiting, back.body.session.user_id], ['signed_in', true, pat]);
  });

  it('sign_up deletes the account it made when joining is refused', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Lee Roy', last: 'Park' }, { first: 'Roy "Lee"', last: 'Park' }] });
    const before = await everything();
    // Kit MarIow (a capital I for the l) passes the check while nobody like it is on the roster. A
    // supervisor puts Kit Marlow on before it joins, and join_company refuses a name that only looks like
    // one on the roster.
    auth.beforeJoin(() => addToRoster(db, company.owner, company.id, { first: 'Kit', last: 'Marlow' }));
    const lookalike = await send(signUp(company.code, 'Kit', 'MarIow'));
    assert.deepEqual([lookalike.status, lookalike.body], [200, { status: 'bad_name', message: 'Type your name the way it is written on the roster.' }]);
    // A name that fits two rows and is neither: join_company records nothing, and asks for the name as it is on the roster.
    assert.deepEqual((await send(signUp(company.code, 'Roy', 'Park'))).body, { status: 'ambiguous' });
    // A supervisor's bar on the account, as it joins.
    auth.beforeJoin((account) => db.admin("insert into public.join_holds (company_id, user_id, kind) values ($1, $2, 'barred')", [company.id, account]));
    assert.deepEqual((await send(signUp(company.code, 'Jo', 'Vale'))).body, { status: 'denied' });
    // The code changed while it signed up.
    auth.beforeJoin(() => db.as(company.owner).call('rotate_join_code', { company_id: company.id }));
    assert.deepEqual((await send(signUp(company.code, 'Jo', 'Vale'))).body, { status: 'no_company' });

    // Each account it made is deleted again, and what joining left of it with it: nothing is kept.
    const madeIds = [...auth.made.keys()];
    assert.equal(madeIds.length, 4);
    assert.deepEqual(adminDeletes(auth.calls).map((c) => c.path), madeIds.map((id) => `/auth/v1/admin/users/${id}`));
    for (const id of madeIds) assert.equal(await accountExists(id), false);
    const { roster: _now, ...now } = await everything();
    const { roster: _before, ...then } = before;
    assert.deepEqual(now, then);
  });

  it("sign_up refuses an easy passcode, a supervisor's row and a name already signed up, making nothing", async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, {
      roster: [
        { first: 'Riley J', last: 'Quinn' },
        { first: 'Ana', last: 'Diaz', role: 'supervisor' },
        { first: 'Lee', last: 'Park' },
      ],
    });
    assert.equal((await send(signUp(company.code, 'Riley', 'Quinn'))).body.status, 'signed_in');
    await newMember(db, company, 'Lee', 'Park');
    const before = await everything();
    const calls = auth.calls.length;

    for (const [passcode, problem] of [
      ['123456', 'easy'],
      ['121212', 'easy'],
      ['58392', 'too_short'],
      ['5839205839201', 'too_long'],
      ['58392a', 'not_digits'],
      ['', 'not_digits'],
    ]) {
      const answer = await send(signUp(company.code, 'Jo', 'Vale', passcode));
      assert.deepEqual([answer.status, answer.body], [200, { status: 'easy_passcode', problem }]);
    }
    // A supervisor's row, held or not, and a row an email account holds: they sign in with email.
    for (const [first, last] of [['Ana', 'Diaz'], ['Sam', 'Ortiz'], ['Lee', 'Park']]) {
      assert.deepEqual((await send(signUp(company.code, first, last))).body, { status: 'use_email' });
    }
    // A name someone has signed up with, however it is typed.
    for (const [first, last] of [['Riley', 'Quinn'], ['riley j', ' QUINN ']]) {
      assert.deepEqual((await send(signUp(company.code, first, last, OTHER))).body, { status: 'already_signed_up' });
    }
    // A name joining refuses for what it is, and a code no company has.
    assert.deepEqual((await send(signUp(company.code, '', 'Vale'))).body, { status: 'bad_name', message: 'Type your first and last name, up to 100 characters each.' });
    assert.deepEqual((await send(signUp('ZZZZZZZZ', 'Jo', 'Vale'))).body, { status: 'no_company' });

    // Nothing was made: the check alone was asked, each time.
    assert.deepEqual(await everything(), before);
    assert.ok(routes(auth.calls.slice(calls)).every((route) => route === 'POST /rest/v1/rpc/crew_sign_up_check'));
  });

  it('a sign_up sent twice for one name makes one account', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const before = await everything();
    // A double tap: the same sign-up twice at once.
    const both = await Promise.all([send(signUp(company.code, 'Riley', 'Quinn')), send(signUp(company.code, 'Riley', 'Quinn'))]);
    assert.deepEqual(both.map((answer) => answer.body.status).sort(), ['already_signed_up', 'signed_in']);
    const riley = both.find((answer) => answer.body.status === 'signed_in').body.session.user_id;
    // One account holds the row; any other the pair made was deleted again.
    assert.equal(await holderOf(company.rows['Riley J Quinn']), riley);
    const kept = [];
    for (const id of auth.made.keys()) if (await accountExists(id)) kept.push(id);
    assert.deepEqual(kept, [riley]);
    const now = await everything();
    assert.deepEqual([now.accounts, now.logins, now.requests], [before.accounts + 1, before.logins + 1, before.requests]);

    // Sent again once the answer was lost: signed up already, and nothing more is made.
    const made = auth.made.size;
    assert.deepEqual((await send(signUp(company.code, 'Riley', 'Quinn'))).body, { status: 'already_signed_up' });
    assert.equal(auth.made.size, made);
    // Signing in with the passcode just typed lets the person in.
    const back = await send(signIn(company.code, 'Riley', 'Quinn'));
    assert.deepEqual([back.body.status, back.body.session.user_id], ['signed_in', riley]);
  });

  it('a sign_up that loses the name to another sign-up deletes its account', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    // Another sign-up for the name claims the row between this one's check and its join.
    let other = null;
    auth.beforeJoin(async () => {
      other = await crewAccount(OTHER);
      assert.equal((await join(db, other, company.code, 'Riley J', 'Quinn')).status, 'joined');
    });
    const answer = await send(signUp(company.code, 'Riley', 'Quinn'));
    assert.deepEqual([answer.status, answer.body], [200, { status: 'already_signed_up' }]);

    // join_company left a request for a supervisor, the one row being another account's; the function
    // deleted its own account, and the request and the passcode with it.
    const [mine] = auth.made.keys();
    const joining = auth.calls.find((c) => c.path === '/rest/v1/rpc/join_company');
    assert.deepEqual(joining.answer, { status: 'pending', company_name: 'Test Pit A', reason: 'already_claimed' });
    assert.deepEqual(adminDeletes(auth.calls).map((c) => c.path), [`/auth/v1/admin/users/${mine}`]);
    assert.equal(await accountExists(mine), false);
    assert.deepEqual(await db.adminRows('select user_id from public.crew_logins where user_id = $1', [mine]), []);
    assert.deepEqual(await db.adminRows('select id from public.join_requests where user_id = $1', [mine]), []);
    // The other sign-up keeps the row, and its own passcode signs it in.
    assert.equal(await holderOf(company.rows['Riley J Quinn']), other);
    const back = await send(signIn(company.code, 'Riley', 'Quinn', OTHER));
    assert.deepEqual([back.body.status, back.body.session.user_id], ['signed_in', other]);
  });

  it('an Auth refusal for too many sign-ins answers busy, and a sign-up deletes the account it made', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }] });
    const riley = (await send(signUp(company.code, 'Riley', 'Quinn'))).body.session;
    const before = await everything();

    auth.tooManySignIns(true);
    const answer = await send(signUp(company.code, 'Kit', 'Marlow'));
    assert.deepEqual([answer.status, answer.body], [200, { status: 'busy' }]);
    // The account it made is deleted again, with its passcode: nothing is left half made.
    const kit = [...auth.made.keys()].at(-1);
    assert.notEqual(kit, riley.user_id);
    assert.equal(await accountExists(kit), false);
    assert.deepEqual(adminDeletes(auth.calls).map((c) => c.path), [`/auth/v1/admin/users/${kit}`]);
    assert.deepEqual(await everything(), before);
    // Signing in and confirming are busy too, confirming as well when it is Auth's read of the session that is refused.
    assert.deepEqual((await send(signIn(company.code, 'Riley', 'Quinn'))).body, { status: 'busy' });
    assert.deepEqual((await send(confirm(), { bearer: riley.access_token })).body, { status: 'busy' });
    auth.when('user', () => json(429, TOO_MANY));
    assert.deepEqual((await send(confirm(), { bearer: riley.access_token })).body, { status: 'busy' });
    auth.when('user', null);
    // A reset keeps the new passcode before Auth turns its sign-in down: the person then signs in with it.
    const code = await resetCodeFor(company, 'Riley J Quinn');
    assert.deepEqual((await send(reset(company.code, 'Riley', 'Quinn', code, OTHER))).body, { status: 'busy' });
    // Auth's 429 at the admin create is busy as well, and makes nothing.
    auth.tooManySignIns(false);
    auth.when('admin_create', () => json(429, TOO_MANY));
    const made = auth.made.size;
    assert.deepEqual((await send(signUp(company.code, 'Kit', 'Marlow'))).body, { status: 'busy' });
    assert.equal(auth.made.size, made);
    auth.when('admin_create', null);

    // Once Auth lets them through again, the sign-in and the sign-up go ahead.
    assert.equal((await send(signIn(company.code, 'Riley', 'Quinn', OTHER))).body.status, 'signed_in');
    const again = await send(signUp(company.code, 'Kit', 'Marlow'));
    assert.deepEqual([again.body.status, again.body.join.status], ['signed_in', 'joined']);
  });

  it('a sign_up deletes the account it made when a later step fails, and answers try_again', async () => {
    const { send, auth, logged } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const someone = await db.newAccount('someone');
    const before = await everything();
    // Each failure, and whether an account was made before it.
    const failures = [
      // The check hands back an address that is not a hidden one: no account is made at it.
      ['rpc:crew_sign_up_check', false, () => json(200, { status: 'ok', company_id: company.id, company_name: 'Test Pit A', login_email: 'someone@example.test', login_password: 'made-up' })],
      ['admin_create', false, () => json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error creating new user' })],
      ['admin_create', false, () => json(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' })],
      ['rpc:crew_keep_passcode', true, () => json(500, { code: 'XX000', message: 'internal error', details: null, hint: null })],
      ['token', true, () => json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error querying schema' })],
      [
        'token',
        true,
        () => {
          throw new TypeError('fetch failed');
        },
      ],
      // A session for another account than the one made: it is never the one that joins.
      ['token', true, () => json(200, { access_token: auth.tokenFor(someone), token_type: 'bearer', expires_in: 3600, expires_at: NOW + 3600, refresh_token: 'r', user: { id: someone } })],
      ['rpc:join_company', true, () => json(503, { message: 'upstream connect error' })],
      ['rpc:join_company', true, () => json(200, { status: 'something new' })],
    ];
    for (const [i, [route, , failure]] of failures.entries()) {
      auth.when(route, failure);
      const answer = await send(signUp(company.code, 'Riley', 'Quinn'));
      auth.when(route, null);
      assert.deepEqual([answer.status, answer.body.error], [500, 'try_again'], `failure ${i}`);
      assert.deepEqual(await everything(), before, `nothing is left after failure ${i}`);
    }
    // Each account made was deleted again; where none was made, nothing needed deleting.
    const madeIds = [...auth.made.keys()];
    assert.equal(madeIds.length, failures.filter(([, made]) => made).length);
    assert.deepEqual(adminDeletes(auth.calls).map((c) => c.path), madeIds.map((id) => `/auth/v1/admin/users/${id}`));
    assert.ok(!auth.calls.some((c) => c.body?.includes('someone@example.test')), 'no account is asked for at an address that is not a hidden one');

    // When the delete itself fails, the answer still says why the sign-up did not go through, and the log
    // says the account was left.
    auth.when('rpc:join_company', () => json(200, { status: 'ambiguous', company_name: 'Test Pit A' }));
    auth.when('admin_delete', () => json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error deleting user' }));
    assert.deepEqual((await send(signUp(company.code, 'Riley', 'Quinn'))).body, { status: 'ambiguous' });
    assert.match(logged.at(-1), /could not be deleted/);
    auth.when('rpc:join_company', null);
    auth.when('admin_delete', null);
    const left = [...auth.made.keys()].at(-1);
    assert.ok(await accountExists(left));
    await db.admin('delete from auth.users where id = $1', [left]);

    // With nothing in the way, it goes through.
    assert.equal((await send(signUp(company.code, 'Riley', 'Quinn'))).body.status, 'signed_in');
  });
});

describe('sign_in', () => {
  it('sign_in answers a session for the right passcode, and tries left for a wrong one', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = (await send(signUp(company.code, 'Riley', 'Quinn'))).body.session.user_id;
    const calls = auth.calls.length;
    const address = '203.0.113.51';
    const answer = await send(signIn(company.code, 'riley ', ' QUINN'), { address });
    const { session, ...rest } = answer.body;
    assert.deepEqual([answer.status, rest], [200, { status: 'signed_in', company: { id: company.id, name: 'Test Pit A' }, waiting: false }]);
    assert.equal(await sessionAccount(auth, session), riley);
    // The check with the server key, handed the phone's address, then the sign-in with the publishable key.
    assert.deepEqual(routes(auth.calls.slice(calls)), ['POST /rest/v1/rpc/crew_sign_in_check', 'POST /auth/v1/token']);
    const [check, token] = auth.calls.slice(calls);
    assert.deepEqual([check.apikey, token.apikey], [SECRET_KEY, PUBLISHABLE]);
    assert.ok(JSON.parse(check.body).p_address === address, "the check is handed the phone's address");

    // Each wrong one is counted, and says how many tries are left before the account locks.
    for (const left of [4, 3]) assert.deepEqual((await send(signIn(company.code, 'Riley', 'Quinn', WRONG))).body, { status: 'wrong', tries_left: left });
    assert.equal((await countsOf(riley)).wrong_in_a_row, 2);
    // The right one clears the count; five wrong in a row lock the account, against the right one too.
    assert.equal((await send(signIn(company.code, 'Riley', 'Quinn'))).body.status, 'signed_in');
    assert.equal((await countsOf(riley)).wrong_in_a_row, 0);
    for (let i = 0; i < 4; i += 1) await send(signIn(company.code, 'Riley', 'Quinn', WRONG));
    const locked = (await send(signIn(company.code, 'Riley', 'Quinn', WRONG))).body;
    assert.deepEqual(Object.keys(locked).sort(), ['status', 'until']);
    assert.equal(locked.status, 'locked');
    const ahead = Date.parse(locked.until) - Date.now();
    assert.ok(ahead > 14 * MINUTE && ahead <= 15 * MINUTE + 1000, `locked for ${Math.round(ahead / 1000)} s more`);
    assert.equal((await send(signIn(company.code, 'Riley', 'Quinn'))).body.status, 'locked');
    // Nobody signed up with the name, a supervisor, and a code no company has.
    assert.deepEqual((await send(signIn(company.code, 'Pat', 'Cole'))).body, { status: 'no_account' });
    assert.deepEqual((await send(signIn(company.code, 'Sam', 'Ortiz'))).body, { status: 'use_email' });
    assert.deepEqual((await send(signIn('ZZZZZZZZ', 'Riley', 'Quinn'))).body, { status: 'no_company' });
    // Supabase Auth was asked to sign in only for the right passcodes.
    assert.equal(auth.calls.slice(calls).filter((c) => c.path === '/auth/v1/token').length, 2);
  });

  it("an off-the-roster passcode account signs in but reads none of the company's records", async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    const kit = (await send(signUp(company.code, 'Kit', 'Marlow'))).body.session.user_id;
    // A unit a supervisor sent and a shift the crew member sent, theirs to read while on the roster.
    const unit = { id: 'eq-1', unit: 'T-14', category: 'haul_truck', make: 'Made-up', model: 'HX 40', status: 'ready', meter: 1200, meterUnit: 'hrs' };
    const shift = { id: 'sh-1', employeeId: 'emp-1', clockIn: 1763300000000, clockOut: null, edits: [] };
    await db.as(company.owner).call('push_records', { company_id: company.id, changes: JSON.stringify([{ key: 'equipment:eq-1', kind: 'equipment', id: 'eq-1', rev: revOf(unit), record: unit }]) });
    await db.as(kit).call('push_records', { company_id: company.id, changes: JSON.stringify([{ key: 'shift:sh-1', kind: 'shift', id: 'sh-1', rev: revOf(shift), record: shift }]) });
    const table = (account) => db.as(account).rows('select kind, id from public.records where company_id = $1 order by kind', [company.id]);
    const shared = (account) => db.as(account).callRows('read_shared_records', { company_id: company.id, after: 0, max: 200 });
    assert.deepEqual((await table(kit)).map((r) => `${r.kind}:${r.id}`), ['equipment:eq-1', 'shift:sh-1']);
    assert.deepEqual((await shared(kit)).map((r) => `${r.kind}:${r.id}`), ['equipment:eq-1']);

    // Taken off the roster, the person still signs in, only to delete the account.
    await db.as(company.owner).query('update public.roster set active = false where id = $1', [company.rows['Kit Marlow']]);
    const back = await send(signIn(company.code, 'Kit', 'Marlow'));
    const { session, ...rest } = back.body;
    assert.deepEqual(rest, { status: 'signed_in', company: { id: company.id, name: 'Test Pit A' }, waiting: false });
    assert.equal(await sessionAccount(auth, session), kit);
    // The account that session signs in reads nothing of the company's.
    assert.deepEqual(await table(session.user_id), []);
    await refused(shared(session.user_id), NOT_FOUND, /No such company/);
    assert.deepEqual(await db.as(session.user_id).callRows('my_companies'), []);
  });
});

describe('reset', () => {
  it('reset sets the new passcode, signs other sessions out, and answers a session', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    // Signed in on two phones.
    const first = (await send(signUp(company.code, 'Riley', 'Quinn'))).body.session;
    const second = (await send(signIn(company.code, 'Riley', 'Quinn'))).body.session;
    const riley = first.user_id;
    const code = await resetCodeFor(company, 'Riley J Quinn');

    // A wrong code is counted, and a passcode the rule refuses is turned down before the code is tried.
    assert.deepEqual((await send(reset(company.code, 'Riley', 'Quinn', otherThan(code), OTHER))).body, { status: 'bad_reset_code', tries_left: 4 });
    assert.deepEqual((await send(reset(company.code, 'Riley', 'Quinn', code, '123456'))).body, { status: 'easy_passcode', problem: 'easy' });
    assert.equal(auth.logouts.length, 0);

    const calls = auth.calls.length;
    const answer = await send(reset(company.code, 'Riley', 'Quinn', code, OTHER));
    const { session, ...rest } = answer.body;
    assert.deepEqual([answer.status, rest], [200, { status: 'signed_in', company: { id: company.id, name: 'Test Pit A' }, waiting: false }]);
    assert.equal(await sessionAccount(auth, session), riley);
    // The check, the sign-in, and the sign-out of every other session, made with the fresh session.
    assert.deepEqual(routes(auth.calls.slice(calls)), ['POST /rest/v1/rpc/crew_reset_check', 'POST /auth/v1/token', 'POST /auth/v1/logout']);
    const logout = auth.calls.at(-1);
    assert.deepEqual([logout.query, logout.apikey], ['scope=others', PUBLISHABLE]);
    assert.ok(logout.authorization === `Bearer ${session.access_token}`, 'signed out with the fresh session');
    assert.deepEqual(auth.logouts.map(({ scope, sub }) => [scope, sub]), [['others', riley]]);
    // The phones signed in before are signed out; the fresh session is not.
    assert.equal(await auth.accountOf(first.access_token), null);
    assert.equal(await auth.accountOf(second.access_token), null);
    assert.equal(await auth.accountOf(session.access_token), riley);
    // The new passcode signs in, the old one is wrong, and the code does not work twice.
    assert.equal((await send(signIn(company.code, 'Riley', 'Quinn', OTHER))).body.status, 'signed_in');
    assert.deepEqual((await send(signIn(company.code, 'Riley', 'Quinn', PASSCODE))).body, { status: 'wrong', tries_left: 4 });
    assert.deepEqual((await send(reset(company.code, 'Riley', 'Quinn', code, THIRD))).body, { status: 'expired' });

    // When the other sessions cannot be signed out, no session is answered: the new passcode is kept, and
    // the person signs in with it.
    auth.when('logout', () => json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error' }));
    const failed = await send(reset(company.code, 'Riley', 'Quinn', await resetCodeFor(company, 'Riley J Quinn'), THIRD));
    assert.deepEqual([failed.status, failed.body.error], [500, 'try_again']);
    auth.when('logout', () => json(429, TOO_MANY));
    assert.deepEqual((await send(reset(company.code, 'Riley', 'Quinn', await resetCodeFor(company, 'Riley J Quinn'), PASSCODE))).body, { status: 'busy' });
    auth.when('logout', null);
    assert.equal((await send(signIn(company.code, 'Riley', 'Quinn', PASSCODE))).body.status, 'signed_in');
  });
});

describe('confirm', () => {
  it('confirm answers a fresh session for the signed-in passcode account', async () => {
    const { send, auth, clock } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const signedUp = (await send(signUp(company.code, 'Riley', 'Quinn'))).body.session;
    const riley = signedUp.user_id;
    // An hour later, the phone asks for a fresh session to delete the account with.
    clock.now += 60 * MINUTE;
    const calls = auth.calls.length;
    const answer = await send(confirm(), { bearer: signedUp.access_token });
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body).sort(), ['session', 'status']);
    assert.equal(answer.body.status, 'signed_in');
    const fresh = answer.body.session;
    assert.equal(await sessionAccount(auth, fresh, clock), riley);
    assert.notEqual(fresh.access_token, signedUp.access_token);
    const claims = JSON.parse(Buffer.from(fresh.access_token.split('.')[1], 'base64url').toString());
    assert.deepEqual(claims.amr, [{ method: 'password', timestamp: Math.floor(clock.now / 1000) }], 'signed in with the password just now, as delete-account asks');
    // Whose the session is, from Supabase Auth; the passcode checked for that account; then the sign-in.
    assert.deepEqual(routes(auth.calls.slice(calls)), ['GET /auth/v1/user', 'POST /rest/v1/rpc/crew_confirm_check', 'POST /auth/v1/token']);
    const [user, check] = auth.calls.slice(calls);
    assert.ok(user.authorization === `Bearer ${signedUp.access_token}`, 'Auth is asked about the session the phone sent');
    assert.deepEqual([check.apikey, JSON.parse(check.body).p_user], [SECRET_KEY, riley]);

    // A wrong passcode is counted, as signing in counts one.
    assert.deepEqual((await send(confirm(WRONG), { bearer: signedUp.access_token })).body, { status: 'wrong', tries_left: 4 });
    assert.equal((await countsOf(riley)).wrong_in_a_row, 1);
    // An email account keeps no passcode.
    assert.deepEqual((await send(confirm(), { bearer: auth.tokenFor(company.owner) })).body, { status: 'no_account' });
    // No session, one Supabase Auth did not sign, and one signed out are signed out, and nothing is checked.
    const checks = () => auth.calls.filter((c) => c.path === '/rest/v1/rpc/crew_confirm_check').length;
    const checked = checks();
    const none = await send(confirm());
    assert.deepEqual([none.status, none.body.error], [401, 'signed_out']);
    const forged = await send(confirm(), { bearer: `${b64({ alg: 'none' })}.${b64({ sub: riley })}.` });
    assert.deepEqual([forged.status, forged.body.error], [401, 'signed_out']);
    const old = auth.tokenFor(riley);
    auth.signOut(old);
    const out = await send(confirm(), { bearer: old });
    assert.deepEqual([out.status, out.body.error], [401, 'signed_out']);
    // An account Supabase Auth no longer has is deleted already.
    const gone = (await send(signUp(company.code, 'Pat', 'Cole'))).body.session;
    await db.admin('delete from auth.users where id = $1', [gone.user_id]);
    const deleted = await send(confirm(), { bearer: gone.access_token });
    assert.deepEqual([deleted.status, deleted.body.error], [410, 'already_deleted']);
    assert.equal(checks(), checked);
  });
});

describe('the request', () => {
  it('refuses a browser origin, a body too large, and anything but POST', async () => {
    const { ask, send, auth } = handler();
    assert.equal(MAX_BODY_BYTES, 4096);
    const company = await startCompany(db);
    // A web page's request, whatever it asks, its preflight included: the app sends no Origin.
    for (const origin of ['https://app.minemuster.com', 'https://example.test', 'null']) {
      const answer = await send(lookup(company.code), { origin });
      assert.deepEqual([answer.status, answer.body.error], [403, 'origin_not_allowed']);
      assert.equal(answer.headers.get('access-control-allow-origin'), null);
    }
    const preflight = await ask(new Request(ENDPOINT, { method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'POST' } }));
    assert.deepEqual([preflight.status, preflight.body.error], [403, 'origin_not_allowed']);
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const answer = await ask(new Request(ENDPOINT, { method }));
      assert.deepEqual([answer.status, answer.body.error], [405, 'method_not_allowed'], method);
      assert.equal(answer.headers.get('allow'), 'POST');
    }
    // Larger than 4096 bytes, said to be or found to be while it is read: no more of it is read.
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
    const declared = await ask(new Request(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_BODY_BYTES + 1) }, body: endless(), duplex: 'half' }));
    assert.deepEqual([declared.status, declared.body.error, pulled], [413, 'too_large', 0]);
    const streamed = await ask(new Request(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: endless(), duplex: 'half' }));
    assert.deepEqual([streamed.status, streamed.body.error], [413, 'too_large']);
    assert.ok(pulled <= MAX_BODY_BYTES + 2 * 1024, `read ${pulled} bytes`);
    const body = JSON.stringify(lookup(company.code));
    const long = await send(null, { raw: `${body.slice(0, -1)}${' '.repeat(MAX_BODY_BYTES)}}` });
    assert.deepEqual([long.status, long.body.error], [413, 'too_large']);
    assert.deepEqual(auth.calls, [], 'nothing is asked for a request turned back');
    // At the limit exactly, it is read.
    const exact = await send(null, { raw: `${body.slice(0, -1)}${' '.repeat(MAX_BODY_BYTES - body.length)}}` });
    assert.deepEqual(exact.body, { status: 'company', name: 'Test Pit A', state: 'CA' });
  });

  it('turns back a body that is not one action with the fields it takes, each of them text', async () => {
    const { ask, send, auth } = handler();
    const code = 'ABCD2345';
    const bodies = [
      {},
      { action: 'join', code },
      { action: 'lookup' },
      { action: 'lookup', code, first_name: 'Pat' },
      { action: 'sign_up', code, first_name: 'Pat', last_name: 'Cole' },
      { action: 'sign_in', code, first_name: 'Pat', last_name: 'Cole', passcode: Number(PASSCODE) },
      { action: 'sign_in', code, first_name: 'Pat', last_name: null, passcode: PASSCODE },
      { action: 'reset', code, first_name: 'Pat', last_name: 'Cole', reset_code: '123456', passcode: PASSCODE },
      { action: 'confirm' },
      { action: 'confirm', passcode: PASSCODE, user_id: randomUUID() },
      { action: ['lookup'], code },
    ];
    for (const [i, body] of bodies.entries()) {
      const answer = await send(body);
      assert.deepEqual([answer.status, answer.body.error], [400, 'bad_request'], `body ${i}`);
    }
    for (const [i, raw] of ['', '[]', 'null', '"lookup"', 'not json', '{"action": "lookup", "code": "ABCD2345"'].entries()) {
      const answer = await send(null, { raw });
      assert.deepEqual([answer.status, answer.body.error], [400, 'bad_request'], `raw ${i}`);
    }
    // Bytes that are not UTF-8, and a length that is not a number.
    const bytes = await ask(new Request(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new Uint8Array([0x7b, 0xff, 0x7d]) }));
    assert.deepEqual([bytes.status, bytes.body.error], [400, 'bad_request']);
    const lots = await ask(new Request(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 'lots' }, body: JSON.stringify(lookup(code)) }));
    assert.deepEqual([lots.status, lots.body.error], [400, 'bad_request']);
    assert.deepEqual(auth.calls, []);
  });

  it('answers 500 not_set_up, asking nothing, when the project’s address or a key is missing', async () => {
    for (const env of [
      { ...ENV, SUPABASE_URL: undefined },
      { ...ENV, SUPABASE_SECRET_KEYS: undefined },
      { ...ENV, SUPABASE_PUBLISHABLE_KEYS: undefined },
    ]) {
      const { send, auth, logged } = handler({ env });
      const answer = await send(lookup('ABCD2345'));
      assert.deepEqual([answer.status, answer.body.error], [500, 'not_set_up']);
      assert.deepEqual(auth.calls, []);
      assert.equal(logged.length, 1);
    }
  });
});

describe('the calls it makes', () => {
  it('answers 500 try_again when neither Supabase Auth nor the database can be reached', async () => {
    const logged = [];
    const failing = makeHandler({
      env: (name) => ENV[name],
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      now: () => NOW * 1000,
      log: (line) => logged.push(line),
    });
    for (const [i, request] of [
      post(lookup('ABCD2345')),
      post(signUp('ABCD2345', 'Pat', 'Cole')),
      post(signIn('ABCD2345', 'Pat', 'Cole')),
      post(reset('ABCD2345', 'Pat', 'Cole', '123456', OTHER)),
      post(confirm(), { bearer: 'a.b.c' }),
    ].entries()) {
      const response = await failing(request);
      assert.deepEqual([response.status, (await response.json()).error], [500, 'try_again'], `request ${i}`);
    }
    assert.equal(logged.length, 5);
  });

  it('answers try_again for a check’s answer it does not know, and passes none of it on', async () => {
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const odd = { status: 'something_new', login_email: 'someone@example.test', login_password: 'made-up', tries_left: 3 };
    for (const [route, body] of [
      ['rpc:crew_lookup', lookup(company.code)],
      ['rpc:crew_sign_up_check', signUp(company.code, 'Riley', 'Quinn')],
      ['rpc:crew_sign_in_check', signIn(company.code, 'Riley', 'Quinn')],
      ['rpc:crew_reset_check', reset(company.code, 'Riley', 'Quinn', '000000', OTHER)],
    ]) {
      auth.when(route, () => json(200, odd));
      const answer = await send(body);
      auth.when(route, null);
      assert.deepEqual([answer.status, answer.body.error, answer.body.status], [500, 'try_again', undefined], route);
      assert.doesNotMatch(JSON.stringify(answer.body), /someone@example|made-up/);
    }
    // A sign-in let through with no login to sign in with.
    auth.when('rpc:crew_sign_in_check', () => json(200, { status: 'ok', company_id: company.id, company_name: 'Test Pit A', waiting: false }));
    const noLogin = await send(signIn(company.code, 'Riley', 'Quinn'));
    assert.deepEqual([noLogin.status, noLogin.body.error], [500, 'try_again']);
    assert.ok(!auth.calls.some((c) => c.path === '/auth/v1/token' || c.path === '/auth/v1/admin/users'), 'nobody is signed in or made');
  });

  it('reads when a session expires from expires_in when Supabase Auth gives no expires_at, and takes no session without either', async () => {
    const { send, auth, clock } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const riley = (await send(signUp(company.code, 'Riley', 'Quinn'))).body.session.user_id;
    clock.now += 5 * MINUTE;
    const session = (expiry) => () => json(200, { access_token: auth.tokenFor(riley), token_type: 'bearer', refresh_token: 'r', user: { id: riley }, ...expiry });
    auth.when('token', session({ expires_in: 1800 }));
    const answer = await send(signIn(company.code, 'Riley', 'Quinn'));
    assert.equal(answer.body.session.expires_at, Math.floor(clock.now / 1000) + 1800);
    auth.when('token', session({}));
    const none = await send(signIn(company.code, 'Riley', 'Quinn'));
    assert.deepEqual([none.status, none.body.error], [500, 'try_again']);
    // Confirming takes no session for another account than the one signed in on the phone.
    auth.when('token', () => json(200, { access_token: auth.tokenFor(randomUUID()), token_type: 'bearer', refresh_token: 'r', expires_at: NOW + 3600, user: { id: randomUUID() } }));
    const elsewhere = await send(confirm(), { bearer: auth.tokenFor(riley) });
    assert.deepEqual([elsewhere.status, elsewhere.body.error], [500, 'try_again']);
  });

  it('gives every call to Supabase Auth and the database 15 seconds, and calls each database function by POST', async () => {
    assert.equal(CALL_TIMEOUT_MS, 15_000);
    const { send, auth } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }, { first: 'Lee Roy', last: 'Park' }, { first: 'Roy "Lee"', last: 'Park' }] });
    const limits = [];
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => {
      limits.push(ms);
      return timeout.call(AbortSignal, ms);
    };
    try {
      await send(lookup(company.code));
      await send(signUp(company.code, 'Riley', 'Quinn'));
      // Refused at joining, so the account it made is deleted again.
      await send(signUp(company.code, 'Roy', 'Park'));
      await send(signIn(company.code, 'Riley', 'Quinn'));
      const code = await resetCodeFor(company, 'Riley J Quinn');
      const after = await send(reset(company.code, 'Riley', 'Quinn', code, OTHER));
      await send(confirm(OTHER), { bearer: after.body.session.access_token });
    } finally {
      AbortSignal.timeout = timeout;
    }
    assert.deepEqual([...new Set(auth.calls.map((c) => `${c.method} ${c.path.replace(/[0-9a-f-]{36}$/, '<id>')}`))].sort(), [
      'DELETE /auth/v1/admin/users/<id>',
      'GET /auth/v1/user',
      'POST /auth/v1/admin/users',
      'POST /auth/v1/logout',
      'POST /auth/v1/token',
      'POST /rest/v1/rpc/crew_confirm_check',
      'POST /rest/v1/rpc/crew_keep_passcode',
      'POST /rest/v1/rpc/crew_lookup',
      'POST /rest/v1/rpc/crew_reset_check',
      'POST /rest/v1/rpc/crew_sign_in_check',
      'POST /rest/v1/rpc/crew_sign_up_check',
      'POST /rest/v1/rpc/join_company',
    ]);
    assert.ok(auth.calls.every((c) => c.signal instanceof AbortSignal), 'each call has a time limit');
    assert.equal(limits.length, auth.calls.length);
    assert.ok(limits.every((ms) => ms === CALL_TIMEOUT_MS), 'of 15 seconds');
  });
});

describe('what it says', () => {
  it('never logs a name, passcode, code, address or token', async () => {
    const { send, auth, logged } = handler();
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const addresses = ['203.0.113.77', '198.51.100.77', '2001:db8:7::77'];
    const answers = [];
    let turn = 0;
    const run = async (body, options = {}) => {
      const answer = await send(body, { address: addresses[(turn += 1) % addresses.length], ...options });
      answers.push(answer);
      return answer;
    };
    // Every action, and every way each can go: found, refused, made and deleted again, busy, wrong.
    await run(lookup(company.code));
    await run(lookup('ZZZZZZZZ'));
    await run(signUp(company.code, 'Riley', 'Quinn'));
    await run(signUp(company.code, 'Pat', 'Cole', OTHER));
    await run(signUp(company.code, 'Riley', 'Quinn', THIRD));
    await run(signUp(company.code, 'Jo', 'Vale', '123456'));
    auth.beforeJoin(() => addToRoster(db, company.owner, company.id, { first: 'Kit', last: 'Marlow' }));
    await run(signUp(company.code, 'Kit', 'MarIow'));
    auth.tooManySignIns(true);
    await run(signUp(company.code, 'Jo', 'Vale'));
    await run(signIn(company.code, 'Riley', 'Quinn'));
    auth.tooManySignIns(false);
    await run(signIn(company.code, 'Riley', 'Quinn'));
    await run(signIn(company.code, 'Riley', 'Quinn', WRONG));
    const code = await resetCodeFor(company, 'Riley J Quinn');
    await run(reset(company.code, 'Riley', 'Quinn', otherThan(code), OTHER));
    const done = await run(reset(company.code, 'Riley', 'Quinn', code, OTHER));
    await run(confirm(OTHER), { bearer: done.body.session.access_token });
    await run(confirm(WRONG), { bearer: done.body.session.access_token });
    await run(confirm(OTHER));
    await run({ action: 'lookup', code: company.code, first_name: 'Riley' });

    const madeWith = [...auth.made.values()];
    const accounts = [...auth.made.keys()];
    const tokens = answers.flatMap((a) => (a.body?.session ? [a.body.session.access_token, a.body.session.refresh_token] : []));
    const [{ email: ownerEmail }] = await db.adminRows('select email from auth.users where id = $1', [company.owner]);
    const typedCode = company.code.toLowerCase();
    const secrets = [
      PASSCODE, OTHER, THIRD, WRONG, '123456', code, otherThan(code),
      company.code, typedCode,
      ...addresses,
      ...madeWith.map((m) => m.email), ownerEmail,
      ...madeWith.map((m) => m.password),
      ...tokens,
      SECRET_KEY, PUBLISHABLE,
      ...accounts, company.owner, company.id,
    ];
    const log = logged.join('\n');
    assert.ok(logged.length >= answers.length, 'something is said of each request');
    for (const [i, secret] of secrets.entries()) assert.ok(!log.includes(secret), `the log holds secret ${i}`);
    // The names typed, as words in any case.
    for (const name of ['Riley', 'Quinn', 'Pat', 'Cole', 'Jo', 'Vale', 'Kit', 'MarIow']) assert.doesNotMatch(log, new RegExp(`\\b${name}\\b`, 'i'));

    // The answers never carry a login: neither the hidden address nor its password, nor a key.
    const bodies = answers.map((a) => JSON.stringify(a.body)).join('\n');
    for (const [i, secret] of [...madeWith.map((m) => m.email), ...madeWith.map((m) => m.password), SECRET_KEY, PUBLISHABLE].entries()) {
      assert.ok(!bodies.includes(secret), `an answer holds secret ${i}`);
    }
    assert.doesNotMatch(bodies, /login_email|login_password/);

    // Nor did the log of any test in this file.
    const allLogs = said.logs.join('\n');
    for (const [i, secret] of [...EVER_MADE, PASSCODE, OTHER, THIRD, WRONG, SECRET_KEY, PUBLISHABLE].entries()) assert.ok(!allLogs.includes(secret), `a log holds secret ${i}`);
    assert.doesNotMatch(allLogs, /2001:db8|203\.0\.113|198\.51\.100/, 'no address');
  });
});
