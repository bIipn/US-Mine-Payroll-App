// Stand-ins for Supabase, as far as MineMuster's edge functions reach it, over a local database from
// harness.mjs. A test runs a function's handler under Node, which strips the types from its .ts files
// (there is no Deno here), with the fetch below in place of the real one:
//
//   POST /rest/v1/rpc/<fn>                    PostgREST, by POST only: a GET would run the function in a
//                                             read-only transaction. A function the test names in
//                                             serverFunctions comes with the server key and runs as
//                                             service_role; any other is the person's own, with the
//                                             publishable key and their token, and runs as them. A
//                                             refusal has the HTTP status PostgREST gives its SQLSTATE.
//   GET /auth/v1/user                         whose a token is.
//   DELETE /auth/v1/admin/users/<id>          Auth's admin delete, a hard delete: the auth.users row goes,
//                                             and its foreign keys cascade or set null as they do live.
//   POST /auth/v1/admin/users                 Auth's admin create: an auth.users row, its address
//                                             confirmed when email_confirm is true, and the user answered.
//   POST /auth/v1/token?grant_type=password   the password grant: a session when the password is the one
//                                             crew_login_password works out in the database for the
//                                             address (and the one the account was made with), whose
//                                             access token has a password entry in its amr; 400
//                                             invalid_credentials otherwise, and 429
//                                             over_request_rate_limit while a test turns that switch on.
//   POST /auth/v1/logout?scope=...            signs out the token's own session (local), the other
//                                             sessions of its account (others) or all of them (global).
//   POST /auth/v1/invite                      a stub for supervisor-tools: it makes the account at an
//                                             address that has none, unconfirmed, and answers it; sends
//                                             again to an unconfirmed one; and refuses a confirmed one, 422
//                                             email_exists. Task 7 checks this against Supabase Auth.
//
// Auth answers /auth/v1/user and the admin delete the way Supabase Auth v2.198.0 answered on the private
// local scan stack (scripts/security-scan/stack), 20 November 2026: no token 401 no_authorization; a
// token it did not sign 403 bad_jwt; a deleted account's token 403 user_not_found; a signed-out
// session's token 403 session_not_found; the admin delete 200 {} when it goes through, and 500 carrying
// the database's own code (23514) when the last-supervisor guard refuses it. Supabase's gateway, which
// refuses a key before Auth sees the request, answers 401 with a message and no error_code. An access
// token's amr is [{ method: 'password', timestamp }], the sign-in's time, kept through every refresh of
// its session. The admin create, the password grant, the sign-out and the invite answer in the shapes of
// Supabase Auth's API, which no live or local Auth has been asked here.
//
// Each route's own checks of what was sent (the key, the method, the body) are made first; then a test's
// own answer for the route, when it has put one in place (when); then the route's own answer, which a
// test's answer can also have made first (proceed), for an answer lost on its way back.
//
// The keys, tokens and ids here are made up.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

export const SUPABASE_URL = 'https://project.example.test';
export const PUBLISHABLE_KEY = 'sb_publishable_test_madeup';
export const SECRET_KEY = 'sb_secret_test_madeup';
/** What Supabase gives every edge function, as supabase/functions/_shared/server.ts reads it. */
export const ENV = {
  SUPABASE_URL,
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }),
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE_KEY }),
};
/** The functions' clock, in seconds. */
export const NOW = 1795000000;

export const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
export const json = (status, body) =>
  body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const bearer = (headers) => /^Bearer (\S+)$/.exec(headers.get('authorization') ?? '')?.[1] ?? null;
/** The HTTP status PostgREST gives a SQLSTATE: PTnnn is nnn, 42501 is 403 with a token, 22023 and 23514 are 400. */
export const statusOf = (code) => (/^PT\d{3}$/.test(code) ? Number(code.slice(2)) : code === '42501' ? 403 : /^(22|23)/.test(code) ? 400 : 500);

/** A crew account's sign-in password, worked out in the database from its hidden address. */
export const crewLoginPassword = async (db, email) => (await db.adminRows('select public.crew_login_password($1) as password', [email]))[0].password;

/** The admin deletes among a stand-in's calls. */
export const adminDeletes = (calls) => calls.filter((c) => c.method === 'DELETE');

/** The route a call goes to, as the stand-in and the tests name it. */
export function routeOf(method, path) {
  if (path.startsWith('/rest/v1/rpc/')) return `rpc:${path.slice('/rest/v1/rpc/'.length)}`;
  if (path === '/auth/v1/user') return 'user';
  if (path === '/auth/v1/admin/users' && method === 'POST') return 'admin_create';
  if (path.startsWith('/auth/v1/admin/users/') && method === 'DELETE') return 'admin_delete';
  if (path === '/auth/v1/token' && method === 'POST') return 'token';
  if (path === '/auth/v1/logout' && method === 'POST') return 'logout';
  if (path === '/auth/v1/invite' && method === 'POST') return 'invite';
  return 'unknown';
}

/**
 * Supabase, as far as a function reaches it, over the local database `db`. `clock.now` is the function's
 * clock in milliseconds. `serverFunctions` are the database functions the function calls with the server
 * key. `said`, when given, collects every token minted (said.minted) and every account made (said.made) in
 * the file, for its checks of what is logged.
 */
export function supabase(db, { clock, serverFunctions = [], said = null }) {
  const asServer = new Set(serverFunctions);
  /** Access tokens Supabase Auth signed: the account and the session of each. */
  const tokens = new Map();
  const signedOut = new Set();
  /** What the admin create was given for each account it made. */
  const made = new Map();
  const calls = [];
  const logouts = [];
  const invites = [];
  /** A test's own answer for a route, in place of the route's own. */
  const instead = new Map();
  let tooMany = false;
  const record = (list, value) => said?.[list]?.push(value);

  /**
   * An access token for an account, as Supabase Auth signs one at a password sign-in this many seconds
   * ago, in a session of its own. `databaseAmr` is the amr the database is handed instead, on its own clock.
   */
  const tokenFor = (sub, { typedAgo = 5, amr, noAmr = false, databaseAmr, session = randomUUID() } = {}) => {
    const at = Math.floor(clock.now / 1000) - typedAgo;
    const claims = { sub, aud: 'authenticated', role: 'authenticated', iat: at, exp: at + 3600, session_id: session, aal: 'aal1' };
    if (!noAmr) claims.amr = amr ?? [{ method: 'password', timestamp: at }];
    const token = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'test' })}.${b64(claims)}.${randomBytes(32).toString('base64url')}`;
    tokens.set(token, { sub, session, amr: claims.amr, databaseAmr });
    record('minted', token);
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
  const refusedForAuth = {
    bad_jwt: 'invalid JWT: unable to parse or verify signature',
    session_not_found: 'Session from session_id claim in JWT does not exist',
    user_not_found: 'User from sub claim in JWT does not exist',
  };

  /** What each route checks of what it was sent, before anything else. */
  function check(route, call, init, searchParams) {
    if (route.startsWith('rpc:')) {
      assert.equal(call.method, 'POST', 'a database function is called by POST: a GET runs it in a read-only transaction');
      if (asServer.has(route.slice('rpc:'.length))) {
        assert.equal(call.apikey, SECRET_KEY, `${route} goes with the server key`);
        assert.equal(call.authorization, null, 'a secret key is sent as apikey only');
      } else {
        assert.equal(call.apikey, PUBLISHABLE_KEY, 'the person’s own calls go with the publishable key');
      }
    } else if (route === 'user') {
      assert.equal(call.apikey, PUBLISHABLE_KEY, 'Auth is asked with the publishable key');
    } else if (route === 'admin_create' || route === 'invite') {
      assert.equal(call.apikey, SECRET_KEY, `the ${route === 'invite' ? 'invite' : 'admin create'} goes with the server key`);
      assert.equal(call.authorization, null, 'a secret key is sent as apikey only');
    } else if (route === 'admin_delete') {
      assert.equal(call.apikey, SECRET_KEY, 'the admin delete goes with the server key');
      assert.equal(call.authorization, null, 'a secret key is sent as apikey only');
      assert.deepEqual(JSON.parse(init.body), { should_soft_delete: false });
    } else if (route === 'token') {
      assert.equal(searchParams.get('grant_type'), 'password');
      assert.equal(call.apikey, PUBLISHABLE_KEY, 'a sign-in goes with the publishable key, as a phone’s own would');
    } else if (route === 'logout') {
      assert.equal(call.apikey, PUBLISHABLE_KEY, 'a sign-out goes with the publishable key and the session’s own token');
    }
  }

  /** Each route's own answer. */
  async function answer(route, call, init, searchParams, headers) {
    const held = tokens.get(bearer(headers) ?? '');

    if (route === 'user') {
      if (!bearer(headers)) return json(401, { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a valid Bearer token' });
      const found = await whose(bearer(headers));
      if (found.error_code) return json(403, { code: 403, error_code: found.error_code, msg: refusedForAuth[found.error_code] });
      const [user] = await db.adminRows('select id, email from auth.users where id = $1', [found.sub]);
      return json(200, { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: appMetadataOf(user.id) });
    }

    if (route.startsWith('rpc:')) {
      const name = route.slice('rpc:'.length);
      let as;
      if (asServer.has(name)) {
        as = db.serviceRole();
      } else {
        // PostgREST takes any token the project signed until it expires: it does not ask Auth.
        if (!held) return json(401, { code: 'PGRST301', message: 'JWT could not be decoded' });
        // The token's amr goes to the database as request.jwt.claims, as PostgREST hands it over. The
        // database keeps real time and these tests a clock of their own, so each time is moved by the
        // difference: the sign-in is as old to the database as it is to the function.
        const shift = Math.floor(Date.now() / 1000) - Math.floor(clock.now / 1000);
        const amr =
          held.databaseAmr ?? (Array.isArray(held.amr) ? held.amr.map((e) => (e && typeof e.timestamp === 'number' ? { ...e, timestamp: e.timestamp + shift } : e)) : held.amr);
        as = db.as(held.sub, amr === undefined ? {} : { amr });
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
      const body = JSON.parse(init.body);
      const [taken] = await db.adminRows('select id from auth.users where lower(email) = lower($1)', [body.email]);
      if (taken) return json(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
      const id = randomUUID();
      await db.admin('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, case when $3::boolean then now() end)', [id, body.email, body.email_confirm === true]);
      const app_metadata = { provider: 'email', providers: ['email'], ...(body.app_metadata ?? {}) };
      made.set(id, { email: body.email, password: body.password, email_confirm: body.email_confirm, app_metadata });
      record('made', { id, email: body.email, password: body.password });
      const [user] = await db.adminRows('select email_confirmed_at from auth.users where id = $1', [id]);
      return json(200, { id, aud: 'authenticated', role: 'authenticated', email: body.email, email_confirmed_at: user.email_confirmed_at, app_metadata, user_metadata: {}, identities: [] });
    }

    if (route === 'token') {
      if (tooMany) return json(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' });
      const { email, password } = JSON.parse(init.body);
      const invalid = () => json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      const [user] = await db.adminRows('select id, email from auth.users where lower(email) = lower($1)', [typeof email === 'string' ? email : '']);
      if (!user || typeof password !== 'string') return invalid();
      if (password !== (await crewLoginPassword(db, user.email))) return invalid();
      if (made.has(user.id) && made.get(user.id).password !== password) return invalid();
      const at = Math.floor(clock.now / 1000);
      const refresh = randomBytes(16).toString('hex');
      record('minted', refresh);
      return json(200, {
        access_token: tokenFor(user.id, { typedAgo: 0 }),
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: at + 3600,
        refresh_token: refresh,
        user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: appMetadataOf(user.id) },
      });
    }

    if (route === 'logout') {
      const found = await whose(bearer(headers));
      if (!found.sub) return json(403, { code: 403, error_code: found.error_code, msg: refusedForAuth[found.error_code] });
      const scope = searchParams.get('scope') ?? 'global';
      logouts.push({ scope, sub: held.sub, session: held.session });
      for (const other of tokens.values()) {
        if (other.sub !== held.sub) continue;
        if (scope === 'global' || (scope === 'others') === (other.session !== held.session)) signedOut.add(other.session);
      }
      return json(204);
    }

    if (route === 'admin_delete') {
      const id = decodeURIComponent(call.path.slice('/auth/v1/admin/users/'.length));
      try {
        const removed = await db.admin('delete from auth.users where id = $1', [id]);
        return removed.affectedRows ? json(200, {}) : json(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
      } catch (error) {
        return json(500, { code: error.code, msg: error.message });
      }
    }

    if (route === 'invite') {
      const { email, data } = JSON.parse(init.body);
      invites.push({ email, data, redirect_to: searchParams.get('redirect_to') });
      const [user] = await db.adminRows('select id, email_confirmed_at from auth.users where lower(email) = lower($1)', [email]);
      if (user?.email_confirmed_at) return json(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
      const id = user?.id ?? randomUUID();
      if (!user) await db.admin('insert into auth.users (id, email) values ($1, $2)', [id, email]);
      return json(200, { id, aud: 'authenticated', role: 'authenticated', email, invited_at: new Date(clock.now).toISOString(), user_metadata: data ?? {} });
    }

    return json(404, { message: 'no such route' });
  }

  const fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const headers = new Headers(init.headers);
    const call = {
      method: init.method ?? 'GET',
      path: pathname,
      query: searchParams.toString(),
      apikey: headers.get('apikey'),
      authorization: headers.get('authorization'),
      body: init.body ?? null,
      signal: init.signal ?? null,
    };
    calls.push(call);
    const route = routeOf(call.method, pathname);
    check(route, call, init, searchParams);
    const own = () => answer(route, call, init, searchParams, headers);
    const theirs = instead.get(route);
    if (theirs) {
      const id = route === 'admin_delete' ? decodeURIComponent(pathname.slice('/auth/v1/admin/users/'.length)) : null;
      const reply = await theirs(call, { sub: tokens.get(bearer(headers) ?? '')?.sub ?? null, id, proceed: own });
      if (reply) return reply;
    }
    return own();
  };

  return {
    fetch,
    calls,
    made,
    logouts,
    invites,
    tokenFor,
    /** The account Supabase Auth says a token signs in, or null. Not a call of the function's. */
    accountOf: async (token) => (await whose(token)).sub ?? null,
    /** The session is signed out: Auth turns its token down, and PostgREST still takes it until it expires. */
    signOut: (token) => signedOut.add(tokens.get(token).session),
    /** The switch: the password grant answers 429, too many sign-ins, while it is on. */
    tooManySignIns: (on) => (tooMany = on),
    /**
     * A test's own answer for a route ('rpc:<name>', 'user', 'admin_create', 'admin_delete', 'token',
     * 'logout', 'invite'), or null to take it off. It gets the call and { sub, id, proceed }: the token's
     * account, the account an admin delete names, and the route's own answer, to make first. It answers,
     * or returns null to let the route answer.
     */
    when: (route, theirs) => (theirs ? instead.set(route, theirs) : instead.delete(route)),
  };
}

/**
 * An edge function's handler, made with makeHandler and run on the stand-in: `ask(request)` hands it a
 * request and reads its JSON answer. `said`, when given, is the file's record of what was logged (logs)
 * and answered (bodies). `fetch` takes the stand-in's place, for a server that cannot be reached.
 */
export function serveFunction(makeHandler, db, { env = ENV, said = null, serverFunctions = [], fetch = null } = {}) {
  const clock = { now: NOW * 1000 };
  const auth = supabase(db, { clock, serverFunctions, said });
  const logged = [];
  const handle = makeHandler({
    env: (name) => env[name],
    fetch: fetch ?? auth.fetch,
    now: () => clock.now,
    log: (line) => {
      logged.push(line);
      said?.logs?.push(line);
    },
  });
  const ask = async (request) => {
    const response = await handle(request);
    const text = await response.text();
    said?.bodies?.push(text);
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return { ask, handle, auth, clock, logged };
}
