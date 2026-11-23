// The made-up companies, accounts and records the scan starts from, made the
// way the product makes them: accounts by signing up with Supabase Auth, and
// everything else through the gateway with the calls the app, the dashboard,
// the website and Stripe make. Two things are done as the project's owner does
// them in the SQL editor: letting a company in without paying, and nothing else.
//
// Every name here is made up, in the style of supabase/tests. The repository
// is public: keep it that way.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { GATEWAY_URL, call, lit, sql } from './lib.mjs';

const PEOPLE = {
  A1: { first: 'Sam', last: 'Ortiz', title: 'Pit supervisor', what: 'Supervisor of Test Pit A, which he started.' },
  A2: { first: 'Riley J', last: 'Quinn', typed: ['Riley', 'Quinn'], title: 'Crusher operator', what: 'Employee of Test Pit A, joined with the code and her name.' },
  B1: { first: 'Ana', last: 'Diaz', title: 'Plant supervisor', what: 'Supervisor of Test Pit B, which she started.' },
  N1: { first: 'Jo', last: 'Vale', what: 'An account that has joined nothing.' },
  P1: { first: 'Kit', last: 'Marlow', what: 'An account with a pending request to join Test Pit A: the name is not on its roster.' },
};
/** On Test Pit A's roster, with no account on the row yet. */
const A3 = { first: 'Lee "Buck"', last: 'Vance III', title: 'Loader operator' };

const revOf = (record) => createHash('sha1').update(JSON.stringify(record)).digest('hex').slice(0, 20);
const change = (kind, id, record) => ({ key: `${kind}:${id}`, kind, id, rev: revOf(record), record });

function must(answer, what, status = 200) {
  if (answer.status !== status) throw new Error(`Seeding failed at "${what}": ${answer.status} ${answer.text.slice(0, 400)}`);
  return answer.json;
}

/** A Stripe event signed with the stack's own made-up signing secret, sent where Stripe sends them. */
export function sendStripeEvent(secrets, event, { signedWith = secrets.webhookSecret } = {}) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', signedWith).update(`${t}.${body}`).digest('hex');
  return call('POST', '/functions/v1/stripe-webhook', { body, headers: { 'Stripe-Signature': `t=${t},v1=${v1}`, 'Content-Type': 'application/json' } });
}

/**
 * What a phone sends for a company: one record of each kind a supervisor sends, made up. The four kinds every phone
 * reads (settings, employee, equipment, areaSheet) are in the shape the phones read them, which push_records checks
 * (shared_record_problem; readRecord in src/domain/receive.ts), as supabase/tests writes them: a company with no
 * clock-in site, a person with a first and last name, a unit with its number, make, model and meter, and a sheet
 * with a name and lines. supabase/tests/scan_seed.db.mjs holds them to it.
 */
export const supervisorRecords = (name, state) => [
  change('settings', 'company', { company: { name, state, pay: null }, site: null, workweekStartsOn: 0, allowSectionAllOk: false }),
  change('employee', 'emp-1', { id: 'emp-1', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true }),
  change('equipment', 'eq-1', { id: 'eq-1', unit: 'T-14', category: 'haul_truck', make: 'Made-up', model: 'HX 40', status: 'ready', meter: 1200, meterUnit: 'hrs' }),
  change('areaSheet', 'wash-plant', { id: 'wash-plant', title: 'Wash plant', rows: [{ id: 'r1', label: 'Walkways' }, { id: 'r2', label: 'Guards' }], active: true }),
  change('leave', 'leave-1', { id: 'leave-1', employeeId: 'emp-1', day: '2026-11-11', kind: 'holiday', hours: 800 }),
];

export const memberRecords = (at) => [
  change('shift', 'shift-1', { id: 'shift-1', employeeId: 'emp-1', clockIn: at, clockOut: null, edits: [] }),
  change('denied', 'denied-1', { id: 'denied-1', employeeId: 'emp-1', at, reason: 'outside the boundary' }),
  change('inspection', 'insp-1', { id: 'insp-1', equipmentId: 'eq-1', answers: { 1: 'ok' }, signedAt: at }),
  change('opLog', 'oplog-1', { id: 'oplog-1', equipmentId: 'eq-1', hoursStart: 1200, hoursEnd: 1208 }),
  change('exam', 'exam-1', { id: 'exam-1', sheetId: 'wash-plant', shift: 'day', rows: [{ line: 'Walkways', answer: 'ok' }] }),
  change('mrf', 'mrf-1', { id: 'mrf-1', number: 1001, problem: 'Loose guard', status: 'open' }),
];

export async function seed(secrets) {
  const key = secrets.publishableKey;
  const rpc = (name, token, body) => call('POST', `/rest/v1/rpc/${name}`, { key, token, body });

  // 1. Five people sign up with an email address and a password.
  const accounts = {};
  for (const [label, person] of Object.entries(PEOPLE)) {
    const email = `${label.toLowerCase()}-${person.first.split(' ')[0].toLowerCase()}@example.test`;
    const password = `Scan-${randomBytes(12).toString('base64url')}`;
    const session = must(await call('POST', '/auth/v1/signup', { key, body: { email, password } }), `sign up ${label}`);
    accounts[label] = { id: session.user.id, email, password, name: `${person.first} ${person.last}`, what: person.what, token: session.access_token };
  }
  const token = (label) => accounts[label].token;

  // 2. Two supervisors start their companies.
  const company = {};
  for (const [label, sup, name, state] of [['A', 'A1', 'Test Pit A', 'CA'], ['B', 'B1', 'Test Pit B', 'NV']]) {
    const person = PEOPLE[sup];
    const [made] = must(await rpc('create_company', token(sup), {
      name, state, timezone: 'America/Los_Angeles', first_name: person.first, last_name: person.last, title: person.title,
    }), `create ${name}`);
    company[label] = { id: made.company_id, name, state, joinCode: made.join_code, supervisor: sup };
  }

  // 3. Test Pit A's supervisor puts two people on the roster. One joins with the code and her name.
  const roster = {};
  for (const [label, person] of [['A2', PEOPLE.A2], ['A3', A3]]) {
    const [row] = must(await call('POST', '/rest/v1/roster?select=id', {
      key, token: token('A1'), headers: { Prefer: 'return=representation' },
      body: { company_id: company.A.id, first_name: person.first, last_name: person.last, title: person.title, role: 'employee', active: true },
    }), `roster row ${label}`, 201);
    roster[label] = row.id;
  }
  const joined = must(await rpc('join_company', token('A2'), { code: company.A.joinCode, first_name: PEOPLE.A2.typed[0], last_name: PEOPLE.A2.typed[1] }), 'A2 joins');
  if (joined.status !== 'joined') throw new Error(`A2 did not join: ${JSON.stringify(joined)}`);

  // 4. Someone whose name is not on the roster asks to join: a request waits for the supervisor.
  const asked = must(await rpc('join_company', token('P1'), { code: company.A.joinCode, first_name: PEOPLE.P1.first, last_name: PEOPLE.P1.last }), 'P1 asks to join');
  if (asked.status !== 'pending') throw new Error(`P1's request is not pending: ${JSON.stringify(asked)}`);

  // 5. Billing. Test Pit A starts its trial: Stripe's two events arrive at the webhook, signed.
  //    Test Pit B is let in without paying, as the owner does it in the SQL editor.
  const now = Math.floor(Date.now() / 1000);
  const trialEnd = now + 14 * 86400;
  const subscription = { id: 'sub_scanTestPitA', customer: 'cus_scanTestPitA' };
  const events = [
    {
      id: 'evt_scan_subscription_created', object: 'event', type: 'customer.subscription.created', created: now, livemode: true,
      data: { object: { id: subscription.id, object: 'subscription', status: 'trialing', customer: subscription.customer, trial_end: trialEnd,
        cancel_at_period_end: false, metadata: { app: 'minemuster' }, items: { object: 'list', data: [{ id: 'si_scanTestPitA', current_period_end: trialEnd }] } } },
    },
    {
      id: 'evt_scan_checkout_completed', object: 'event', type: 'checkout.session.completed', created: now, livemode: true,
      data: { object: { id: 'cs_scanTestPitA', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'no_payment_required',
        client_reference_id: company.A.id, customer: subscription.customer, subscription: subscription.id, metadata: { app: 'minemuster' } } },
    },
  ];
  for (const event of events) {
    const applied = must(await sendStripeEvent(secrets, event), `Stripe event ${event.type}`);
    if (applied.applied !== true) throw new Error(`Stripe event ${event.type} was not applied: ${JSON.stringify(applied)}`);
  }
  sql(`insert into public.billing_overrides (company_id, reason) values (${lit(company.B.id)}, 'A pilot company of the local scan stack');`, { role: 'postgres' });

  // 6. The phones send their records: every kind in Test Pit A, a few in Test Pit B.
  const at = Date.now() - 3600000;
  const sent = {};
  for (const [label, who, changes] of [
    ['A by its supervisor', 'A1', supervisorRecords('Test Pit A', 'CA')],
    ['A by its employee', 'A2', memberRecords(at)],
    ['B by its supervisor', 'B1', [...supervisorRecords('Test Pit B', 'NV').slice(0, 3), memberRecords(at)[0]]],
  ]) {
    const answer = must(await rpc('push_records', token(who), { company_id: company[label[0]].id, changes }), `push_records for ${label}`);
    if (answer.accepted.length !== changes.length) throw new Error(`push_records for ${label} set some aside: ${JSON.stringify(answer)}`);
    sent[label] = changes.map((one) => ({ key: one.key, rev: one.rev }));
  }

  // 7. A visitor of the website sends the contact form.
  must(await rpc('submit_contact_request', undefined, {
    p_name: 'Pat Cole', p_company: 'Test Pit C', p_email: 'pat.cole@example.test', p_phone: '555-0100',
    p_message: 'We run a small pit and would like to see MineMuster.', p_website: '',
  }), 'the contact form');

  const [requestId] = sql(`select id from public.join_requests where user_id = ${lit(accounts.P1.id)} and status = 'pending'`).split('\n');
  for (const account of Object.values(accounts)) delete account.token;
  return {
    about: 'Made-up companies, accounts and records of the local scan stack. Nothing here is real, and none of it works anywhere but on this machine.',
    gatewayUrl: GATEWAY_URL,
    keys: { publishable: secrets.publishableKey, secret: secrets.secretKey, secretNote: 'The secret key is the server key (service_role). The gateway refuses it from a browser.' },
    freshAccessToken: {
      how: 'Sign in with the account\'s email address and password. The answer\'s access_token lasts an hour; send it as Authorization: Bearer <token> with the publishable key in apikey.',
      request: { method: 'POST', url: `${GATEWAY_URL}/auth/v1/token?grant_type=password`, headers: { apikey: secrets.publishableKey, 'Content-Type': 'application/json' }, body: { email: '<email>', password: '<password>' } },
      command: 'MINEMUSTER_SCAN_STACK_DIR=<stack folder> node scripts/security-scan/stack/stack.mjs token A1',
      limits: 'Supabase Auth limits sign-ins by caller address (about 30 at once, refilled at 150 in five minutes). A reset clears the limits.',
    },
    accounts,
    companies: {
      A: { ...company.A, billing: `trialing subscription ${subscription.id} (customer ${subscription.customer}), made through the webhook`, roster: {
        A1: { rosterId: sql(`select id from public.roster where user_id = ${lit(accounts.A1.id)}`), role: 'supervisor', account: accounts.A1.id },
        A2: { rosterId: roster.A2, role: 'employee', account: accounts.A2.id, name: 'Riley J Quinn' },
        A3: { rosterId: roster.A3, role: 'employee', account: null, name: 'Lee "Buck" Vance III', note: 'On the roster and not joined: nobody has claimed the row.' },
      } },
      B: { ...company.B, billing: 'let in without paying (a billing_overrides row)', roster: {
        B1: { rosterId: sql(`select id from public.roster where user_id = ${lit(accounts.B1.id)}`), role: 'supervisor', account: accounts.B1.id },
      } },
    },
    pendingJoinRequest: { id: requestId, company: 'A', account: 'P1', reason: asked.reason },
    records: sent,
    stripe: { webhookSecret: secrets.webhookSecret, events: events.map((event) => ({ id: event.id, type: event.type })), subscription,
      sign: 'Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with webhookSecret>, within 300 seconds of now.' },
    contactRequest: { name: 'Pat Cole', email: 'pat.cole@example.test' },
  };
}
