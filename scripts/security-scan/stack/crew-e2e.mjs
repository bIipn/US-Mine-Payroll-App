// The crew sign-in, end to end, on the private local copy of the server: the crew-auth,
// supervisor-tools and delete-account edge functions, served from their own handler.ts by
// functions-server.mjs, against the real Supabase Auth and PostgREST, through the gateway. Each flow is
// acted out the way the app, the dashboard and a supervisor act it out, and checked in the database and
// with Supabase Auth's admin API. Everything is on 127.0.0.1.
//
//   MINEMUSTER_SCAN_STACK_DIR=<private folder> node scripts/security-scan/stack/stack.mjs crew-e2e
//   MINEMUSTER_SCAN_STACK_DIR=<private folder> node scripts/security-scan/stack/crew-e2e.mjs
//
// Run it on a stack just started or reset: it puts made-up people on Test Pit A's roster and stops if
// they are there already, and it needs Supabase Auth's sign-in limit for 127.0.0.1 unspent, which a
// reset clears. It changes the data, and spends that limit on purpose at the end: run reset afterwards.
//
// Every call made to Supabase Auth, by a function (functions-server.mjs notes those in
// run/auth-calls.jsonl) or by this script, is kept as its status, the shape of its body (each key and
// the type of its value) and Auth's error_code, and compared with what supabase/tests/stand-ins.mjs,
// which the functions' tests run against, answers the same call. Every difference is listed: a status,
// an error_code or a key a function reads that differs is counted as a failure.
//
// What it prints, and crew-e2e.txt and crew-e2e.json in the stack's folder, hold no token, key,
// password, passcode, reset code, join code or id. Every name is made up, in the style of
// supabase/tests: the repository is public.

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTAINERS, GATEWAY_URL, authCallNote, call, docker, errorCodeOf, lit, loadSecrets, paths, readJson, shapeOf, sql, writePrivate } from './lib.mjs';
import * as standIns from '../../../supabase/tests/stand-ins.mjs';

/** The office dashboard, the one web page that may call supervisor-tools and delete-account. */
const DASHBOARD = 'https://app.minemuster.com';
/** Where the invite email's link lands (INVITE_LINK in supervisor-tools). */
const INVITE_LINK = `${DASHBOARD}/?invited=1`;
/** A crew account's hidden address, as crew_sign_up_check makes it. */
const HIDDEN_ADDRESS = /^crew-[0-9a-f]{32}@crew\.minemuster\.com$/;

/** The made-up people this puts on Test Pit A's roster, beside the seed's supervisor, Sam Ortiz. */
const PEOPLE = {
  lee: { first: 'Lee', last: 'Park', title: 'Loader operator', role: 'employee' },
  maria: { first: 'Maria', last: 'De La Cruz', title: 'Crusher operator', role: 'employee' },
  pat: { first: 'Pat', last: 'Cole', title: 'Crusher operator', role: 'employee' },
  dana: { first: 'Dana', last: 'Hollis', title: 'Plant supervisor', role: 'supervisor' },
};
const nameOf = (person) => `${person.first} ${person.last}`;

/** The situations of Supabase Auth's calls the stand-in plays, in words. */
const SITUATIONS = {
  'user:valid': 'GET /auth/v1/user with a valid token of an email account',
  'user:crew': 'GET /auth/v1/user with a valid token of a crew account',
  'user:signed_out': 'GET /auth/v1/user with the token of a session signed out',
  'user:deleted': 'GET /auth/v1/user with the token of an account deleted',
  'admin_create:new': 'POST /auth/v1/admin/users, a new hidden address',
  'token:right': 'POST /auth/v1/token?grant_type=password, an email account\'s right password',
  'token:crew': 'POST /auth/v1/token?grant_type=password, a crew account\'s right password',
  'token:wrong': 'POST /auth/v1/token?grant_type=password, an address with no account',
  'token:busy': 'POST /auth/v1/token?grant_type=password, past Auth\'s limit for the address',
  'logout:others': 'POST /auth/v1/logout?scope=others',
  'admin_delete:exists': 'DELETE /auth/v1/admin/users/<id> of an account there',
  'invite:new': 'POST /auth/v1/invite, an address with no account',
  'invite:unconfirmed': 'POST /auth/v1/invite, an address whose account is not confirmed',
};

/** What of each Auth answer a function reads (supabase/functions): a difference there changes what it does. */
const READ = {
  user: ['id', 'error_code'],
  admin_create: ['id', 'error_code'],
  token: ['access_token', 'refresh_token', 'expires_at', 'expires_in', 'user', 'user.id', 'error_code'],
  logout: [],
  admin_delete: ['error_code', 'msg', 'message', 'code'],
  invite: ['error_code'],
};

/** A JSON shape as the report shows it: its keys, an object's own keys in braces and an array's element in brackets. */
function keysOf(shape) {
  if (Array.isArray(shape)) return shape.length ? `[${keysOf(shape[0])}]` : '[]';
  if (shape && typeof shape === 'object') return `{${Object.entries(shape).map(([key, value]) => `${key}${typeof value === 'object' && value !== null ? keysOf(value) : ''}`).join(', ')}}`;
  return shape === 'null' ? '(no body)' : '';
}

/** Every path of a shape, with the type at it. */
function pathsOf(shape) {
  const out = new Map();
  const walk = (value, at) => {
    if (Array.isArray(value)) {
      out.set(at, 'array');
      if (value.length) walk(value[0], `${at}[]`);
    } else if (value && typeof value === 'object') {
      if (at) out.set(at, 'object');
      for (const [key, inner] of Object.entries(value)) walk(inner, at ? `${at}.${key}` : key);
    } else {
      out.set(at || '(body)', value);
    }
  };
  walk(shape, '');
  return out;
}

/** How Auth's answer differs from the stand-in's: status, error_code, keys only one has, and types that differ. */
function compare(route, real, stand) {
  const mine = pathsOf(real.shape);
  const theirs = pathsOf(stand.shape);
  const onlyAuth = [...mine.keys()].filter((key) => !theirs.has(key));
  const onlyStandIn = [...theirs.keys()].filter((key) => !mine.has(key));
  const types = [...mine.keys()].filter((key) => theirs.has(key) && mine.get(key) !== theirs.get(key)).map((key) => `${key}: ${mine.get(key)} here, ${theirs.get(key)} in the stand-in`);
  const read = READ[route] ?? [];
  const readDiffers = [...onlyAuth, ...onlyStandIn, ...types.map((line) => line.split(':')[0])].filter((key) => read.includes(key));
  const statusDiffers = real.status !== stand.status;
  const codeDiffers = real.error_code !== stand.error_code;
  return {
    same: !statusDiffers && !codeDiffers && !onlyAuth.length && !onlyStandIn.length && !types.length,
    material: statusDiffers || codeDiffers || readDiffers.length > 0,
    statusDiffers,
    codeDiffers,
    onlyAuth,
    onlyStandIn,
    types,
    readDiffers,
  };
}

/**
 * A database for the stand-in, in memory, holding auth.users alone: the stand-in's Auth routes ask it
 * nothing else. A question it does not know stops that one comparison, which then says so.
 */
function memoryAuth() {
  const users = new Map();
  const byEmail = (email) => [...users.values()].find((user) => user.email.toLowerCase() === String(email).toLowerCase());
  const flat = (text) => text.replace(/\s+/g, ' ').trim();
  const pick = (user, keys) => (user ? [Object.fromEntries(keys.map((key) => [key, user[key]]))] : []);
  return {
    users,
    add({ email, password = null, confirmed = true }) {
      const id = randomUUID();
      users.set(id, { id, email, password, email_confirmed_at: confirmed ? new Date().toISOString() : null });
      return id;
    },
    async adminRows(text, params = []) {
      const asked = flat(text);
      if (asked === 'select id from auth.users where id = $1') return pick(users.get(params[0]), ['id']);
      if (asked === 'select id, email from auth.users where id = $1') return pick(users.get(params[0]), ['id', 'email']);
      if (asked === 'select email_confirmed_at from auth.users where id = $1') return pick(users.get(params[0]), ['email_confirmed_at']);
      if (asked === 'select id from auth.users where lower(email) = lower($1)') return pick(byEmail(params[0]), ['id']);
      if (asked === 'select id, email from auth.users where lower(email) = lower($1)') return pick(byEmail(params[0]), ['id', 'email']);
      if (asked === 'select id, email_confirmed_at from auth.users where lower(email) = lower($1)') return pick(byEmail(params[0]), ['id', 'email_confirmed_at']);
      if (asked === 'select public.crew_login_password($1) as password') return [{ password: byEmail(params[0])?.password ?? null }];
      throw new Error(`the stand-in asked its database something this comparison does not play: ${asked.slice(0, 80)}`);
    },
    async admin(text, params = []) {
      const asked = flat(text);
      if (asked === 'insert into auth.users (id, email, email_confirmed_at) values ($1, $2, case when $3::boolean then now() end)') {
        users.set(params[0], { id: params[0], email: params[1], password: null, email_confirmed_at: params[2] ? new Date().toISOString() : null });
        return { affectedRows: 1 };
      }
      if (asked === 'insert into auth.users (id, email) values ($1, $2)') {
        users.set(params[0], { id: params[0], email: params[1], password: null, email_confirmed_at: null });
        return { affectedRows: 1 };
      }
      if (asked === 'delete from auth.users where id = $1') return { affectedRows: users.delete(params[0]) ? 1 : 0 };
      throw new Error(`the stand-in asked its database something this comparison does not play: ${asked.slice(0, 80)}`);
    },
  };
}

/** What supabase/tests/stand-ins.mjs answers in a situation: its status, the shape of its body and its error_code. */
async function standInAnswer(situation) {
  const S = standIns;
  const db = memoryAuth();
  const auth = S.supabase(db, { clock: { now: Date.now() } });
  const ask = (method, route, { key, token, body } = {}) =>
    auth.fetch(`${S.SUPABASE_URL}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { apikey: key } : null), ...(token ? { Authorization: `Bearer ${token}` } : null) },
      ...(body === undefined ? null : { body: JSON.stringify(body) }),
    });
  const someone = (confirmed = true, password = null) => db.add({ email: `someone-${randomBytes(4).toString('hex')}@example.com`, confirmed, password });
  /** A crew account, made as crew-auth makes one: by the stand-in's own admin create, which keeps its app_metadata. */
  const crewAccount = async () => {
    const email = `crew-${randomBytes(16).toString('hex')}@crew.minemuster.com`;
    const made = await (await ask('POST', '/auth/v1/admin/users', { key: S.SECRET_KEY, body: { email, password: 'made-up', email_confirm: true, app_metadata: { sign_in: 'passcode' } } })).json();
    db.users.get(made.id).password = 'made-up';
    return { id: made.id, email };
  };
  const grant = (email, password) => ask('POST', '/auth/v1/token?grant_type=password', { key: S.PUBLISHABLE_KEY, body: { email, password } });
  const invite = (email) => ask('POST', `/auth/v1/invite?redirect_to=${encodeURIComponent(INVITE_LINK)}`, { key: S.SECRET_KEY, body: { email, data: { company_name: 'Test Pit A' } } });
  let reply;
  if (situation === 'user:valid') reply = await ask('GET', '/auth/v1/user', { key: S.PUBLISHABLE_KEY, token: auth.tokenFor(someone()) });
  else if (situation === 'user:crew') reply = await ask('GET', '/auth/v1/user', { key: S.PUBLISHABLE_KEY, token: auth.tokenFor((await crewAccount()).id) });
  else if (situation === 'user:signed_out') {
    const token = auth.tokenFor(someone());
    auth.signOut(token);
    reply = await ask('GET', '/auth/v1/user', { key: S.PUBLISHABLE_KEY, token });
  } else if (situation === 'user:deleted') {
    const id = someone();
    const token = auth.tokenFor(id);
    db.users.delete(id);
    reply = await ask('GET', '/auth/v1/user', { key: S.PUBLISHABLE_KEY, token });
  } else if (situation === 'admin_create:new') {
    reply = await ask('POST', '/auth/v1/admin/users', {
      key: S.SECRET_KEY,
      body: { email: `crew-${randomBytes(16).toString('hex')}@crew.minemuster.com`, password: 'made-up', email_confirm: true, app_metadata: { sign_in: 'passcode' } },
    });
  } else if (situation === 'token:right') {
    const email = `someone-${randomBytes(4).toString('hex')}@example.com`;
    db.add({ email, password: 'made-up', confirmed: true });
    reply = await grant(email, 'made-up');
  } else if (situation === 'token:crew') reply = await grant((await crewAccount()).email, 'made-up');
  else if (situation === 'token:wrong') reply = await grant('nobody@example.com', 'not-the-password');
  else if (situation === 'token:busy') {
    auth.tooManySignIns(true);
    reply = await grant('nobody@example.com', 'not-the-password');
  } else if (situation === 'logout:others') reply = await ask('POST', '/auth/v1/logout?scope=others', { key: S.PUBLISHABLE_KEY, token: auth.tokenFor(someone()) });
  else if (situation === 'admin_delete:exists') reply = await ask('DELETE', `/auth/v1/admin/users/${someone()}`, { key: S.SECRET_KEY, body: { should_soft_delete: false } });
  else if (situation === 'invite:new') reply = await invite('someone-new@example.com');
  else if (situation === 'invite:unconfirmed') {
    const email = `someone-${randomBytes(4).toString('hex')}@example.com`;
    db.add({ email, confirmed: false });
    reply = await invite(email);
  } else return null;
  const text = await reply.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: reply.status, shape: shapeOf(body), error_code: errorCodeOf(body) };
}

/** A passcode the server's rule takes (crew_passcode_problem): 8 random digits, drawn again while it is a pattern. */
function newPasscode(not = []) {
  for (;;) {
    const passcode = String(randomInt(0, 1e8)).padStart(8, '0');
    if (!not.includes(passcode) && sql(`select public.crew_passcode_problem(${lit(passcode)}) is null`) === 't') return passcode;
  }
}

export async function crewE2e(secrets, files) {
  const fixtures = readJson(files.fixtures);
  const key = secrets.publishableKey;
  const A = fixtures.companies.A;
  const sam = fixtures.accounts.A1;
  const lines = [];
  const checks = [];
  const authCalls = [];
  const functionCalls = [];
  let flow = '';

  const show = (text) => {
    lines.push(text);
    process.stdout.write(`${text}\n`);
  };
  /** One check: whether it held, and what came back, in words that hold nothing private. */
  const check = (what, held, detail = '') => {
    checks.push({ flow, what, held: Boolean(held) });
    show(`${held ? 'ok  ' : 'FAIL'} ${what}${detail ? `\n       -> ${detail}` : ''}`);
    return Boolean(held);
  };
  const note = (text) => show(`     ${text}`);

  // ---- Requests -------------------------------------------------------------------------------

  /** A call this script makes to Supabase Auth, kept as its status, the shape of its body and its error_code. */
  async function toAuth(method, route, options, situation = null) {
    const answer = await call(method, route, options);
    const noted = authCallNote(method, `${GATEWAY_URL}${route}`, answer.status, answer.text);
    authCalls.push({ flow, by: 'this script', ...noted, route: standIns.routeOf(method, noted.path), situation });
    return answer;
  }

  const AUTH_CALLS = path.join(files.run, 'auth-calls.jsonl');
  const notedCalls = () => (fs.existsSync(AUTH_CALLS) ? fs.readFileSync(AUTH_CALLS, 'utf8').split('\n').filter(Boolean) : []);

  /**
   * A request to an edge function through the gateway, with the publishable key as the app and the
   * dashboard send it. `auth` is the calls to Supabase Auth it should make, as situations
   * ('token:right'): what it made is read from functions-server.mjs's notes and checked against them.
   */
  async function fn(name, body, { token, origin, headers = {}, auth = [], method = 'POST' } = {}) {
    const before = notedCalls().length;
    const answer = await call(method, `/functions/v1/${name}`, { key, token, body, headers: { ...(origin ? { Origin: origin } : null), ...headers } });
    const made = notedCalls().slice(before).map((line) => JSON.parse(line));
    const routes = made.map((one) => standIns.routeOf(one.method, one.path));
    made.forEach((one, i) => authCalls.push({ flow, by: name, ...one, route: routes[i], situation: auth[i] ?? null }));
    const wanted = auth.map((situation) => situation.split(':')[0]);
    functionCalls.push({ flow, fn: name, action: body?.action ?? null, status: answer.status, body: shapeOf(answer.json), auth: made.map((one) => `${one.method} ${one.path} ${one.status}`) });
    return { ...answer, made, authRight: JSON.stringify(routes) === JSON.stringify(wanted) };
  }

  /** A function's answer for the report: its status and its body's keys, with the values that are words or counts. */
  function told(answer) {
    const body = answer.json && typeof answer.json === 'object' && !Array.isArray(answer.json) ? answer.json : null;
    if (!body) return `${answer.status} ${answer.text ? '(not JSON)' : '(no body)'}`;
    const words = ['status', 'error', 'tries_left', 'others_signed_out', 'waiting', 'deleted'].filter((k) => k in body).map((k) => `${k} ${JSON.stringify(body[k])}`);
    if ('until' in body) words.push(`until ${body.until === null ? 'null' : 'a time'}`);
    if (body.join && typeof body.join === 'object') words.push(`join ${body.join.status}`);
    if (body.company && typeof body.company === 'object') words.push(`company ${body.company.name}`);
    if (typeof body.name === 'string') words.push(`name ${body.name}, state ${body.state}`);
    if (Array.isArray(body.closed)) words.push(`closed ${body.closed.length}`);
    return `${answer.status} {${Object.keys(body).join(', ')}}${words.length ? `: ${words.join(', ')}` : ''}`;
  }
  /** The calls a function made to Supabase Auth, as the report shows them. */
  const madeOf = (answer) => (answer.made.length ? answer.made.map((one) => `${one.method} ${one.path}${one.query.length ? `?${one.query.join('&')}` : ''} ${one.status}${one.error_code ? ` ${one.error_code}` : ''}`).join(', ') : 'none');
  const toldWithAuth = (answer) => `${told(answer)}\n       -> Auth: ${madeOf(answer)}`;

  const crew = (body, options = {}) => fn('crew-auth', body, options);
  const rest = (method, route, token, body, headers = {}) => call(method, `/rest/v1/${route}`, { key, token, body, headers });
  const rpc = (name, token, body = {}) => rest('POST', `rpc/${name}`, token, body);
  const asServer = (name, body) => call('POST', `/rest/v1/rpc/${name}`, { key: secrets.secretKey, body });
  const signInWith = async (email, password) => {
    const answer = await toAuth('POST', '/auth/v1/token?grant_type=password', { key, body: { email, password } }, 'token:right');
    return answer.status === 200 ? { access_token: answer.json.access_token, refresh_token: answer.json.refresh_token, user_id: answer.json.user?.id } : null;
  };
  const refresh = (session, situation = null) => toAuth('POST', '/auth/v1/token?grant_type=refresh_token', { key, body: { refresh_token: session.refresh_token } }, situation);
  const whoIs = (token, situation) => toAuth('GET', '/auth/v1/user', { key, token }, situation);
  const adminUser = (id) => toAuth('GET', `/auth/v1/admin/users/${id}`, { key: secrets.secretKey });
  const sessionOf = (answer) => answer.json?.session ?? null;

  // ---- The database, read as the owner ---------------------------------------------------------

  const first = (text) => sql(text).split('\n')[0];
  const rosterRow = (id) => first(`select coalesce(user_id::text, ''), role, active from public.roster where id = ${lit(id)}`).split('|');
  /** crew-auth requests counted from an address in the last 10 minutes: its digest is made with the crew key, as crew_try_counted makes it. */
  const counted = (address) => Number(first(`select count(*) from public.crew_sign_in_tries t, public.crew_key k
    where t.sender = pg_catalog.sha256(k.key || pg_catalog.convert_to(pg_catalog.lower(pg_catalog.btrim(${lit(address)})), 'UTF8'))
      and t.at > pg_catalog.now() - interval '10 minutes'`));
  /** Supabase Auth's own log, each line as its level, message, path, method, status and error, nothing else: what a call added is the lines after the count before it. */
  const authLog = () => {
    const logged = docker(['logs', CONTAINERS.auth], { allowFail: true });
    return `${logged.stdout}\n${logged.stderr}`.split('\n').filter(Boolean).flatMap((line) => {
      try {
        const { level, msg, path: at, method, status, error, component } = JSON.parse(line);
        return [{ level, msg, path: at, method, status, error, component }];
      } catch {
        return [];
      }
    });
  };

  // ---- Before anything: the seeded state ------------------------------------------------------

  show(`The crew sign-in end to end on the local scan stack, ${new Date().toISOString()}. Every name is made up.`);
  show('Run on a stack just started or reset. No token, key, password, passcode, reset code or id is printed.\n');
  const already = Number(first(`select count(*) from public.roster where company_id = ${lit(A.id)} and (first_name, last_name) in (${Object.values(PEOPLE).map((p) => `(${lit(p.first)}, ${lit(p.last)})`).join(', ')})`));
  const crewAccounts = Number(first('select count(*) from public.crew_logins'));
  if (already || crewAccounts) {
    show(`This stack has been used since it was seeded (${already} of the made-up rows, ${crewAccounts} crew sign-in(s)). Run reset first, then this again.`);
    process.exitCode = 1;
    return;
  }

  // ---- 0. The supervisor and the roster ---------------------------------------------------------

  flow = '0';
  show('-- 0. The supervisor, Sam Ortiz (the seed\'s A1), signs in and puts four made-up people on Test Pit A\'s roster');
  const samSession = await signInWith(sam.email, sam.password);
  check('Sam Ortiz signs in with his email address and password', samSession);
  const rows = {};
  for (const [label, person] of Object.entries(PEOPLE)) {
    const made = await rest('POST', 'roster?select=id', samSession?.access_token, { company_id: A.id, first_name: person.first, last_name: person.last, title: person.title, role: person.role, active: true }, { Prefer: 'return=representation' });
    rows[label] = made.json?.[0]?.id;
    check(`${person.role === 'supervisor' ? 'a supervisor' : 'an employee'}'s row for ${nameOf(person)}, through PostgREST`, made.status === 201 && rows[label], `${made.status}`);
  }

  // ---- 1. Looking up the code -------------------------------------------------------------------

  flow = '1';
  show('\n-- 1. crew-auth lookup, with the publishable key alone, as the app sends it');
  const found = await crew({ action: 'lookup', code: A.joinCode });
  check('lookup with Test Pit A\'s code: the company\'s name and state, and no call to Auth', found.status === 200 && found.json?.status === 'company' && found.json.name === 'Test Pit A' && found.json.state === 'CA' && found.authRight, toldWithAuth(found));
  const notFound = await crew({ action: 'lookup', code: 'ZZZZ-ZZZZ' });
  check('lookup with a code no company has: no_company', notFound.status === 200 && notFound.json?.status === 'no_company' && notFound.authRight, told(notFound));

  // ---- 2. Signing up ----------------------------------------------------------------------------

  flow = '2';
  show('\n-- 2. sign_up for Lee Park, a name on the roster');
  const lee = { passcode: newPasscode() };
  const leeUp = await crew({ action: 'sign_up', code: A.joinCode, first_name: 'Lee', last_name: 'Park', passcode: lee.passcode }, { auth: ['admin_create:new', 'token:crew'] });
  lee.signUp = sessionOf(leeUp);
  lee.id = lee.signUp?.user_id;
  check('sign_up: a session, joined, not waiting; Auth asked to make the account, then to sign it in', leeUp.status === 200 && leeUp.json?.status === 'signed_in' && lee.signUp?.access_token && lee.signUp?.refresh_token && Number.isFinite(lee.signUp?.expires_at) && leeUp.json.join?.status === 'joined' && leeUp.json.waiting === false && leeUp.authRight, toldWithAuth(leeUp));
  if (lee.id) {
    const user = await adminUser(lee.id);
    const email = user.json?.email ?? '';
    check('in Auth (the admin API, with the secret key): the hidden address crew-<32 hex>@crew.minemuster.com, confirmed, app_metadata.sign_in passcode',
      user.status === 200 && HIDDEN_ADDRESS.test(email) && typeof user.json.email_confirmed_at === 'string' && user.json.app_metadata?.sign_in === 'passcode',
      `${user.status}; the address ${HIDDEN_ADDRESS.test(email) ? 'is' : 'is NOT'} of that form; email_confirmed_at ${user.json?.email_confirmed_at ? 'set' : 'not set'}; app_metadata ${JSON.stringify(user.json?.app_metadata)}`);
    const columns = sql(`select string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'crew_logins'`);
    const [digestOk, salt, wrong] = first(`select l.digest = pg_catalog.sha256(k.key || l.salt || pg_catalog.convert_to(${lit(lee.passcode)}, 'UTF8')), pg_catalog.octet_length(l.salt), l.wrong_in_a_row
      from public.crew_logins l, public.crew_key k where l.user_id = ${lit(lee.id)}`).split('|');
    check('a crew_logins row holds the passcode\'s digest only: SHA-256 of the crew key, its own 16-byte salt and the passcode, in columns of no text',
      digestOk === 't' && salt === '16' && wrong === '0' && !/\btext\b|character/.test(columns), `columns: ${columns}`);
    const [holder] = rosterRow(rows.lee);
    check('Lee Park\'s roster row holds the account', holder === lee.id);
  }
  const accountsBefore = Number(first('select count(*) from auth.users'));
  const leeAgain = await crew({ action: 'sign_up', code: A.joinCode, first_name: 'Lee', last_name: 'Park', passcode: newPasscode([lee.passcode]) });
  check('sign_up again for the same name: already_signed_up, no call to Auth and no account made', leeAgain.status === 200 && leeAgain.json?.status === 'already_signed_up' && leeAgain.authRight && Number(first('select count(*) from auth.users')) === accountsBefore, toldWithAuth(leeAgain));

  // ---- 3. Signing in, and wrong passcodes ---------------------------------------------------------

  flow = '3';
  show('\n-- 3. sign_in, then wrong passcodes');
  const signInAs = (passcode) => crew({ action: 'sign_in', code: A.joinCode, first_name: 'Lee', last_name: 'Park', passcode });
  const leeIn = await crew({ action: 'sign_in', code: A.joinCode, first_name: 'Lee', last_name: 'Park', passcode: lee.passcode }, { auth: ['token:crew'] });
  lee.signIn = sessionOf(leeIn);
  check('sign_in with the right passcode: a session of the same account', leeIn.status === 200 && leeIn.json?.status === 'signed_in' && lee.signIn?.user_id === lee.id && leeIn.json.waiting === false && leeIn.authRight, toldWithAuth(leeIn));
  const wrongs = async (n) => {
    const answers = [];
    for (let i = 0; i < n; i += 1) answers.push(await signInAs(newPasscode([lee.passcode])));
    return answers;
  };
  const triesOf = (answers) => answers.map((a) => (a.json?.status === 'wrong' ? `wrong ${a.json.tries_left}` : a.json?.status === 'locked' ? `locked ${a.json.until === null ? 'until a reset' : 'until a time'}` : `${a.status} ${a.json?.status ?? a.json?.error}`)).join(', ');
  const firstFive = await wrongs(5);
  const fifth = firstFive[4]?.json;
  const lockEnds = Date.parse(fifth?.until ?? '');
  check('5 wrong in a row: tries_left 4, 3, 2, 1, then locked, with until 15 minutes on',
    firstFive.slice(0, 4).map((a) => a.json?.tries_left).join() === '4,3,2,1' && fifth?.status === 'locked' && Math.abs(lockEnds - (Date.now() + 15 * 60000)) < 60000 && firstFive.every((a) => a.made.length === 0),
    `${triesOf(firstFive)}; the lock ends ${Number.isFinite(lockEnds) ? `${((lockEnds - Date.now()) / 60000).toFixed(1)} minutes from now` : 'never said'}; no call to Auth`);
  const rightWhileLocked = await signInAs(lee.passcode);
  check('the right passcode while locked: locked, neither compared nor counted', rightWhileLocked.json?.status === 'locked' && rightWhileLocked.json.until === fifth?.until && first(`select wrong_in_a_row from public.crew_logins where user_id = ${lit(lee.id)}`) === '5', told(rightWhileLocked));
  sql(`update public.crew_logins set locked_until = pg_catalog.now() - interval '1 second' where user_id = ${lit(lee.id)}`);
  note('(the 15 minutes passed: the lock\'s end moved into the past by SQL, as the owner could, and as the race tests do)');
  const nextFive = await wrongs(5);
  const tenth = nextFive[4]?.json;
  check('5 more wrong: tries_left 4, 3, 2, 1, then the 10th locks it until a reset (until null)',
    nextFive.slice(0, 4).map((a) => a.json?.tries_left).join() === '4,3,2,1' && tenth?.status === 'locked' && tenth.until === null, triesOf(nextFive));
  const rightAfterTen = await signInAs(lee.passcode);
  check('the right passcode after 10: locked until a reset', rightAfterTen.json?.status === 'locked' && rightAfterTen.json.until === null && first(`select wrong_in_a_row from public.crew_logins where user_id = ${lit(lee.id)}`) === '10', told(rightAfterTen));
  const signIns = await rpc('roster_sign_ins', samSession?.access_token, { p_company_id: A.id });
  const leeRow = Array.isArray(signIns.json) ? signIns.json.find((r) => r.roster_id === rows.lee) : null;
  check('the Roster page\'s view (roster_sign_ins, as Sam): a passcode sign-in that needs a reset', leeRow?.sign_in === 'passcode' && leeRow.needs_reset === true, `${signIns.status}: sign_in ${leeRow?.sign_in}, needs_reset ${leeRow?.needs_reset}`);

  // ---- 4. A reset code from the supervisor ---------------------------------------------------------

  flow = '4';
  show('\n-- 4. Sam makes a reset code, Lee resets the passcode, and his other sessions stop');
  const made = await rpc('make_passcode_reset_code', samSession?.access_token, { p_roster_id: rows.lee });
  const resetCode = typeof made.json === 'string' ? made.json : null;
  check('make_passcode_reset_code, as Sam through PostgREST: 6 digits, kept as a digest for 30 minutes', made.status === 200 && /^\d{6}$/.test(resetCode ?? '')
    && first(`select reset_digest is not null and reset_until between pg_catalog.now() + interval '29 minutes' and pg_catalog.now() + interval '31 minutes' and reset_tries = 0 from public.crew_logins where user_id = ${lit(lee.id)}`) === 't', `${made.status}`);
  lee.newPasscode = newPasscode([lee.passcode]);
  const resetWith = (code, auth = []) => crew({ action: 'reset', code: A.joinCode, first_name: 'Lee', last_name: 'Park', reset_code: code, new_passcode: lee.newPasscode }, { auth });
  let wrongCode;
  do wrongCode = String(randomInt(0, 1e6)).padStart(6, '0');
  while (wrongCode === resetCode);
  const badCode = await resetWith(wrongCode);
  check('reset with a wrong code: bad_reset_code, 4 tries left, no call to Auth', badCode.json?.status === 'bad_reset_code' && badCode.json.tries_left === 4 && badCode.authRight, toldWithAuth(badCode));
  const reset = await resetWith(resetCode, ['token:crew', 'logout:others']);
  lee.reset = sessionOf(reset);
  check('reset with the code and a new passcode: signed in, the other sessions signed out (Auth: the password grant, then the sign-out of the others)',
    reset.status === 200 && reset.json?.status === 'signed_in' && reset.json.others_signed_out === true && lee.reset?.user_id === lee.id && reset.authRight, toldWithAuth(reset));
  if (reset.json?.status === 'signed_in') note('(passcode_changed is crew-auth\'s answer only when that sign-in fails once the new passcode is kept; here it went through)');
  check('in crew_logins: the count, the lock and the code cleared, the new passcode kept',
    first(`select l.wrong_in_a_row = 0 and l.locked_until is null and l.reset_digest is null and l.reset_until is null
      and l.digest = pg_catalog.sha256(k.key || l.salt || pg_catalog.convert_to(${lit(lee.newPasscode)}, 'UTF8')) from public.crew_logins l, public.crew_key k where l.user_id = ${lit(lee.id)}`) === 't');
  for (const [label, session] of [['the sign_up session', lee.signUp], ['the sign_in session', lee.signIn]]) {
    if (!session) continue;
    const refreshed = await refresh(session);
    check(`${label}, made before the reset, can no longer refresh`, refreshed.status >= 400 && !refreshed.json?.access_token, `${refreshed.status} ${errorCodeOf(refreshed.json) ?? ''} ${keysOf(shapeOf(refreshed.json))}`);
  }
  if (lee.signIn) {
    const old = await whoIs(lee.signIn.access_token, 'user:signed_out');
    check('nor does Auth take its access token (GET /auth/v1/user)', old.status === 403 && errorCodeOf(old.json) === 'session_not_found', `${old.status} ${errorCodeOf(old.json)}`);
  }
  if (lee.reset) {
    const refreshed = await refresh(lee.reset);
    lee.now = refreshed.status === 200 ? { access_token: refreshed.json.access_token, refresh_token: refreshed.json.refresh_token, user_id: refreshed.json.user?.id } : null;
    check('the reset\'s own session still refreshes', refreshed.status === 200 && lee.now?.user_id === lee.id, `${refreshed.status} ${keysOf(shapeOf(refreshed.json))}`);
  }
  const oldPasscode = await signInAs(lee.passcode);
  check('the old passcode no longer signs in: wrong, 4 tries left', oldPasscode.json?.status === 'wrong' && oldPasscode.json.tries_left === 4, told(oldPasscode));

  // ---- 5. Confirming, then deleting ----------------------------------------------------------------

  flow = '5';
  show('\n-- 5. Lee confirms his passcode and deletes his account, from the app');
  const at = Date.now() - 3600000;
  const shift = { id: 'shift-e2e-lee', employeeId: 'emp-1', clockIn: at, clockOut: at + 1800000, edits: [] };
  const pushed = await rpc('push_records', lee.now?.access_token, { company_id: A.id, changes: [{ key: 'shift:shift-e2e-lee', kind: 'shift', id: 'shift-e2e-lee', rev: createHash('sha1').update(JSON.stringify(shift)).digest('hex').slice(0, 20), record: shift }] });
  check('first, Lee\'s phone sends a shift (push_records), to see it stay', pushed.status === 200 && pushed.json?.accepted?.length === 1, `${pushed.status} ${keysOf(shapeOf(pushed.json))}`);
  const confirmed = await crew({ action: 'confirm', passcode: lee.newPasscode }, { token: lee.now?.access_token, auth: ['user:crew', 'token:crew'] });
  lee.fresh = sessionOf(confirmed);
  check('confirm, with the session as the bearer and the passcode: a fresh session of the same account (Auth: whose the token is, then the password grant)',
    confirmed.status === 200 && confirmed.json?.status === 'signed_in' && lee.fresh?.user_id === lee.id && lee.fresh.access_token !== lee.now?.access_token && confirmed.authRight, toldWithAuth(confirmed));
  const deleted = await fn('delete-account', {}, { token: lee.fresh?.access_token, auth: ['user:crew', 'admin_delete:exists'] });
  check('delete-account with it, with no Origin as the phone sends it: deleted (Auth: whose the token is, then the admin delete)', deleted.status === 200 && deleted.json?.deleted === true && deleted.json.closed?.length === 0 && deleted.authRight, toldWithAuth(deleted));
  if (lee.id) {
    const gone = await adminUser(lee.id);
    check('Auth no longer has the account (the admin API)', gone.status === 404 && errorCodeOf(gone.json) === 'user_not_found', `${gone.status} ${errorCodeOf(gone.json)}`);
    check('the crew_logins row is gone', first(`select count(*) from public.crew_logins where user_id = ${lit(lee.id)}`) === '0');
    const [holder, role, active] = rosterRow(rows.lee);
    check('the roster row stays, on the roster, with no account on it', holder === '' && role === 'employee' && active === 't' && first(`select claimed_at is null from public.roster where id = ${lit(rows.lee)}`) === 't');
    check('the shift stays with the company, its link to the account cleared', first(`select count(*) from public.records r where r.company_id = ${lit(A.id)} and r.kind = 'shift' and r.id = 'shift-e2e-lee' and r.created_by is null and r.updated_by is null
      and not exists (select 1 from public.record_history h where h.company_id = r.company_id and h.kind = r.kind and h.id = r.id and h.by is not null)`) === '1');
    const turnedDown = await whoIs(lee.fresh?.access_token, 'user:deleted');
    check('Auth turns the deleted account\'s token down: 403 user_not_found', turnedDown.status === 403 && errorCodeOf(turnedDown.json) === 'user_not_found', `${turnedDown.status} ${errorCodeOf(turnedDown.json)}`);
  }
  const confirmAgain = await crew({ action: 'confirm', passcode: lee.newPasscode }, { token: lee.fresh?.access_token, auth: ['user:deleted'] });
  check('confirm again with that session: 410 already_deleted, as crew-auth reads Auth\'s user_not_found', confirmAgain.status === 410 && confirmAgain.json?.error === 'already_deleted' && confirmAgain.authRight, toldWithAuth(confirmAgain));
  const deleteAgain = await fn('delete-account', {}, { token: lee.fresh?.access_token, origin: DASHBOARD, auth: ['user:deleted'] });
  check('delete-account again, with the dashboard\'s Origin: 410 already_deleted, with the dashboard\'s CORS headers',
    deleteAgain.status === 410 && deleteAgain.json?.error === 'already_deleted' && deleteAgain.headers['access-control-allow-origin'] === DASHBOARD && deleteAgain.authRight, toldWithAuth(deleteAgain));

  // ---- 6. The supervisor's tools ------------------------------------------------------------------

  flow = '6';
  show('\n-- 6. supervisor-tools, as Sam on the dashboard (Origin https://app.minemuster.com)');
  const preflight = await call('OPTIONS', '/functions/v1/supervisor-tools', { headers: { Origin: DASHBOARD, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, apikey, content-type, x-client-info' } });
  check('a browser\'s preflight from the dashboard: 204, with the dashboard\'s CORS headers (the gateway passes it to the function)', preflight.status === 204 && preflight.headers['access-control-allow-origin'] === DASHBOARD && /POST/.test(preflight.headers['access-control-allow-methods'] ?? ''), `${preflight.status} ${preflight.headers['access-control-allow-origin']}`);
  const elsewhere = await fn('supervisor-tools', { action: 'resend', invitation_id: randomUUID() }, { token: samSession?.access_token, origin: 'https://elsewhere.example' });
  check('a request from another site\'s page: 403 origin_not_allowed, before anything is asked', elsewhere.status === 403 && elsewhere.json?.error === 'origin_not_allowed' && elsewhere.made.length === 0, toldWithAuth(elsewhere));

  // Two more crew sign-ups: Maria De La Cruz (her sign-in is deleted below) and Pat Cole (made a supervisor in 7).
  const maria = { passcode: newPasscode() };
  const pat = { passcode: newPasscode([maria.passcode]) };
  for (const [person, holder, first_name, last_name] of [[PEOPLE.maria, maria, 'Maria', 'De La Cruz'], [PEOPLE.pat, pat, 'Pat', 'Cole']]) {
    const up = await crew({ action: 'sign_up', code: A.joinCode, first_name, last_name, passcode: holder.passcode }, { auth: ['admin_create:new', 'token:crew'] });
    holder.session = sessionOf(up);
    holder.id = holder.session?.user_id;
    check(`${nameOf(person)} signs up with a passcode in the app`, up.json?.status === 'signed_in' && up.json.join?.status === 'joined' && up.authRight, toldWithAuth(up));
  }
  pat.email = `e2e-pat-${randomBytes(4).toString('hex')}@example.com`;
  pat.password = `E2e-${randomBytes(12).toString('base64url')}`;
  const patSignup = await toAuth('POST', '/auth/v1/signup', { key, body: { email: pat.email, password: pat.password } });
  pat.emailId = patSignup.json?.user?.id ?? patSignup.json?.id;
  const patUser = pat.emailId ? await adminUser(pat.emailId) : null;
  check('Pat Cole also makes an email account with Auth (signup; this stack confirms addresses at once): confirmed', patSignup.status === 200 && typeof patUser?.json?.email_confirmed_at === 'string', `${patSignup.status} ${keysOf(shapeOf(patSignup.json))}`);

  const sup = (body, auth) => fn('supervisor-tools', body, { token: samSession?.access_token, origin: DASHBOARD, auth });
  const dana = { email: `e2e-dana-${randomBytes(4).toString('hex')}@example.com` };
  let logged = authLog().length;
  const invited = await sup({ action: 'invite', roster_id: rows.dana, email: dana.email }, ['user:valid', 'invite:new']);
  check('invite a new example.com address onto Dana Hollis\'s supervisor row, which no account holds: sent (Auth: whose the token is, then the invite)',
    invited.status === 200 && invited.json?.status === 'sent' && invited.headers['access-control-allow-origin'] === DASHBOARD && invited.authRight, toldWithAuth(invited));
  const danaAccount = await asServer('account_for_email', { p_email: dana.email });
  dana.id = danaAccount.json?.[0]?.user_id;
  const danaUser = dana.id ? await adminUser(dana.id) : null;
  check('Auth made the account (the admin API): not confirmed, invited, with the company\'s name in user_metadata',
    danaAccount.json?.[0]?.confirmed === false && danaUser?.status === 200 && !danaUser.json.email_confirmed_at && typeof danaUser.json.invited_at === 'string' && danaUser.json.user_metadata?.company_name === 'Test Pit A',
    `account_for_email ${keysOf(shapeOf(danaAccount.json))}; the account: invited_at ${danaUser?.json?.invited_at ? 'set' : 'not set'}, confirmation_sent_at ${danaUser?.json?.confirmation_sent_at ? 'set' : 'not set'}, email_confirmed_at ${danaUser?.json?.email_confirmed_at ? 'set' : 'not set'}, user_metadata ${keysOf(shapeOf(danaUser?.json?.user_metadata))}`);
  const linkToken = () => (dana.id ? first(`select coalesce(confirmation_token, '') from auth.users where id = ${lit(dana.id)}`) : '');
  dana.firstLink = linkToken();
  const tokenKept = dana.firstLink.length > 0;
  const inviteLog = authLog().slice(logged);
  // Auth logs a line about X-Forwarded-Host and GOTRUE_MAILER_EXTERNAL_HOSTS on every request the gateway hands it: not about mail.
  const aboutMail = inviteLog.filter((line) => /mail|smtp/i.test(`${line.msg} ${line.error ?? ''}`) && !/MAILER_EXTERNAL_HOSTS/.test(line.msg ?? ''));
  const inviteRequest = inviteLog.filter((line) => line.path === '/invite');
  const mailClient = authLog().find((line) => /mail client/i.test(line.msg ?? ''))?.msg ?? 'nothing about a mail client';
  check('whether Auth tried to send mail: its log, and the link\'s token it kept', tokenKept && inviteRequest.length === 1,
    `the link's token kept (auth.users.confirmation_token): ${tokenKept ? 'yes' : 'no'}; the invite in Auth's log: ${inviteRequest.map((line) => `${line.method} ${line.path} ${line.status}`).join(', ')}; lines about mail since: ${aboutMail.map((line) => `${line.level} "${line.msg}"${line.error ? ` (${line.error})` : ''}`).join('; ') || 'none'}; at its start Auth logged "${mailClient}"`);

  logged = authLog().length;
  const toConfirmed = await sup({ action: 'invite', roster_id: rows.pat, email: pat.email }, ['user:valid']);
  check('invite Pat Cole\'s confirmed address onto his crew row, which his passcode account holds: sent, and no invite call to Auth',
    toConfirmed.status === 200 && toConfirmed.json?.status === 'sent' && toConfirmed.authRight && !toConfirmed.made.some((one) => one.path === '/auth/v1/invite') && !authLog().slice(logged).some((line) => line.path === '/invite'), toldWithAuth(toConfirmed));

  const openNow = await rpc('roster_sign_ins', samSession?.access_token, { p_company_id: A.id });
  dana.invitation = Array.isArray(openNow.json) ? openNow.json.find((r) => r.roster_id === rows.dana)?.invitation_id : null;
  pat.invitation = Array.isArray(openNow.json) ? openNow.json.find((r) => r.roster_id === rows.pat)?.invitation_id : null;
  check('the Roster page shows both open invitations (roster_sign_ins)', dana.invitation && pat.invitation);
  const resent = await sup({ action: 'resend', invitation_id: dana.invitation ?? randomUUID() }, ['user:valid', 'invite:unconfirmed']);
  check('resend Dana\'s invitation: sent (Auth: whose the token is, then the invite again, to an account not confirmed)', resent.status === 200 && resent.json?.status === 'sent' && resent.authRight, toldWithAuth(resent));
  dana.secondLink = linkToken();
  check('Auth made the second email a link of its own: the first one\'s token is replaced', dana.secondLink.length > 0 && dana.secondLink !== dana.firstLink);

  const removed = await sup({ action: 'delete_crew_sign_in', roster_id: rows.maria }, ['user:valid', 'admin_delete:exists']);
  check('delete_crew_sign_in on Maria De La Cruz\'s row, which her passcode account holds: deleted (Auth: whose the token is, then the admin delete)', removed.status === 200 && removed.json?.status === 'deleted' && removed.authRight, toldWithAuth(removed));
  if (maria.id) {
    const gone = await adminUser(maria.id);
    check('Auth no longer has her account', gone.status === 404 && errorCodeOf(gone.json) === 'user_not_found', `${gone.status} ${errorCodeOf(gone.json)}`);
    const turnedDown = await whoIs(maria.session.access_token, 'user:deleted');
    check('her session stops working: Auth turns its token down', turnedDown.status === 403 && errorCodeOf(turnedDown.json) === 'user_not_found', `${turnedDown.status} ${errorCodeOf(turnedDown.json)}`);
    const refreshed = await refresh(maria.session);
    check('and its refresh token', refreshed.status >= 400 && !refreshed.json?.access_token, `${refreshed.status} ${errorCodeOf(refreshed.json) ?? ''}`);
    const stillRead = await rpc('my_companies', maria.session.access_token);
    note(`(PostgREST does not ask Auth: it still takes the token until it expires, and it reaches nothing: my_companies ${stillRead.status}, ${Array.isArray(stillRead.json) ? `${stillRead.json.length} companies` : keysOf(shapeOf(stillRead.json))})`);
    const [holder, role] = rosterRow(rows.maria);
    check('her roster row stays, with no account on it, and no crew_logins row is left', holder === '' && role === 'employee' && first(`select count(*) from public.crew_logins where user_id = ${lit(maria.id)}`) === '0');
  }

  // ---- 7. Accepting ---------------------------------------------------------------------------------

  flow = '7';
  show('\n-- 7. Accepting: Dana by the invite email\'s link, and Pat, a crew member made a supervisor');
  note('(no mail is sent here: each link is the one an invite email carries, made from the token Auth kept, as the email\'s template makes it)');
  /** An invite email's link, opened in a browser: where Auth sends it, and the hash's parameters. */
  const openLink = async (token) => {
    const opened = await toAuth('GET', `/auth/v1/verify?token=${encodeURIComponent(token)}&type=invite&redirect_to=${encodeURIComponent(INVITE_LINK)}`, {});
    let landed = null;
    try {
      landed = new URL(opened.headers.location ?? '');
    } catch {
      landed = null;
    }
    const fragment = new URLSearchParams((landed?.hash ?? '').replace(/^#/, ''));
    const to = landed ? `${landed.origin}${landed.pathname}${landed.search}` : '(nowhere)';
    authCalls[authCalls.length - 1].location = { to, hash: [...fragment.keys()].sort(), error_code: fragment.get('error_code') };
    return { opened, to, fragment, said: `${opened.status} to ${to}, hash keys ${[...fragment.keys()].sort().join(', ') || 'none'}${fragment.get('error_code') ? `, error_code ${fragment.get('error_code')}` : ''}` };
  };
  const stale = await openLink(dana.firstLink ?? '');
  check('the first email\'s link, opened after Send again: Auth sends the browser to the invite link with an error and no session, which the dashboard words as a link that has run out',
    stale.opened.status === 303 && stale.to === INVITE_LINK && stale.fragment.get('error') && !stale.fragment.get('access_token')
      && (stale.fragment.get('error_code') === 'otp_expired' || /expired|invalid/i.test(stale.fragment.get('error_description') ?? '')), stale.said);
  const fresh = await openLink(dana.secondLink ?? '');
  check('the second email\'s link: Auth sends the browser to the dashboard\'s invite link, with a session and type=invite in the hash, as the dashboard reads it',
    fresh.opened.status === 303 && fresh.to === INVITE_LINK && fresh.fragment.get('type') === 'invite' && fresh.fragment.get('access_token') && fresh.fragment.get('refresh_token') && !fresh.fragment.get('error'), fresh.said);
  dana.linkToken = fresh.fragment.get('access_token');
  if (!dana.linkToken && dana.id) {
    note('(the link signed nobody in: Dana\'s address is confirmed by the admin API instead)');
    await toAuth('PUT', `/auth/v1/admin/users/${dana.id}`, { key: secrets.secretKey, body: { email_confirm: true } });
  }
  dana.password = `E2e-${randomBytes(12).toString('base64url')}`;
  if (dana.linkToken) {
    const chose = await toAuth('PUT', '/auth/v1/user', { key, token: dana.linkToken, body: { password: dana.password } });
    check('on the dashboard\'s password screen she chooses a password (PUT /auth/v1/user)', chose.status === 200, `${chose.status} ${keysOf(shapeOf(chose.json))}`);
  } else {
    await toAuth('PUT', `/auth/v1/admin/users/${dana.id}`, { key: secrets.secretKey, body: { password: dana.password } });
  }
  const danaConfirmed = dana.id ? await adminUser(dana.id) : null;
  check('her address is confirmed now', typeof danaConfirmed?.json?.email_confirmed_at === 'string');
  const danaIn = await signInWith(dana.email, dana.password);
  check('she signs in with her email address and password', danaIn?.user_id === dana.id);
  const danaList = await rpc('my_supervisor_invitations', danaIn?.access_token);
  const danaSees = Array.isArray(danaList.json) ? danaList.json.find((one) => one.id === dana.invitation) : null;
  check('my_supervisor_invitations: Test Pit A, for the row of Dana Hollis', danaSees?.company_name === 'Test Pit A' && danaSees.first_name === 'Dana' && danaSees.last_name === 'Hollis', `${danaList.status} ${keysOf(shapeOf(danaList.json))}`);
  const danaAccepts = await rpc('accept_supervisor_invitation', danaIn?.access_token, { p_invitation_id: dana.invitation });
  check('accept_supervisor_invitation: Test Pit A', danaAccepts.status === 200 && danaAccepts.json?.company_name === 'Test Pit A' && danaAccepts.json.company_id === A.id, `${danaAccepts.status} ${keysOf(shapeOf(danaAccepts.json))}`);
  const [danaHolder, danaRole] = rosterRow(rows.dana);
  check('the row is hers, and a supervisor\'s', danaHolder === dana.id && danaRole === 'supervisor');
  const danaCompanies = await rpc('my_companies', danaIn?.access_token);
  check('my_companies: Test Pit A, as a supervisor', Array.isArray(danaCompanies.json) && danaCompanies.json.length === 1 && danaCompanies.json[0].name === 'Test Pit A' && danaCompanies.json[0].role === 'supervisor');

  const patIn = await signInWith(pat.email, pat.password);
  const patList = await rpc('my_supervisor_invitations', patIn?.access_token);
  check('Pat signs in with his email account; my_supervisor_invitations lists the one onto his crew row', Array.isArray(patList.json) && patList.json.some((one) => one.id === pat.invitation && one.first_name === 'Pat'), `${patList.status} ${keysOf(shapeOf(patList.json))}`);
  const patAccepts = await rpc('accept_supervisor_invitation', patIn?.access_token, { p_invitation_id: pat.invitation });
  check('accept_supervisor_invitation: Test Pit A', patAccepts.status === 200 && patAccepts.json?.company_name === 'Test Pit A', `${patAccepts.status} ${keysOf(shapeOf(patAccepts.json))}`);
  const [patHolder, patRole] = rosterRow(rows.pat);
  check('the row is his email account\'s, and a supervisor\'s', patHolder === pat.emailId && patRole === 'supervisor');
  if (pat.id) {
    check('the passcode account is let go of, with a released hold, and holds no row', first(`select kind from public.join_holds where company_id = ${lit(A.id)} and user_id = ${lit(pat.id)}`) === 'released'
      && first(`select count(*) from public.roster where user_id = ${lit(pat.id)}`) === '0');
    const still = await adminUser(pat.id);
    check('the passcode account itself stays in Auth, with its crew_logins row, until it is deleted', still.status === 200 && first(`select count(*) from public.crew_logins where user_id = ${lit(pat.id)}`) === '1', `${still.status}`);
  }
  const patPasscode = await crew({ action: 'sign_in', code: A.joinCode, first_name: 'Pat', last_name: 'Cole', passcode: pat.passcode });
  check('his passcode no longer signs in: the name is a supervisor\'s now, use_email', patPasscode.json?.status === 'use_email' && patPasscode.made.length === 0, told(patPasscode));

  // ---- 8. The limits ----------------------------------------------------------------------------------

  flow = '8';
  show('\n-- 8. The limit of 30 crew-auth requests from one address in 10 minutes, and which address is counted (R7)');
  const usedHere = counted('127.0.0.1');
  note(`(the gateway hands the functions X-Forwarded-For with the connection's address, 127.0.0.1, after any the client sent, and passes a client's cf-connecting-ip on as it came. ${usedHere} requests from 127.0.0.1 are counted so far)`);
  const lookups = [];
  for (let i = usedHere; i < 30; i += 1) lookups.push(await crew({ action: 'lookup', code: A.joinCode }));
  const past = [];
  for (let i = 0; i < 3; i += 1) past.push(await crew({ action: 'lookup', code: A.joinCode }));
  check(`requests ${usedHere + 1} to 30 from 127.0.0.1 go through; the 31st, 32nd and 33rd answer busy`, lookups.every((a) => a.json?.status === 'company') && past.every((a) => a.status === 200 && a.json?.status === 'busy'),
    `${lookups.length} more: ${[...new Set(lookups.map((a) => a.json?.status))].join(', ')}; then ${past.map((a) => a.json?.status).join(', ')}`);
  check('and those turned away are not counted: 30 are kept for 127.0.0.1', counted('127.0.0.1') === 30, `${counted('127.0.0.1')} kept`);
  const asked = async (what, headers, address) => {
    const answer = await crew({ action: 'lookup', code: A.joinCode }, { headers });
    const n = address === null ? null : counted(address);
    return { what, answer, n };
  };
  const forgedXff = await asked('X-Forwarded-For: 203.0.113.7 from the client', { 'X-Forwarded-For': '203.0.113.7' }, '203.0.113.7');
  const forgedCf = await asked('cf-connecting-ip: 198.51.100.23 from the client', { 'cf-connecting-ip': '198.51.100.23' }, '198.51.100.23');
  const both = await asked('both, cf-connecting-ip 198.51.100.24 and X-Forwarded-For 203.0.113.8', { 'cf-connecting-ip': '198.51.100.24', 'X-Forwarded-For': '203.0.113.8' }, '198.51.100.24');
  const junk = await asked('cf-connecting-ip: not-an-address', { 'cf-connecting-ip': 'not-an-address' }, '');
  for (const { what, answer, n } of [forgedXff, forgedCf, both, junk]) {
    check(`${what}: crew-auth counts ${what.startsWith('cf-connecting-ip: not') ? 'it as no address at all' : 'the address the client chose'}, so 127.0.0.1's limit does not stop it`,
      answer.json?.status === 'company' && n === 1, `${told(answer)}; counted for that address: ${n}`);
  }
  check('127.0.0.1 still counts 30, and its next request is still busy', counted('127.0.0.1') === 30 && (await crew({ action: 'lookup', code: A.joinCode })).json?.status === 'busy' && counted('203.0.113.8') === 0);
  note('(so through this stand-in gateway a client chooses the address crew-auth counts, with either header. Whether Supabase\'s edge sets cf-connecting-ip from the connection, and what X-Forwarded-For carries there, is for Task 17 on the live project: supabase/README.md, "Checks to make once it is deployed")');

  // ---- 9. Supabase Auth's own limit ------------------------------------------------------------------

  flow = '9';
  show('\n-- 9. Supabase Auth\'s own limit on sign-ins from one address: crew-auth answers busy, and a sign-up undoes the account it made');
  note('(every password grant reaches Auth from the same address here, 127.0.0.1, as every grant crew-auth makes reaches it from the function\'s own address on the live server)');
  const nobody = `e2e-nobody-${randomBytes(4).toString('hex')}@example.com`;
  const grants = [];
  for (let i = 0; i < 80; i += 1) {
    const before = authCalls.length;
    const answer = await toAuth('POST', '/auth/v1/token?grant_type=password', { key, body: { email: nobody, password: 'not-the-password' } }, 'token:wrong');
    if (answer.status === 429) authCalls[before].situation = 'token:busy';
    grants.push(answer.status);
    if (answer.status === 429) break;
  }
  const refusedFirst = grants.indexOf(429);
  check('password grants for an address with no account: 400 invalid_credentials, until Auth answers 429', refusedFirst > 0 && grants.slice(0, refusedFirst).every((status) => status === 400),
    `${refusedFirst > 0 ? `${refusedFirst} answered 400, then the next 429` : `no 429 in ${grants.length}`} (with the password grants of flows 0 to 7 before them, from the same address)`);
  const accountsNow = Number(first('select count(*) from auth.users'));
  const loginsNow = Number(first('select count(*) from public.crew_logins'));
  const logBefore = fs.readFileSync(path.join(files.run, 'functions-server.log'), 'utf8').length;
  note('(127.0.0.1 has spent its 30 crew-auth requests, so this one goes as from 192.0.2.10, by X-Forwarded-For, which this gateway lets a client choose: flow 8)');
  const busyUp = await crew({ action: 'sign_up', code: A.joinCode, first_name: 'Lee', last_name: 'Park', passcode: newPasscode() }, { headers: { 'X-Forwarded-For': '192.0.2.10' }, auth: ['admin_create:new', 'token:busy', 'admin_delete:exists'] });
  const logAfter = fs.readFileSync(path.join(files.run, 'functions-server.log'), 'utf8').slice(logBefore);
  check('sign_up for Lee Park\'s row, now free, while Auth refuses sign-ins: busy (Auth: the account made, its sign-in refused, the account deleted again)',
    busyUp.status === 200 && busyUp.json?.status === 'busy' && busyUp.authRight, toldWithAuth(busyUp));
  check('nothing of it is left: no new account in Auth, no crew_logins row, Lee Park\'s row still free, and crew-auth logged the undo',
    Number(first('select count(*) from auth.users')) === accountsNow && Number(first('select count(*) from public.crew_logins')) === loginsNow && rosterRow(rows.lee)[0] === '' && /sign_up: the account it made is deleted again/.test(logAfter),
    `crew-auth's log: ${logAfter.split('\n').filter((line) => /crew-auth:/.test(line)).map((line) => line.replace(/^\S+ /, '')).join('; ')}`);
  note('(Auth now refuses sign-ins from 127.0.0.1 until its limit refills, or a reset restarts it)');

  // ---- Auth's answers against the stand-ins -----------------------------------------------------------

  show('\n-- Supabase Auth\'s answers against supabase/tests/stand-ins.mjs');
  show(`   ${authCalls.length} calls were made to Auth: ${authCalls.filter((c) => c.by !== 'this script').length} by the functions, ${authCalls.filter((c) => c.by === 'this script').length} by this script.`);
  const comparisons = [];
  const standIn = {};
  for (const one of authCalls) {
    if (!one.situation) continue;
    if (!(one.situation in standIn)) {
      try {
        standIn[one.situation] = await standInAnswer(one.situation);
      } catch (error) {
        standIn[one.situation] = { failed: error.message };
      }
    }
  }
  const groups = new Map();
  for (const one of authCalls.filter((c) => c.situation)) {
    const real = { status: one.status, shape: one.shape, error_code: one.error_code };
    const id = `${one.situation} ${JSON.stringify(real)}`;
    if (!groups.has(id)) groups.set(id, { situation: one.situation, route: one.route, real, by: new Set(), flows: new Set() });
    groups.get(id).by.add(one.by);
    groups.get(id).flows.add(one.flow);
  }
  let material = 0;
  for (const group of groups.values()) {
    const stand = standIn[group.situation];
    const where = `${[...group.by].join(', ')}; flow${group.flows.size > 1 ? 's' : ''} ${[...group.flows].join(', ')}`;
    if (!stand || stand.failed) {
      comparisons.push({ ...group, by: [...group.by], flows: [...group.flows], standIn: null, note: stand?.failed ?? 'not played' });
      check(`${SITUATIONS[group.situation] ?? group.situation} (${where}): the stand-in could not be played`, false, stand?.failed ?? '');
      continue;
    }
    const diff = compare(group.route, group.real, stand);
    comparisons.push({ ...group, by: [...group.by], flows: [...group.flows], standIn: stand, diff });
    const head = `${SITUATIONS[group.situation] ?? group.situation} (${where})`;
    if (diff.same) {
      show(`same ${head}: ${group.real.status}${group.real.error_code ? ` ${group.real.error_code}` : ''} ${keysOf(group.real.shape)}`);
      continue;
    }
    if (diff.material) material += 1;
    const detail = [
      `Auth:     ${group.real.status}${group.real.error_code ? ` ${group.real.error_code}` : ''} ${keysOf(group.real.shape)}`,
      `stand-in: ${stand.status}${stand.error_code ? ` ${stand.error_code}` : ''} ${keysOf(stand.shape)}`,
      ...(diff.onlyAuth.length ? [`only Auth sends: ${diff.onlyAuth.join(', ')}`] : []),
      ...(diff.onlyStandIn.length ? [`only the stand-in sends: ${diff.onlyStandIn.join(', ')}`] : []),
      ...(diff.types.length ? [`types: ${diff.types.join('; ')}`] : []),
      diff.material ? `what a function reads differs: ${[diff.statusDiffers && 'the status', diff.codeDiffers && 'the error_code', ...diff.readDiffers].filter(Boolean).join(', ')}` : `what a function reads (${(READ[group.route] ?? []).join(', ') || 'the status alone'}) is the same`,
    ];
    if (diff.material) check(`${head}: differs`, false, detail.join('\n          '));
    else show(`note ${head}: differs in keys a function does not read\n          ${detail.join('\n          ')}`);
  }
  const unmatched = authCalls.filter((c) => !c.situation);
  show(`\n   Calls with no stand-in (the functions never make them; this script does, to check): ${unmatched.map((c) => `${c.method} ${c.path}${c.query.length ? `?${c.query.join('&')}` : ''} ${c.status}${c.error_code ? ` ${c.error_code}` : ''}`).join('; ')}`);

  const failed = checks.filter((c) => !c.held).length;
  show(`\n${checks.length - failed} of ${checks.length} checks held${failed ? `; ${failed} FAILED` : ''}. ${groups.size} kinds of answer compared with the stand-ins: ${[...comparisons].filter((c) => c.diff?.same).length} the same, ${material} differ in what a function reads. The data has changed: run reset.`);
  writePrivate(path.join(files.dir, 'crew-e2e.txt'), `${lines.join('\n')}\n`);
  writePrivate(path.join(files.dir, 'crew-e2e.json'), `${JSON.stringify({ at: new Date().toISOString(), checks, functionCalls, authCalls, comparisons }, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await crewE2e(loadSecrets(), paths());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
