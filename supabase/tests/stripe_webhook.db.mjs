// The stripe-webhook edge function (supabase/functions/stripe-webhook), run
// under Node: Node strips the types from its .ts files, and there is no Deno
// here. verify.ts is checked against signatures made with Node's own HMAC, as
// Stripe documents them; handler.ts with a stand-in for fetch; and the whole
// path, from a signed request to company_billing, with that stand-in passing
// the calls to a local database as PostgREST would, with the server key.
//
// The secrets, ids and keys here are made up.

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { startCompany, startDatabase } from './harness.mjs';

const FUNCTION = new URL('../functions/stripe-webhook/', import.meta.url);
const { TOLERANCE_SECONDS, checkHeader, parseSignatureHeader, sameBytes, verifyStripeSignature } = await import(new URL('verify.ts', FUNCTION));
const { SECRET_TTL_MS, keyHeaders, makeHandler, serverFrom } = await import(new URL('handler.ts', FUNCTION));

const SECRET = `whsec_test_${randomBytes(16).toString('hex')}`;
const NOW = 1795000000;

/** The Stripe-Signature header Stripe would send for this body, signed at t. */
function sign(body, { secret = SECRET, t = NOW, extra = [] } = {}) {
  const v1 = createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
  return [`t=${t}`, `v1=${v1}`, ...extra].join(',');
}

const BODY = JSON.stringify({ id: 'evt_test1', object: 'event', type: 'customer.created', created: NOW, data: { object: { id: 'cus_test1' } } });

describe('verify.ts', () => {
  it('takes a body Stripe signed with the secret', async () => {
    assert.deepEqual(await verifyStripeSignature({ payload: BODY, header: sign(BODY), secret: SECRET, now: NOW }), { ok: true, timestamp: NOW });
    // As bytes too, and with spaces around the parts.
    const header = sign(BODY).replace(',', ' , ');
    assert.equal((await verifyStripeSignature({ payload: new TextEncoder().encode(BODY), header, secret: SECRET, now: NOW })).ok, true);
  });

  it('signs the raw bytes, so a body that is not UTF-8 still checks out byte for byte', async () => {
    const bytes = Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]);
    const header = sign(Buffer.from(bytes));
    assert.equal((await verifyStripeSignature({ payload: bytes, header, secret: SECRET, now: NOW })).ok, true);
    // Decoding and encoding again would have changed them.
    const roundTrip = new TextEncoder().encode(new TextDecoder().decode(bytes));
    assert.deepEqual(await verifyStripeSignature({ payload: roundTrip, header, secret: SECRET, now: NOW }), { ok: false, reason: 'mismatch' });
  });

  it('takes any v1 that matches, as while a secret is rolled, and ignores v0', async () => {
    const other = createHmac('sha256', 'whsec_test_other').update(`${NOW}.${BODY}`).digest('hex');
    const header = `t=${NOW},v1=${other},v1=${sign(BODY).split('v1=')[1]},v0=${'0'.repeat(64)}`;
    assert.equal((await verifyStripeSignature({ payload: BODY, header, secret: SECRET, now: NOW })).ok, true);
    assert.equal((await verifyStripeSignature({ payload: BODY, header: `t=${NOW},v1=${other}`, secret: SECRET, now: NOW })).reason, 'mismatch');
  });

  it('refuses another secret, a changed body, and a signature of another time', async () => {
    const header = sign(BODY);
    assert.equal((await verifyStripeSignature({ payload: BODY, header, secret: 'whsec_test_wrong', now: NOW })).reason, 'mismatch');
    assert.equal((await verifyStripeSignature({ payload: BODY.replace('cus_test1', 'cus_test2'), header, secret: SECRET, now: NOW })).reason, 'mismatch');
    assert.equal((await verifyStripeSignature({ payload: `${BODY} `, header, secret: SECRET, now: NOW })).reason, 'mismatch');
    const v1 = header.split('v1=')[1];
    assert.equal((await verifyStripeSignature({ payload: BODY, header: `t=${NOW + 1},v1=${v1}`, secret: SECRET, now: NOW })).reason, 'mismatch');
  });

  it(`refuses a signature more than ${TOLERANCE_SECONDS} seconds from now, either way`, async () => {
    assert.equal(TOLERANCE_SECONDS, 300);
    for (const [t, ok] of [[NOW - 300, true], [NOW - 301, false], [NOW + 300, true], [NOW + 301, false], [0, false]]) {
      const verdict = await verifyStripeSignature({ payload: BODY, header: sign(BODY, { t }), secret: SECRET, now: NOW });
      assert.equal(verdict.ok, ok, `t = now ${t - NOW}`);
      if (!ok) assert.equal(verdict.reason, 'outside_tolerance');
    }
  });

  it('refuses a header that is missing or not one Stripe sends', async () => {
    const v1 = sign(BODY).split('v1=')[1];
    const cases = [
      [null, 'no_header'],
      ['', 'no_header'],
      ['   ', 'no_header'],
      ['garbage', 'malformed_header'],
      [`v1=${v1}`, 'malformed_header'],
      [`t=abc,v1=${v1}`, 'malformed_header'],
      [`t=${NOW},t=${NOW},v1=${v1}`, 'malformed_header'],
      [`t=${NOW}.5,v1=${v1}`, 'malformed_header'],
      [`t=${NOW}`, 'no_v1_signature'],
      [`t=${NOW},v0=${v1}`, 'no_v1_signature'],
      [`t=${NOW},v1=${v1.slice(1)}`, 'no_v1_signature'],
      [`t=${NOW},v1=${'z'.repeat(64)}`, 'no_v1_signature'],
      [`t=${NOW},v1=${v1}${'0'.repeat(9000)}`, 'malformed_header'],
    ];
    for (const [header, reason] of cases) {
      assert.deepEqual(await verifyStripeSignature({ payload: BODY, header, secret: SECRET, now: NOW }), { ok: false, reason }, String(header).slice(0, 40));
    }
  });

  it('refuses to check without a secret', async () => {
    for (const secret of [undefined, null, '', '  ']) {
      assert.deepEqual(await verifyStripeSignature({ payload: BODY, header: sign(BODY), secret, now: NOW }), { ok: false, reason: 'no_secret' });
    }
  });

  it('reads the header into its time and signatures', () => {
    const parsed = parseSignatureHeader(sign(BODY, { extra: ['v0=abc', 'scheme=x', 'novalue'] }));
    assert.equal(parsed.timestamp, NOW);
    assert.equal(parsed.signatures.length, 1);
    assert.equal(parsed.signatures[0].length, 32);
    assert.equal(checkHeader(sign(BODY), NOW).ok, true);
  });

  it('compares bytes whole', () => {
    assert.equal(sameBytes(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3])), true);
    assert.equal(sameBytes(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 4])), false);
    assert.equal(sameBytes(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2])), false);
  });
});

// ---- The handler, with a stand-in for the database --------------------------------------------------

const URL_ = 'https://project.example.test';
const SECRET_KEY = 'sb_secret_test_madeup';
const LEGACY_KEY = 'eyJhbGciOiJIUzI1NiJ9.test.madeup';

/** A stand-in for fetch that answers the database functions with `answers` and records each call. */
function database(answers = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const name = url.replace(`${URL_}/rest/v1/rpc/`, '');
    calls.push({ url, name, headers: init.headers, body: JSON.parse(init.body), method: init.method });
    const reply = answers[name];
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(JSON.parse(init.body));
    if (reply && reply.status) return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
    return new Response(JSON.stringify(reply ?? { applied: false, reason: 'ignored_type' }), { status: 200 });
  };
  return { fetch, calls };
}

function environment(values) {
  return (name) => values[name];
}

const ENV = { SUPABASE_URL: URL_, SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }), STRIPE_WEBHOOK_SECRET: SECRET };

function post(body = BODY, { header = sign(body), method = 'POST' } = {}) {
  const headers = header === null ? {} : { 'Stripe-Signature': header };
  return new Request('https://project.example.test/functions/v1/stripe-webhook', { method, headers, body: method === 'GET' ? undefined : body });
}

function handler({ env = ENV, answers, now = NOW * 1000 } = {}) {
  const db = database(answers);
  const clock = { now };
  const logged = [];
  const handle = makeHandler({ env: environment(env), fetch: db.fetch, now: () => clock.now, log: (m) => logged.push(m) });
  return { handle, calls: db.calls, clock, logged };
}

describe('handler.ts', () => {
  it('takes POST only', async () => {
    const { handle, calls } = handler();
    const response = await handle(post(BODY, { method: 'GET' }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.deepEqual(calls, []);
  });

  it('answers 400 to a missing, stale or wrong signature, and calls the database for none of them', async () => {
    const { handle, calls } = handler();
    for (const request of [
      post(BODY, { header: null }),
      post(BODY, { header: 'nonsense' }),
      post(BODY, { header: sign(BODY, { t: NOW - 3600 }) }),
      post(BODY, { header: sign(BODY, { secret: 'whsec_test_wrong' }) }),
      post(`${BODY} `, { header: sign(BODY) }),
    ]) {
      const response = await handle(request);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Stripe signature/);
    }
    assert.deepEqual(calls, []);
  });

  it('hands a signed event to apply_stripe_event with the secret key as apikey only, and gives Stripe its answer', async () => {
    const { handle, calls } = handler({ answers: { apply_stripe_event: { applied: false, reason: 'ignored_type' } } });
    const response = await handle(post());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { applied: false, reason: 'ignored_type' });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, `${URL_}/rest/v1/rpc/apply_stripe_event`);
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, { p_event: JSON.parse(BODY) });
    assert.equal(call.headers.apikey, SECRET_KEY);
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.headers['Content-Type'], 'application/json');
  });

  it('uses the legacy service_role key, as apikey and bearer token, only when there is no secret key', async () => {
    for (const env of [
      { ...ENV, SUPABASE_SECRET_KEYS: undefined, SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY },
      { ...ENV, SUPABASE_SECRET_KEYS: 'not json', SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY },
      { ...ENV, SUPABASE_SECRET_KEYS: JSON.stringify({ other: SECRET_KEY }), SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY },
    ]) {
      const { handle, calls } = handler({ env });
      assert.equal((await handle(post())).status, 200);
      assert.deepEqual([calls[0].headers.apikey, calls[0].headers.Authorization], [LEGACY_KEY, `Bearer ${LEGACY_KEY}`]);
    }
    // Both set: the secret key.
    const { handle, calls } = handler({ env: { ...ENV, SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY } });
    await handle(post());
    assert.equal(calls[0].headers.apikey, SECRET_KEY);
    assert.deepEqual(keyHeaders(SECRET_KEY), { apikey: SECRET_KEY });
    assert.deepEqual(serverFrom(environment({ SUPABASE_URL: `${URL_}/`, SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY })), { url: URL_, key: LEGACY_KEY });
  });

  it('answers 500 when the server is not set up, so Stripe sends the event again later', async () => {
    for (const env of [{ ...ENV, SUPABASE_URL: undefined }, { ...ENV, SUPABASE_SECRET_KEYS: undefined }]) {
      const { handle, calls, logged } = handler({ env });
      const response = await handle(post());
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, /not set up/);
      assert.deepEqual(calls, []);
      assert.equal(logged.length, 1);
    }
  });

  it('answers 500 when the database cannot take the event, the function missing included', async () => {
    for (const reply of [
      { status: 500, body: { code: 'XX000', message: 'boom' } },
      { status: 404, body: { code: 'PGRST202', message: 'Could not find the function' } },
      { status: 401, body: { message: 'Invalid API key' } },
      new Error('network down'),
    ]) {
      const { handle, logged } = handler({ answers: { apply_stripe_event: reply } });
      const response = await handle(post());
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, /Stripe will send it again/);
      assert.equal(logged.length, 1);
      // The log says what failed, and never the secret, the key or the body.
      for (const line of logged) for (const secret of [SECRET, SECRET_KEY, 'cus_test1']) assert.ok(!line.includes(secret));
    }
  });

  it('answers 400 to a signed body that is not a Stripe event', async () => {
    for (const body of ['not json', '[]', '{"id": "evt_test2"}', '{"type": "x"}', 'null']) {
      const { handle, calls } = handler();
      const response = await handle(post(body, { header: sign(body) }));
      assert.equal(response.status, 400, body);
      assert.deepEqual(calls, []);
    }
  });

  it('reads the signing secret from Vault when STRIPE_WEBHOOK_SECRET is not set, and keeps it for a minute', async () => {
    const env = { ...ENV, STRIPE_WEBHOOK_SECRET: '' };
    const { handle, calls, clock } = handler({ env, answers: { stripe_webhook_secret: SECRET } });
    assert.equal((await handle(post())).status, 200);
    assert.deepEqual(calls.map((c) => c.name), ['stripe_webhook_secret', 'apply_stripe_event']);
    assert.deepEqual(calls[0].body, {});
    assert.equal(calls[0].headers.apikey, SECRET_KEY);

    clock.now += SECRET_TTL_MS - 1000;
    const later = JSON.stringify({ id: 'evt_test3', type: 'customer.created' });
    assert.equal((await handle(post(later, { header: sign(later, { t: Math.floor(clock.now / 1000) }) }))).status, 200);
    assert.deepEqual(calls.map((c) => c.name), ['stripe_webhook_secret', 'apply_stripe_event', 'apply_stripe_event']);

    clock.now += 2000;
    assert.equal((await handle(post(later, { header: sign(later, { t: Math.floor(clock.now / 1000) }) }))).status, 200);
    assert.equal(calls.filter((c) => c.name === 'stripe_webhook_secret').length, 2);
  });

  it('answers 500 when no signing secret is set anywhere', async () => {
    for (const reply of [null, '', { status: 404, body: { code: 'PGRST202' } }]) {
      const { handle, calls } = handler({ env: { ...ENV, STRIPE_WEBHOOK_SECRET: undefined }, answers: { stripe_webhook_secret: reply } });
      const response = await handle(post());
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, /signing secret is missing/);
      assert.deepEqual(calls.map((c) => c.name), ['stripe_webhook_secret']);
    }
  });
});

// ---- From Stripe to company_billing ----------------------------------------------------------------

describe('from a signed request to where the company stands', () => {
  let db;
  let company;
  before(async () => {
    db = await startDatabase();
    company = await startCompany(db, { name: 'Test Pit A', comped: false });
  });
  after(async () => {
    await db?.close();
  });

  /** fetch as PostgREST answers it for the server key, from the local database. */
  function postgrest(seen) {
    return async (url, init) => {
      const name = url.replace(`${URL_}/rest/v1/rpc/`, '');
      seen.push(name);
      assert.equal(init.headers.apikey, SECRET_KEY);
      const args = JSON.parse(init.body);
      const values = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v]));
      try {
        const result = await db.serviceRole().call(name, values);
        return new Response(JSON.stringify(result), { status: 200 });
      } catch (error) {
        return new Response(JSON.stringify({ code: error.code, message: error.message }), { status: 400 });
      }
    };
  }

  it('starts the trial, takes a second delivery once, and leaves another business alone', async () => {
    await db.admin("insert into vault.decrypted_secrets (name, decrypted_secret) values ('stripe_webhook_secret', $1)", [SECRET]);
    const seen = [];
    const handle = makeHandler({ env: environment({ ...ENV, STRIPE_WEBHOOK_SECRET: undefined }), fetch: postgrest(seen), now: () => NOW * 1000 });

    const sub = 'sub_test_e2e';
    const subscription = JSON.stringify({
      id: 'evt_test_e2e1', object: 'event', type: 'customer.subscription.created', created: NOW, livemode: true,
      data: { object: { id: sub, object: 'subscription', status: 'trialing', customer: 'cus_test_e2e', trial_end: NOW + 14 * 86400, cancel_at_period_end: false, metadata: { app: 'minemuster' }, items: { data: [{ current_period_end: NOW + 14 * 86400 }] } } },
    });
    const checkout = JSON.stringify({
      id: 'evt_test_e2e2', object: 'event', type: 'checkout.session.completed', created: NOW, livemode: true,
      data: { object: { id: 'cs_test_e2e', object: 'checkout.session', mode: 'subscription', client_reference_id: company.id, customer: 'cus_test_e2e', subscription: sub, metadata: { app: 'minemuster' } } },
    });
    const theirs = JSON.stringify({
      id: 'evt_test_e2e3', object: 'event', type: 'checkout.session.completed', created: NOW, livemode: true,
      data: { object: { id: 'cs_test_other', mode: 'subscription', client_reference_id: company.id, subscription: 'sub_test_other', metadata: {} } },
    });

    const results = [];
    for (const body of [subscription, checkout, checkout, theirs]) {
      const response = await handle(post(body));
      assert.equal(response.status, 200);
      results.push(await response.json());
    }
    assert.deepEqual(results.map((r) => r.applied), [true, true, false, false]);
    assert.deepEqual(results.slice(2).map((r) => r.reason), ['duplicate', 'not_minemuster']);
    // The secret was read from Vault once, then kept.
    assert.deepEqual(seen.filter((n) => n === 'stripe_webhook_secret').length, 1);

    const billing = await db.as(company.owner).call('company_billing', { p_company_id: company.id });
    assert.equal(billing.access, 'trial');
    assert.equal(Date.parse(billing.trial_end) / 1000, NOW + 14 * 86400);
    assert.deepEqual(await db.adminRows("select subscription_id from public.billing_subscriptions where subscription_id = 'sub_test_other'"), []);

    // A request signed with another secret changes nothing.
    const forged = subscription.replace('trialing', 'active').replace('evt_test_e2e1', 'evt_test_e2e4');
    const response = await handle(post(forged, { header: sign(forged, { secret: 'whsec_test_forged' }) }));
    assert.equal(response.status, 400);
    assert.equal((await db.as(company.owner).call('company_billing', { p_company_id: company.id })).access, 'trial');
  });
});
