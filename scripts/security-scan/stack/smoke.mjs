// A short round of requests through the gateway that shows the local stack
// answers the way the server should, before a scanner is pointed at it. Each
// line says what was asked, what came back and whether that is what was
// expected. It changes the data (it sends records and a Stripe event): run
// `reset` afterwards.

import { randomUUID } from 'node:crypto';
import { PLATFORM_HEADERS } from './gateway.mjs';
import { call, readJson, signIn, writePrivate } from './lib.mjs';
import { sendStripeEvent } from './seed.mjs';

export async function smoke(secrets, files) {
  const fixtures = readJson(files.fixtures);
  const key = secrets.publishableKey;
  const A = fixtures.companies.A;
  const B = fixtures.companies.B;
  const lines = [];
  let failed = 0;

  const show = (text) => {
    lines.push(text);
    process.stdout.write(`${text}\n`);
  };
  /** The headers the live gateway sends on every answer that this one leaves out or sends otherwise. */
  const unheaded = (answer) => Object.entries(PLATFORM_HEADERS).filter(([name, value]) => answer.headers[name] !== value).map(([name]) => name);
  /** One check: `expect` is a status, and `also` a test of the answer. Every answer must carry the live gateway's headers too. */
  const check = (what, answer, expect, also = () => true) => {
    const missing = unheaded(answer);
    const ok = answer.status === expect && Boolean(also(answer)) && missing.length === 0;
    if (!ok) failed += 1;
    show(`${ok ? 'ok  ' : 'FAIL'} ${what}\n       -> ${answer.status} ${answer.text.replace(/\s+/g, ' ').slice(0, 260)}${missing.length ? `\n       -> without ${missing.join(', ')}` : ''}`);
  };
  const rpc = (name, token, body, extra = {}) => call('POST', `/rest/v1/rpc/${name}`, { key, token, body, ...extra });

  show(`Smoke tests of the local scan stack, ${new Date().toISOString()}. Every name is made up.`);
  show(`Every answer must also carry ${Object.entries(PLATFORM_HEADERS).map(([name, value]) => `${name}: ${value}`).join(' and ')}, as the live gateway's do.\n`);

  show('-- The key');
  show('   (The code lookup is for signed-in accounts since migration 20261122000100: anon is refused by the database, 42501, which PostgREST answers with 401. The gateway\'s own refusals carry no code.)');
  check('anon is refused company_by_code with company A\'s join code', await rpc('company_by_code', undefined, { code: A.joinCode }), 401, (a) => a.json?.code === '42501');
  check('no apikey on /rest/v1 is refused', await call('GET', '/rest/v1/companies'), 401, (a) => a.json.message === 'No API key found in request');
  check('no apikey on /auth/v1 is refused', await call('GET', '/auth/v1/settings'), 401);
  check('a wrong apikey is refused', await call('GET', '/rest/v1/companies', { key: 'sb_publishable_not_a_key_of_this_stack' }), 401, (a) => a.json.message === 'Invalid API key');
  check('the publishable key does not get PostgREST\'s description', await call('GET', '/rest/v1/', { key }), 403);
  check('the secret key is refused from a browser', await call('GET', '/rest/v1/contact_requests', { key: secrets.secretKey, headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' } }), 401);
  check('the secret key reads the contact form\'s table as service_role', await call('GET', '/rest/v1/contact_requests?select=name', { key: secrets.secretKey }), 200, (a) => a.json.length === 1);
  check('anon does not read that table', await call('GET', '/rest/v1/contact_requests?select=name', { key }), 401);
  check('anon reads no company', await call('GET', '/rest/v1/companies', { key }), 401);

  show('\n-- Signing in');
  check('a wrong password is refused', await call('POST', '/auth/v1/token?grant_type=password', { key, body: { email: fixtures.accounts.A1.email, password: 'not-the-password' } }), 400, (a) => a.json.error_code === 'invalid_credentials');
  const tokens = {};
  for (const [label, account] of Object.entries(fixtures.accounts)) tokens[label] = (await signIn(secrets, account.email, account.password)).access_token;
  show(`ok   each of ${Object.keys(tokens).join(', ')} signs in with its password and gets an access token`);
  check('N1, signed in and in no company, calls company_by_code with company A\'s join code', await rpc('company_by_code', tokens.N1, { code: A.joinCode }), 200, (a) => a.json[0]?.name === 'Test Pit A' && a.json[0]?.state === 'CA');
  check('the publishable key in the apikey query parameter is taken, beside a signed-in account\'s token', await call('POST', `/rest/v1/rpc/company_by_code?apikey=${key}`, { token: tokens.N1, body: { code: A.joinCode } }), 200, (a) => a.json.length === 1);

  show('\n-- Each account\'s companies (my_companies)');
  const expected = { A1: ['Test Pit A', 'supervisor'], A2: ['Test Pit A', 'employee'], B1: ['Test Pit B', 'supervisor'], N1: null, P1: null };
  for (const [label, want] of Object.entries(expected)) {
    check(`${label} (${fixtures.accounts[label].what})`, await rpc('my_companies', tokens[label], {}), 200,
      (a) => (want ? a.json.length === 1 && a.json[0].name === want[0] && a.json[0].role === want[1] && (want[1] === 'supervisor') === Boolean(a.json[0].join_code) : a.json.length === 0));
  }

  show('\n-- One company sees nothing of another');
  show('   (A function that refuses "not found, or not yours" raises PT404, which PostgREST answers with HTTP 404: the same for another company\'s real id as for a made-up one.)');
  check('A2 reads the roster: only company A\'s three rows', await call('GET', '/rest/v1/roster?select=company_id', { key, token: tokens.A2 }), 200, (a) => a.json.length === 3 && a.json.every((row) => row.company_id === A.id));
  check('A2 asks for company B\'s roster: nothing', await call('GET', `/rest/v1/roster?company_id=eq.${B.id}`, { key, token: tokens.A2 }), 200, (a) => a.json.length === 0);
  check('A2 asks for company B\'s records: nothing', await call('GET', `/rest/v1/records?company_id=eq.${B.id}`, { key, token: tokens.A2 }), 200, (a) => a.json.length === 0);
  check('A2 asks for company B\'s record history: nothing', await call('GET', `/rest/v1/record_history?company_id=eq.${B.id}`, { key, token: tokens.A2 }), 200, (a) => a.json.length === 0);
  check('A2 asks for company B itself: nothing', await call('GET', `/rest/v1/companies?id=eq.${B.id}`, { key, token: tokens.A2 }), 200, (a) => a.json.length === 0);
  check('A2 sends a record to company B: no such company', await rpc('push_records', tokens.A2, { company_id: B.id, changes: [] }), 404, (a) => a.json.code === 'PT404' && a.json.message === 'No such company.');
  check('B1 rotates company A\'s join code: no such company', await rpc('rotate_join_code', tokens.B1, { company_id: A.id }), 404, (a) => a.json.code === 'PT404' && a.json.message === 'No such company.');
  check('B1 approves the request waiting in company A: not found', await rpc('approve_join_request', tokens.B1, { request_id: fixtures.pendingJoinRequest.id }), 404, (a) => a.json.code === 'PT404' && a.json.message === 'No such join request.');
  check('B1 asks for company A\'s billing: no such company', await rpc('company_billing', tokens.B1, { p_company_id: A.id }), 404, (a) => a.json.code === 'PT404' && a.json.message === 'No such company.');
  check('B1 asks for the billing of a company that does not exist: the same answer', await rpc('company_billing', tokens.B1, { p_company_id: randomUUID() }), 404, (a) => a.json.code === 'PT404' && a.json.message === 'No such company.');
  check('B1 asks for company A\'s billing by GET: the same answer', await call('GET', `/rest/v1/rpc/company_billing?p_company_id=${A.id}`, { key, token: tokens.B1 }), 404, (a) => a.json.code === 'PT404' && a.json.message === 'No such company.');
  check('company A\'s join code still works afterwards, for N1', await rpc('company_by_code', tokens.N1, { code: A.joinCode }), 200, (a) => a.json.length === 1);
  check('A1 reads company A\'s billing: a trial', await rpc('company_billing', tokens.A1, { p_company_id: A.id }), 200, (a) => a.json.access === 'trial' && a.json.status === 'trialing');
  check('A2, an employee, is refused company A\'s billing', await rpc('company_billing', tokens.A2, { p_company_id: A.id }), 404, (a) => a.json.code === 'PT404' && a.json.message === 'No such company.');
  show('   (A function that refuses "not in a state to do that" raises PT409, which PostgREST answers with HTTP 409, the hint kept.)');
  check('A1 approves the waiting request onto A2\'s row, which A2 holds: already claimed, nothing changed', await rpc('approve_join_request', tokens.A1, { request_id: fixtures.pendingJoinRequest.id, roster_id: A.roster.A2.rosterId }), 409,
    (a) => a.json.code === 'PT409' && a.json.message === 'That roster row is already claimed.' && /replace_claim/.test(a.json.hint ?? ''));
  check('A1 reads the request waiting for a supervisor', await call('GET', '/rest/v1/join_requests?select=status,reason', { key, token: tokens.A1 }), 200, (a) => a.json.length === 1 && a.json[0].status === 'pending');
  check('N1, who joined nothing, reads no roster', await call('GET', '/rest/v1/roster', { key, token: tokens.N1 }), 200, (a) => a.json.length === 0);

  show('\n-- push_records as A2, an employee');
  const shift = { id: 'shift-smoke', employeeId: 'emp-1', clockIn: Date.now(), clockOut: null, edits: [] };
  const pushed = await rpc('push_records', tokens.A2, { company_id: A.id, changes: [
    { key: 'shift:shift-smoke', kind: 'shift', id: 'shift-smoke', rev: 'a1b2c3d4e5f60718293a', record: shift },
    { key: 'employee:emp-9', kind: 'employee', id: 'emp-9', rev: 'b1b2c3d4e5f60718293a', record: { id: 'emp-9', first: 'Bo', last: 'Ellison', role: 'supervisor', active: true } },
    { key: 'shift:shift-rate', kind: 'shift', id: 'shift-rate', rev: 'c1b2c3d4e5f60718293a', record: { ...shift, id: 'shift-rate', payRate: 4200 } },
  ] });
  check('a new shift is accepted, a roster record is a supervisor\'s, a record with a pay rate is private', pushed, 200,
    (a) => a.json.accepted.length === 1 && a.json.accepted[0].key === 'shift:shift-smoke'
      && a.json.ignored.some((one) => one.key === 'employee:emp-9' && one.reason === 'supervisor_only') && a.json.ignored.some((one) => one.key === 'shift:shift-rate' && one.reason === 'private'));
  check('anon cannot call push_records', await rpc('push_records', undefined, { company_id: A.id, changes: [] }), 401);

  show('\n-- The Stripe webhook (no key, no token)');
  const event = { id: `evt_scan_smoke_${Date.now()}`, object: 'event', type: 'customer.created', created: Math.floor(Date.now() / 1000), livemode: true, data: { object: { id: 'cus_scanSmoke' } } };
  check('an unsigned POST is refused', await call('POST', '/functions/v1/stripe-webhook', { body: event }), 400, (a) => a.json.reason === 'no_header');
  check('a GET is refused', await call('GET', '/functions/v1/stripe-webhook'), 405, (a) => a.headers.allow === 'POST');
  check('a POST signed with another secret is refused', await sendStripeEvent(secrets, event, { signedWith: 'whsec_not_the_secret_of_this_stack' }), 400, (a) => a.json.reason === 'mismatch');
  check('a POST signed with the local secret is taken', await sendStripeEvent(secrets, event), 200, (a) => a.json.applied === false && a.json.reason === 'ignored_type');
  check('the same event again is a duplicate', await sendStripeEvent(secrets, event), 200, (a) => a.json.reason === 'duplicate');
  check('a function that does not exist', await call('POST', '/functions/v1/no-such-function', { body: {} }), 404);

  show(`\n${failed ? `${failed} check(s) FAILED.` : 'Every check passed.'} The data has changed: run reset.`);
  writePrivate(files.smoke, `${lines.join('\n')}\n`);
  if (failed) process.exitCode = 1;
}
