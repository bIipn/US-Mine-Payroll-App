// Billing (migration 20261117000500): Stripe's events, applied by
// apply_stripe_event with the server key once the webhook has checked their
// signature, and where a company stands, from company_billing.
//
// The Stripe account is shared with another business, whose events reach the
// same webhook: they must change nothing. An event may come twice and in any
// order. The events here are shaped as Stripe sends them, cut down to the
// fields the server reads; every id in them is made up. The companies are
// "Test Pit A" and "Test Pit B".

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  BAD_INPUT,
  newMember,
  NO_PRIVILEGE,
  nobody,
  NOT_FOUND,
  NOT_SIGNED_IN,
  refused,
  secondSupervisor,
  startCompany,
  startDatabase,
} from './harness.mjs';

let db;
let a; // Test Pit A: supervisor Sam Ortiz
let b; // Test Pit B: supervisor Ana Diaz
let employeeA; // Riley J Quinn
let deputyA; // a second supervisor of A
let outsider; // an account in no company

before(async () => {
  db = await startDatabase();
  a = await startCompany(db, { name: 'Test Pit A', roster: [{ first: 'Riley J', last: 'Quinn' }], comped: false });
  employeeA = await newMember(db, a, 'Riley', 'Quinn');
  deputyA = await secondSupervisor(db, a, 'Dee', 'Hale');
  b = await startCompany(db, { name: 'Test Pit B', state: 'NV', supervisor: ['Ana', 'Diaz'], comped: false });
  outsider = await db.newAccount('outsider');
});
after(async () => {
  await db?.close();
});

// ---- Events, as Stripe sends them -------------------------------------------------------------------

/** Unix seconds, as Stripe writes a time. */
const T0 = 1795000000;
const DAY = 86400;
let made = 0;
const next = (prefix) => `${prefix}_test${(made += 1)}`;

/** A completed checkout from the MineMuster payment link, for a company. */
function checkout(companyId, subscription, { app = 'minemuster', mode = 'subscription', created = T0, customer = 'cus_test1', id = next('evt') } = {}) {
  return {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    created,
    livemode: true,
    data: {
      object: {
        id: next('cs'),
        object: 'checkout.session',
        mode,
        status: 'complete',
        payment_status: 'no_payment_required',
        client_reference_id: companyId,
        customer,
        subscription,
        metadata: app === null ? {} : { app },
      },
    },
  };
}

/**
 * A customer.subscription.* event. `period` puts current_period_end on the
 * subscription (older API versions); `itemPeriod` on its first item (newer).
 */
function subscriptionEvent(type, subscription, {
  status = 'trialing',
  created = T0,
  app = 'minemuster',
  trialEnd = T0 + 14 * DAY,
  period,
  itemPeriod = T0 + 14 * DAY,
  cancel = false,
  customer = 'cus_test1',
  id = next('evt'),
} = {}) {
  const object = {
    id: subscription,
    object: 'subscription',
    status,
    customer,
    trial_end: trialEnd,
    cancel_at_period_end: cancel,
    metadata: app === null ? {} : { app },
    items: { object: 'list', data: [{ id: next('si'), current_period_end: itemPeriod }] },
  };
  if (period !== undefined) object.current_period_end = period;
  return { id, object: 'event', type: `customer.subscription.${type}`, created, livemode: true, data: { object } };
}

const apply = (event) => db.serviceRole().call('apply_stripe_event', { p_event: JSON.stringify(event) });

/** The subscription's row, as the owner sees it, or undefined. */
async function row(subscription) {
  const [found] = await db.adminRows('select * from public.billing_subscriptions where subscription_id = $1', [subscription]);
  return found;
}

const billing = (account, companyId) => db.as(account).call('company_billing', { p_company_id: companyId });

const seconds = (value) => (value == null ? null : Date.parse(value) / 1000);

/** A company of its own, for a test that must start with no billing. */
async function freshCompany(name) {
  return startCompany(db, { name, supervisor: ['Kit', 'Marlow'], comped: false });
}

// ---- Who may do what --------------------------------------------------------------------------------

describe('who reaches billing', () => {
  it('only the server key applies an event or reads the signing secret', async () => {
    const event = JSON.stringify(checkout(a.id, next('sub')));
    for (const session of [db.anon(), db.as(a.owner), db.as(employeeA), db.noAccount()]) {
      await refused(session.call('apply_stripe_event', { p_event: event }), NO_PRIVILEGE, /permission denied for function apply_stripe_event/);
      await refused(session.call('stripe_webhook_secret'), NO_PRIVILEGE, /permission denied for function stripe_webhook_secret/);
    }
    assert.deepEqual(await db.adminRows('select * from public.stripe_events where id = $1', [JSON.parse(event).id]), []);
  });

  it('nobody reads stripe_events or contact_requests through the API, the server key included for stripe_events', async () => {
    for (const session of [db.anon(), db.as(a.owner), db.as(employeeA), db.noAccount()]) {
      for (const table of ['stripe_events', 'contact_requests']) {
        await refused(session.query(`select * from public.${table}`), NO_PRIVILEGE, new RegExp(`permission denied for table ${table}`));
      }
    }
    await refused(db.serviceRole().query('select * from public.stripe_events'), NO_PRIVILEGE, /permission denied/);
  });

  it('nobody writes the billing tables through the API, supervisors and the server key included', async () => {
    const sub = next('sub');
    const writes = [
      ["insert into public.billing_subscriptions (subscription_id, company_id, status) values ($1, $2, 'active')", [sub, a.id]],
      ["insert into public.billing_overrides (company_id, reason) values ($1, 'Let in')", [a.id]],
      ["insert into public.stripe_events (id, type) values ($1, 'checkout.session.completed')", [next('evt')]],
      ["insert into public.contact_requests (name, email, message) values ('Pat Cole', 'pat@example.test', 'Hello')", []],
      ["update public.billing_subscriptions set status = 'active'", []],
      ['update public.billing_overrides set until = null', []],
      ['delete from public.billing_subscriptions', []],
      ['delete from public.billing_overrides', []],
      ...['billing_subscriptions', 'billing_overrides', 'stripe_events', 'contact_requests'].map((t) => [`truncate public.${t}`, []]),
    ];
    for (const session of [db.anon(), db.as(a.owner), db.as(employeeA), db.serviceRole()]) {
      for (const [sql, params] of writes) await refused(session.query(sql, params), NO_PRIVILEGE, /permission denied/);
    }
  });

  it("a company's supervisors read its subscriptions and its override; nobody else reads them", async () => {
    const company = await freshCompany('Test Pit R');
    const sub = next('sub');
    await apply(subscriptionEvent('created', sub));
    await apply(checkout(company.id, sub));
    await db.admin("insert into public.billing_overrides (company_id, reason) values ($1, 'Pilot')", [company.id]);
    const deputy = await secondSupervisor(db, company, 'Jo', 'Vale');

    for (const supervisor of [company.owner, deputy]) {
      const subs = await db.as(supervisor).rows('select subscription_id, company_id, status from public.billing_subscriptions');
      assert.deepEqual(subs, [{ subscription_id: sub, company_id: company.id, status: 'trialing' }]);
      assert.deepEqual(await db.as(supervisor).rows('select company_id, reason from public.billing_overrides'), [{ company_id: company.id, reason: 'Pilot' }]);
    }
    for (const account of [employeeA, a.owner, b.owner, outsider]) {
      assert.deepEqual(await db.as(account).rows('select * from public.billing_subscriptions where company_id = $1', [company.id]), []);
      assert.deepEqual(await db.as(account).rows('select * from public.billing_overrides where company_id = $1', [company.id]), []);
    }
    await refused(db.anon().query('select * from public.billing_subscriptions'), NO_PRIVILEGE, /permission denied/);
    await refused(db.anon().query('select * from public.billing_overrides'), NO_PRIVILEGE, /permission denied/);
  });

  it('the policies call no function on each row: the caller\'s companies are worked out once per statement', async () => {
    for (const table of ['billing_subscriptions', 'billing_overrides']) {
      const [plan] = await db.as(a.owner).rows(`explain (format json, costs off) select * from public.${table}`);
      const text = JSON.stringify(plan['QUERY PLAN']);
      assert.doesNotMatch(text, /is_supervisor|is_member|"Filter"/, table);
      // The caller's companies, worked out once (an InitPlan), as an index condition.
      assert.match(text, /"Index Cond":"\(company_id = ANY \(\(InitPlan 1\)/, table);
    }
  });

  it('company_billing is for the supervisors of the company, and tells anyone else there is no such company', async () => {
    assert.equal((await billing(a.owner, a.id)).access, 'none');
    assert.equal((await billing(deputyA, a.id)).access, 'none');
    await refused(billing(employeeA, a.id), NOT_FOUND, /No such company/);
    await refused(billing(b.owner, a.id), NOT_FOUND, /No such company/);
    await refused(billing(outsider, a.id), NOT_FOUND, /No such company/);
    await refused(billing(a.owner, nobody()), NOT_FOUND, /No such company/);
    await refused(db.as(a.owner).call('company_billing', { p_company_id: null }), NOT_FOUND, /No such company/);
    await refused(db.noAccount().call('company_billing', { p_company_id: a.id }), NOT_SIGNED_IN, /Sign in first/);
    await refused(db.anon().call('company_billing', { p_company_id: a.id }), NO_PRIVILEGE, /permission denied for function company_billing/);
  });

  it('a supervisor banned by Supabase Auth reads no billing', async () => {
    const company = await freshCompany('Test Pit Q');
    await db.admin("update auth.users set banned_until = now() + interval '1 day' where id = $1", [company.owner]);
    await refused(billing(company.owner, company.id), NOT_FOUND, /No such company/);
    assert.deepEqual(await db.as(company.owner).rows('select * from public.billing_subscriptions'), []);
  });
});

// ---- Applying events --------------------------------------------------------------------------------

describe('apply_stripe_event', () => {
  it('refuses only what is not a Stripe event at all', async () => {
    for (const bad of ['[]', '"evt_test"', '{}', '{"id": "evt_x"}', '{"type": "checkout.session.completed"}', '{"id": 7, "type": "x"}', '{"id": "", "type": "x"}']) {
      await refused(db.serviceRole().rows('select public.apply_stripe_event(p_event => $1::text::jsonb) as r', [bad]), BAD_INPUT, /Stripe event/);
    }
    await refused(db.serviceRole().call('apply_stripe_event', { p_event: null }), BAD_INPUT, /Stripe event/);
  });

  it("changes nothing for another business's events, and answers so Stripe stops sending them", async () => {
    const before = await db.adminRows('select * from public.billing_subscriptions order by subscription_id');
    const theirs = next('sub');
    const answers = [
      await apply(checkout(a.id, theirs, { app: null })),
      await apply(checkout(a.id, theirs, { app: 'agency' })),
      await apply(subscriptionEvent('created', theirs, { app: null })),
      await apply(subscriptionEvent('updated', theirs, { app: 'agency', status: 'active' })),
      await apply(subscriptionEvent('deleted', theirs, { app: null, status: 'canceled' })),
      await apply({ id: next('evt'), type: 'invoice.paid', created: T0, livemode: true, data: { object: { id: next('in'), subscription: theirs } } }),
      await apply({ id: next('evt'), type: 'payment_intent.succeeded', created: T0, livemode: true, data: { object: { id: next('pi'), metadata: { app: 'minemuster' } } } }),
      await apply({ id: next('evt'), type: 'customer.created', created: T0, livemode: true }),
      await apply({ id: next('evt'), type: 'checkout.session.completed', created: T0, livemode: true, data: { object: 'not an object' } }),
    ];
    assert.deepEqual(answers.map((r) => r.reason), [
      'not_minemuster', 'not_minemuster', 'not_minemuster', 'not_minemuster', 'not_minemuster',
      'ignored_type', 'ignored_type', 'ignored_type', 'not_minemuster',
    ]);
    for (const answer of answers) assert.equal(answer.applied, false);
    assert.equal(await row(theirs), undefined);
    assert.deepEqual(await db.adminRows('select * from public.billing_subscriptions order by subscription_id'), before);
    assert.equal((await billing(a.owner, a.id)).access, 'none');
  });

  it('applies an event delivered twice once', async () => {
    const company = await freshCompany('Test Pit D');
    const sub = next('sub');
    const created = subscriptionEvent('created', sub, { status: 'trialing' });
    assert.equal((await apply(created)).applied, true);
    // The same event id again, even with a newer time and another status, is not applied again.
    assert.deepEqual(await apply(created), { applied: false, reason: 'duplicate' });
    assert.deepEqual(await apply({ ...created, created: T0 + DAY, data: { object: { ...created.data.object, status: 'canceled' } } }), { applied: false, reason: 'duplicate' });
    assert.equal((await row(sub)).status, 'trialing');

    const linked = checkout(company.id, sub);
    assert.equal((await apply(linked)).applied, true);
    assert.deepEqual(await apply(linked), { applied: false, reason: 'duplicate' });
    const events = await db.adminRows('select id, type, outcome from public.stripe_events where id = any ($1) order by id', [[created.id, linked.id]]);
    assert.deepEqual(events.map((e) => e.outcome), ['applied', 'applied']);
    assert.equal((await billing(company.owner, company.id)).access, 'trial');
  });

  it('records why an event changed nothing', async () => {
    const event = checkout(a.id, next('sub'), { app: 'agency' });
    await apply(event);
    const [seen] = await db.adminRows('select type, outcome from public.stripe_events where id = $1', [event.id]);
    assert.deepEqual(seen, { type: 'checkout.session.completed', outcome: 'not_minemuster' });
  });
});

describe('a checkout ties a subscription to a company', () => {
  it('only an existing company, named by its id', async () => {
    for (const ref of [nobody(), 'not-a-uuid', '', null, 42]) {
      const sub = next('sub');
      const event = checkout(a.id, sub);
      event.data.object.client_reference_id = ref;
      assert.deepEqual(await apply(event), { applied: false, reason: 'no_company' }, String(ref));
      assert.equal(await row(sub), undefined);
    }
  });

  it('only for a subscription', async () => {
    const event = checkout(a.id, null, { mode: 'payment' });
    assert.deepEqual(await apply(event), { applied: false, reason: 'not_subscription' });
    const noSub = checkout(a.id, null);
    assert.deepEqual(await apply(noSub), { applied: false, reason: 'no_subscription' });
    const oddSub = checkout(a.id, 'sub with spaces');
    assert.deepEqual(await apply(oddSub), { applied: false, reason: 'no_subscription' });
  });

  it('once: the first link stands, and a later checkout naming another company changes nothing', async () => {
    const company = await freshCompany('Test Pit E');
    const sub = next('sub');
    const first = await apply(checkout(company.id, sub, { customer: 'cus_test9' }));
    assert.deepEqual(first, { applied: true, type: 'checkout.session.completed', subscription_id: sub, company_id: company.id });
    assert.equal((await row(sub)).company_id, company.id);
    assert.equal((await row(sub)).customer_id, 'cus_test9');
    assert.equal((await row(sub)).status, null);

    assert.deepEqual(await apply(checkout(b.id, sub)), { applied: false, reason: 'already_linked' });
    assert.equal((await row(sub)).company_id, company.id);
    assert.equal((await billing(b.owner, b.id)).access, 'none');
    // The same company again is no change.
    assert.equal((await apply(checkout(company.id, sub))).applied, true);
    assert.equal((await row(sub)).company_id, company.id);
  });

  it('takes the subscription and customer as ids or as expanded objects', async () => {
    const company = await freshCompany('Test Pit F');
    const sub = next('sub');
    const event = checkout(company.id, { id: sub, object: 'subscription' }, { customer: { id: 'cus_test7', object: 'customer' } });
    assert.equal((await apply(event)).applied, true);
    assert.deepEqual([(await row(sub)).company_id, (await row(sub)).customer_id], [company.id, 'cus_test7']);
  });

  it("links a subscription whose own events came first, and keeps the status they set", async () => {
    const company = await freshCompany('Test Pit G');
    const sub = next('sub');
    await apply(subscriptionEvent('created', sub, { status: 'trialing', trialEnd: T0 + 14 * DAY }));
    assert.equal((await row(sub)).company_id, null);
    await apply(checkout(company.id, sub));
    const linked = await row(sub);
    assert.deepEqual([linked.company_id, linked.status], [company.id, 'trialing']);
    assert.equal((await billing(company.owner, company.id)).access, 'trial');
  });

  it('a checkout whose subscription has not said its status yet counts as a trial', async () => {
    const company = await freshCompany('Test Pit H');
    await apply(checkout(company.id, next('sub')));
    assert.deepEqual(await billing(company.owner, company.id), {
      access: 'trial',
      status: null,
      trial_end: null,
      current_period_end: null,
      cancel_at_period_end: false,
      running: 1,
      had_trial: false,
    });
  });
});

describe('subscription events', () => {
  it('trial, then active, then past due, then ended', async () => {
    const company = await freshCompany('Test Pit I');
    const sub = next('sub');
    await apply(checkout(company.id, sub));
    const steps = [
      ['created', { status: 'trialing', created: T0, trialEnd: T0 + 14 * DAY, itemPeriod: T0 + 14 * DAY }, 'trial'],
      ['updated', { status: 'active', created: T0 + 14 * DAY, trialEnd: T0 + 14 * DAY, itemPeriod: T0 + 44 * DAY }, 'active'],
      ['updated', { status: 'past_due', created: T0 + 44 * DAY, trialEnd: T0 + 14 * DAY, itemPeriod: T0 + 74 * DAY }, 'past_due'],
      ['deleted', { status: 'canceled', created: T0 + 60 * DAY, trialEnd: T0 + 14 * DAY, itemPeriod: T0 + 74 * DAY }, 'ended'],
    ];
    for (const [type, options, access] of steps) {
      const answer = await apply(subscriptionEvent(type, sub, options));
      assert.deepEqual(answer, { applied: true, type: `customer.subscription.${type}`, subscription_id: sub, status: options.status });
      const now = await billing(company.owner, company.id);
      assert.equal(now.access, access, type);
      assert.equal(now.status, options.status);
      assert.equal(seconds(now.trial_end), options.trialEnd);
      assert.equal(seconds(now.current_period_end), options.itemPeriod);
      assert.equal(now.cancel_at_period_end, false);
    }
    assert.equal(seconds((await row(sub)).event_at), T0 + 60 * DAY);
  });

  it('reads current_period_end from the subscription in older API versions, and from its first item in newer ones', async () => {
    const company = await freshCompany('Test Pit J');
    const older = next('sub');
    const newer = next('sub');
    await apply(subscriptionEvent('created', older, { period: T0 + 30 * DAY, itemPeriod: undefined }));
    await apply(subscriptionEvent('created', newer, { itemPeriod: T0 + 31 * DAY }));
    assert.equal(seconds((await row(older)).current_period_end), T0 + 30 * DAY);
    assert.equal(seconds((await row(newer)).current_period_end), T0 + 31 * DAY);
    await apply(checkout(company.id, newer));
    assert.equal(seconds((await billing(company.owner, company.id)).current_period_end), T0 + 31 * DAY);
  });

  it('a cancellation at the end of the period keeps the company in until then', async () => {
    const company = await freshCompany('Test Pit K');
    const sub = next('sub');
    await apply(checkout(company.id, sub));
    await apply(subscriptionEvent('updated', sub, { status: 'active', created: T0 + 20 * DAY, itemPeriod: T0 + 44 * DAY, cancel: true }));
    const cancelled = await billing(company.owner, company.id);
    assert.deepEqual([cancelled.access, cancelled.cancel_at_period_end, seconds(cancelled.current_period_end)], ['active', true, T0 + 44 * DAY]);
    await apply(subscriptionEvent('deleted', sub, { status: 'canceled', created: T0 + 44 * DAY, itemPeriod: T0 + 44 * DAY, cancel: true }));
    assert.equal((await billing(company.owner, company.id)).access, 'ended');
  });

  it('an older event never overwrites a newer one', async () => {
    const company = await freshCompany('Test Pit L');
    const sub = next('sub');
    await apply(checkout(company.id, sub));
    await apply(subscriptionEvent('updated', sub, { status: 'active', created: T0 + 15 * DAY, itemPeriod: T0 + 45 * DAY }));
    // The trial's own events, delivered late.
    assert.deepEqual(await apply(subscriptionEvent('created', sub, { status: 'trialing', created: T0 })), { applied: false, reason: 'stale' });
    assert.deepEqual(await apply(subscriptionEvent('updated', sub, { status: 'trialing', created: T0 + DAY, cancel: true })), { applied: false, reason: 'stale' });
    const kept = await row(sub);
    assert.deepEqual([kept.status, kept.cancel_at_period_end, seconds(kept.current_period_end), seconds(kept.event_at)], ['active', false, T0 + 45 * DAY, T0 + 15 * DAY]);
    // One of the same second is applied: Stripe's times are whole seconds.
    assert.equal((await apply(subscriptionEvent('updated', sub, { status: 'active', created: T0 + 15 * DAY, itemPeriod: T0 + 45 * DAY, cancel: true }))).applied, true);
    assert.equal((await row(sub)).cancel_at_period_end, true);
  });

  it('a subscription that has ended stays ended, whatever comes after', async () => {
    const company = await freshCompany('Test Pit M');
    const sub = next('sub');
    await apply(checkout(company.id, sub));
    await apply(subscriptionEvent('deleted', sub, { status: 'canceled', created: T0 + 10 * DAY }));
    assert.deepEqual(await apply(subscriptionEvent('updated', sub, { status: 'active', created: T0 + 10 * DAY })), { applied: false, reason: 'ended' });
    assert.deepEqual(await apply(subscriptionEvent('updated', sub, { status: 'trialing', created: T0 + 11 * DAY })), { applied: false, reason: 'ended' });
    assert.equal((await row(sub)).status, 'canceled');
    // Another ending is still taken.
    assert.equal((await apply(subscriptionEvent('deleted', sub, { status: 'canceled', created: T0 + 12 * DAY, id: next('evt') }))).applied, true);
    assert.equal((await billing(company.owner, company.id)).access, 'ended');
  });

  it('applies the events of a subscription a MineMuster checkout brought in, metadata or not', async () => {
    const company = await freshCompany('Test Pit N');
    const sub = next('sub');
    await apply(checkout(company.id, sub));
    assert.equal((await apply(subscriptionEvent('updated', sub, { app: null, status: 'active', created: T0 + 15 * DAY }))).applied, true);
    assert.equal((await billing(company.owner, company.id)).access, 'active');
  });

  it('every other status is ended', async () => {
    for (const status of ['canceled', 'unpaid', 'paused', 'incomplete', 'incomplete_expired']) {
      const company = await freshCompany(`Test Pit ${status}`);
      const sub = next('sub');
      await apply(checkout(company.id, sub));
      await apply(subscriptionEvent('updated', sub, { status, created: T0 + 3 * DAY }));
      const answer = await billing(company.owner, company.id);
      assert.deepEqual([answer.access, answer.status], ['ended', status]);
    }
  });

  it('sets aside a status it does not know, and odd values, without raising', async () => {
    const sub = next('sub');
    assert.deepEqual(await apply(subscriptionEvent('created', sub, { status: 'frozen' })), { applied: false, reason: 'unknown_status' });
    assert.deepEqual(await apply(subscriptionEvent('created', sub, { status: null })), { applied: false, reason: 'unknown_status' });
    assert.equal(await row(sub), undefined);
    const noTime = subscriptionEvent('created', sub);
    noTime.created = 'yesterday';
    assert.deepEqual(await apply(noTime), { applied: false, reason: 'no_time' });
    const noId = subscriptionEvent('created', sub);
    delete noId.data.object.id;
    assert.deepEqual(await apply(noId), { applied: false, reason: 'no_subscription' });
    // A time that is not one becomes no time; a flag that is not one becomes false.
    const odd = subscriptionEvent('created', sub, { trialEnd: 'soon', itemPeriod: 1e300, cancel: 'yes' });
    assert.equal((await apply(odd)).applied, true);
    const kept = await row(sub);
    assert.deepEqual([kept.trial_end, kept.current_period_end, kept.cancel_at_period_end], [null, null, false]);
    const huge = subscriptionEvent('updated', sub, { created: T0 + 1, trialEnd: -5, itemPeriod: 99999999999999 });
    assert.equal((await apply(huge)).applied, true);
    assert.deepEqual([(await row(sub)).trial_end, (await row(sub)).current_period_end], [null, null]);
  });
});

// ---- Where a company stands -------------------------------------------------------------------------

describe('company_billing', () => {
  it('none with no subscription', async () => {
    const company = await freshCompany('Test Pit O');
    assert.deepEqual(await billing(company.owner, company.id), {
      access: 'none',
      status: null,
      trial_end: null,
      current_period_end: null,
      cancel_at_period_end: false,
      running: 0,
      had_trial: false,
    });
  });

  it('comped with an override for good, or until a time still to come; not once that time has passed', async () => {
    const company = await freshCompany('Test Pit P');
    await db.admin("insert into public.billing_overrides (company_id, reason) values ($1, 'Pilot')", [company.id]);
    assert.equal((await billing(company.owner, company.id)).access, 'comped');
    await db.admin("update public.billing_overrides set until = now() + interval '30 days' where company_id = $1", [company.id]);
    assert.equal((await billing(company.owner, company.id)).access, 'comped');
    await db.admin("update public.billing_overrides set until = now() - interval '1 minute' where company_id = $1", [company.id]);
    assert.equal((await billing(company.owner, company.id)).access, 'none');

    // Comped over an ended subscription, with that subscription's status and dates.
    const sub = next('sub');
    await apply(checkout(company.id, sub));
    await apply(subscriptionEvent('deleted', sub, { status: 'canceled', created: T0 + 5 * DAY, itemPeriod: T0 + 14 * DAY }));
    assert.equal((await billing(company.owner, company.id)).access, 'ended');
    await db.admin('update public.billing_overrides set until = null where company_id = $1', [company.id]);
    const comped = await billing(company.owner, company.id);
    assert.deepEqual([comped.access, comped.status, seconds(comped.current_period_end)], ['comped', 'canceled', T0 + 14 * DAY]);
  });

  it('an override must say why', async () => {
    const company = await freshCompany('Test Pit S');
    await refused(db.admin("insert into public.billing_overrides (company_id, reason) values ($1, '  ')", [company.id]), '23514');
    await refused(db.admin('insert into public.billing_overrides (company_id, reason) values ($1, null)', [company.id]), '23502');
  });

  it('goes by a running subscription before one that ended, even a newer one', async () => {
    const company = await freshCompany('Test Pit T');
    const running = next('sub');
    const second = next('sub');
    await apply(checkout(company.id, running));
    await apply(subscriptionEvent('updated', running, { status: 'active', created: T0 + 15 * DAY, itemPeriod: T0 + 45 * DAY }));
    // A second checkout, made by mistake and cancelled, is newer than the running one.
    await apply(checkout(company.id, second));
    await apply(subscriptionEvent('created', second, { status: 'trialing', created: T0 + 16 * DAY }));
    await apply(subscriptionEvent('deleted', second, { status: 'canceled', created: T0 + 17 * DAY }));
    const answer = await billing(company.owner, company.id);
    assert.deepEqual([answer.access, answer.status, seconds(answer.current_period_end)], ['active', 'active', T0 + 45 * DAY]);
  });

  it('goes by the newest subscription when none is running', async () => {
    const company = await freshCompany('Test Pit U');
    const older = next('sub');
    const newer = next('sub');
    await apply(checkout(company.id, older));
    await apply(subscriptionEvent('deleted', older, { status: 'canceled', created: T0 + 5 * DAY }));
    await apply(checkout(company.id, newer));
    await apply(subscriptionEvent('updated', newer, { status: 'unpaid', created: T0 + 50 * DAY }));
    assert.equal((await billing(company.owner, company.id)).status, 'unpaid');
    // Started again on the payment link with no trial: the new subscription is what counts.
    const again = next('sub');
    await apply(checkout(company.id, again));
    await apply(subscriptionEvent('created', again, { status: 'active', created: T0 + 60 * DAY, trialEnd: null, itemPeriod: T0 + 90 * DAY }));
    const answer = await billing(company.owner, company.id);
    assert.deepEqual([answer.access, answer.status, seconds(answer.current_period_end), answer.running, answer.had_trial], ['active', 'active', T0 + 90 * DAY, 1, true]);
  });

  it("never counts another company's subscription", async () => {
    const company = await freshCompany('Test Pit V');
    const theirs = next('sub');
    await apply(checkout(b.id, theirs));
    await apply(subscriptionEvent('updated', theirs, { status: 'active', created: T0 + 15 * DAY }));
    assert.equal((await billing(b.owner, b.id)).access, 'active');
    assert.equal((await billing(company.owner, company.id)).access, 'none');
    // A subscription no checkout has tied to a company is nobody's.
    await apply(subscriptionEvent('created', next('sub'), { status: 'active' }));
    assert.equal((await billing(company.owner, company.id)).access, 'none');
  });

  it("goes with its company: deleting a company deletes its billing", async () => {
    const company = await freshCompany('Test Pit W');
    const sub = next('sub');
    await apply(checkout(company.id, sub));
    await db.admin("insert into public.billing_overrides (company_id, reason) values ($1, 'Pilot')", [company.id]);
    await db.admin('delete from public.companies where id = $1', [company.id]);
    assert.equal(await row(sub), undefined);
    assert.deepEqual(await db.adminRows('select * from public.billing_overrides where company_id = $1', [company.id]), []);
  });
});

describe('one free trial, and what a company is told', () => {
  it('a second free trial does not open the dashboard; the first charge does', async () => {
    const company = await freshCompany('Test Pit Y');
    const first = next('sub');
    await apply(checkout(company.id, first));
    await apply(subscriptionEvent('created', first, { created: T0 + 1 }));
    // Cancelled during the trial: it ends with the trial, and nothing is charged.
    await apply(subscriptionEvent('updated', first, { created: T0 + 2, cancel: true }));
    await apply(subscriptionEvent('deleted', first, { status: 'canceled', created: T0 + 14 * DAY, cancel: true }));
    assert.equal((await billing(company.owner, company.id)).access, 'ended');

    // The trial payment link again, with the company's id.
    const second = next('sub');
    await apply(checkout(company.id, second, { created: T0 + 15 * DAY }));
    await apply(subscriptionEvent('created', second, { created: T0 + 15 * DAY + 1, trialEnd: T0 + 29 * DAY, itemPeriod: T0 + 29 * DAY }));
    const again = await billing(company.owner, company.id);
    assert.deepEqual(
      [again.access, again.status, seconds(again.trial_end), again.running, again.had_trial],
      ['ended', 'trialing', T0 + 29 * DAY, 1, true],
      'a second trial is told apart, and still counted as running: Stripe charges it when it ends',
    );
    // When Stripe charges it, the company is in.
    await apply(subscriptionEvent('updated', second, { status: 'active', created: T0 + 29 * DAY, trialEnd: T0 + 29 * DAY, itemPeriod: T0 + 59 * DAY }));
    assert.equal((await billing(company.owner, company.id)).access, 'active');
  });

  it('two trials started at once count once, and the answer says two subscriptions are running', async () => {
    const company = await freshCompany('Test Pit Z');
    const one = next('sub');
    const two = next('sub');
    await apply(checkout(company.id, one));
    await apply(subscriptionEvent('created', one, { created: T0, trialEnd: T0 + 14 * DAY }));
    await apply(checkout(company.id, two));
    await apply(subscriptionEvent('created', two, { created: T0 + 60, trialEnd: T0 + 14 * DAY + 60 }));
    const both = await billing(company.owner, company.id);
    assert.deepEqual([both.access, both.status, seconds(both.trial_end), both.running, both.had_trial], ['trial', 'trialing', T0 + 14 * DAY, 2, true]);
    // One cancelled in the portal: no longer charged, so no longer counted.
    await apply(subscriptionEvent('updated', two, { created: T0 + 120, trialEnd: T0 + 14 * DAY + 60, cancel: true }));
    const one_left = await billing(company.owner, company.id);
    assert.deepEqual([one_left.access, one_left.running, one_left.cancel_at_period_end], ['trial', 1, false]);
  });

  it('a checkout whose subscription never said its status counts as a trial for an hour, then as none', async () => {
    const company = await freshCompany('Test Pit AA');
    const sub = next('sub');
    // The subscription's own events came first, without the metadata, so they were set aside...
    assert.equal((await apply(subscriptionEvent('created', sub, { app: null }))).reason, 'not_minemuster');
    assert.equal((await apply(subscriptionEvent('deleted', sub, { app: null, status: 'canceled', created: T0 + 5 }))).reason, 'not_minemuster');
    // ...and then the checkout: a row with no status, which none of its events will ever set.
    await apply(checkout(company.id, sub, { created: T0 + 10 }));
    assert.equal((await billing(company.owner, company.id)).access, 'trial');
    await db.admin("update public.billing_subscriptions set created_at = now() - interval '61 minutes', updated_at = now() - interval '61 minutes' where subscription_id = $1", [sub]);
    const later = await billing(company.owner, company.id);
    assert.deepEqual([later.access, later.status, later.running, later.had_trial], ['none', null, 0, false]);
    // Beside a subscription that ended, the one that ended is what the company is told.
    const ended = next('sub');
    await apply(checkout(company.id, ended));
    await apply(subscriptionEvent('deleted', ended, { status: 'canceled', created: T0 + 20 * DAY }));
    assert.deepEqual([(await billing(company.owner, company.id)).access, (await billing(company.owner, company.id)).status], ['ended', 'canceled']);
  });

  it("a checkout someone else made with a paying company's id changes nothing the company is told", async () => {
    const company = await freshCompany('Test Pit AB');
    const own = next('sub');
    await apply(checkout(company.id, own));
    await apply(subscriptionEvent('updated', own, { status: 'active', created: T0 + 20 * DAY, trialEnd: null, itemPeriod: T0 + 50 * DAY }));
    // Anyone who has the company's id can open the payment link with it, and then cancel that trial.
    const theirs = next('sub');
    await apply(checkout(company.id, theirs, { created: T0 + 30 * DAY }));
    await apply(subscriptionEvent('updated', theirs, { created: T0 + 30 * DAY + 1, cancel: true, trialEnd: T0 + 44 * DAY }));
    const answer = await billing(company.owner, company.id);
    assert.deepEqual(
      [answer.access, answer.status, answer.cancel_at_period_end, seconds(answer.current_period_end), answer.running],
      ['active', 'active', false, T0 + 50 * DAY, 1],
    );
    // Not cancelled, it would be charged too: the company is told two are running.
    await apply(subscriptionEvent('updated', theirs, { created: T0 + 30 * DAY + 2, cancel: false, trialEnd: T0 + 44 * DAY }));
    assert.deepEqual([(await billing(company.owner, company.id)).status, (await billing(company.owner, company.id)).running], ['active', 2]);
  });

  it('a comped company is told of a subscription that is still charged', async () => {
    const company = await freshCompany('Test Pit AC');
    const sub = next('sub');
    await apply(checkout(company.id, sub));
    await apply(subscriptionEvent('created', sub, { created: T0 + 1 }));
    await db.admin("insert into public.billing_overrides (company_id, reason) values ($1, 'Pilot')", [company.id]);
    const answer = await billing(company.owner, company.id);
    assert.deepEqual([answer.access, answer.status, answer.running], ['comped', 'trialing', 1]);
  });
});

describe("Stripe's test mode", () => {
  it('sets aside every event that is not from live mode, and changes nothing', async () => {
    const company = await freshCompany('Test Pit AD');
    const sub = next('sub');
    const events = [
      checkout(company.id, sub),
      subscriptionEvent('created', sub, { status: 'active' }),
      subscriptionEvent('updated', sub, { status: 'active', created: T0 + 1 }),
      { id: next('evt'), object: 'event', type: 'customer.created', created: T0 },
    ];
    for (const event of events) event.livemode = false;
    const unsaid = checkout(company.id, sub);
    delete unsaid.livemode;
    const asText = checkout(company.id, sub);
    asText.livemode = 'true';
    for (const event of [...events, unsaid, asText]) {
      assert.deepEqual(await apply(event), { applied: false, reason: 'test_mode' }, event.type);
      const [seen] = await db.adminRows('select outcome from public.stripe_events where id = $1', [event.id]);
      assert.equal(seen.outcome, 'test_mode');
    }
    assert.equal(await row(sub), undefined);
    assert.equal((await billing(company.owner, company.id)).access, 'none');
    // Live mode, the same subscription: applied.
    assert.equal((await apply(checkout(company.id, sub))).applied, true);
  });
});

// ---- What a supervisor reads goes by billing --------------------------------------------------------

/** The version of a record, as a phone makes one: 20 hex characters of a hash of it. */
const revOf = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 20);
const changeOf = (kind, id, record) => ({ key: `${kind}:${id}`, kind, id, rev: revOf(record), record });
const push = (account, companyId, changes) => db.as(account).call('push_records', { company_id: companyId, changes: JSON.stringify(changes) });
const keysRead = async (account, table, companyId) =>
  (await db.as(account).rows(`select kind || ':' || id as key from public.${table} where company_id = $1 order by 1`, [companyId])).map((r) => r.key);

describe('what a supervisor reads goes by billing', () => {
  let company;
  let crew;
  const unit = { id: 'eq-gate-1', unit: 'T-14', category: 'haul_truck', make: 'Made-up', model: 'HX 40', status: 'ready', meter: 1200, meterUnit: 'hrs' };
  const shift = { id: 'shift-gate-1', employeeId: 'emp-1', clockIn: 1763300000000, clockOut: null, edits: [] };
  const KEYS = ['equipment:eq-gate-1', 'shift:shift-gate-1'];

  before(async () => {
    company = await startCompany(db, { name: 'Test Pit AE', supervisor: ['Kit', 'Marlow'], roster: [{ first: 'Lee', last: 'Park' }], comped: false });
    crew = await newMember(db, company, 'Lee', 'Park');
  });

  it('with no subscription the phones still send, the crew reads as before, and a supervisor reads nothing', async () => {
    const sent = await push(company.owner, company.id, [changeOf('equipment', unit.id, unit)]);
    assert.deepEqual(sent.accepted.map((e) => e.key), ['equipment:eq-gate-1']);
    const own = await push(crew, company.id, [changeOf('shift', shift.id, shift)]);
    assert.deepEqual(own.accepted.map((e) => e.key), ['shift:shift-gate-1']);
    assert.equal((await billing(company.owner, company.id)).access, 'none');

    for (const table of ['records', 'record_history']) {
      assert.deepEqual(await keysRead(company.owner, table, company.id), [], table);
      assert.deepEqual(await keysRead(crew, table, company.id), KEYS, table);
    }
  });

  it('opens with a trial, a paid subscription, a charge being tried again or an override, and closes when it ends', async () => {
    const sub = next('sub');
    await apply(checkout(company.id, sub));
    for (const [status, created, open] of [['trialing', T0, true], ['active', T0 + 14 * DAY, true], ['past_due', T0 + 44 * DAY, true], ['canceled', T0 + 60 * DAY, false]]) {
      await apply(subscriptionEvent(status === 'canceled' ? 'deleted' : 'updated', sub, { status, created }));
      for (const table of ['records', 'record_history']) {
        assert.deepEqual(await keysRead(company.owner, table, company.id), open ? KEYS : [], `${status} ${table}`);
      }
    }
    await db.admin("insert into public.billing_overrides (company_id, reason) values ($1, 'Pilot')", [company.id]);
    assert.deepEqual(await keysRead(company.owner, 'records', company.id), KEYS);
    await db.admin("update public.billing_overrides set until = now() - interval '1 minute' where company_id = $1", [company.id]);
    assert.deepEqual(await keysRead(company.owner, 'records', company.id), []);
    // The crew, all along, as before.
    assert.deepEqual(await keysRead(crew, 'records', company.id), KEYS);
    await db.admin('delete from public.billing_overrides where company_id = $1', [company.id]);
  });

  it("goes company by company for a supervisor of two", async () => {
    const [other] = await db.as(company.owner).callRows('create_company', {
      name: 'Test Pit AF', state: 'CA', timezone: 'America/Los_Angeles', first_name: 'Kit', last_name: 'Marlow', title: null,
    });
    await db.admin("insert into public.billing_overrides (company_id, reason) values ($1, 'Pilot')", [other.company_id]);
    await push(company.owner, other.company_id, [changeOf('equipment', 'eq-gate-2', { ...unit, id: 'eq-gate-2' })]);
    const read = await db.as(company.owner).rows('select company_id, kind, id from public.records order by id');
    assert.deepEqual(read, [{ company_id: other.company_id, kind: 'equipment', id: 'eq-gate-2' }]);
  });

  it('the policies compare each row with an array worked out once per statement, and call no function on the row', async () => {
    for (const table of ['records', 'record_history']) {
      const [plan] = await db.as(company.owner).rows(`explain (format json, costs off) select * from public.${table}`);
      const text = JSON.stringify(plan['QUERY PLAN']);
      assert.doesNotMatch(text, /company_has_access|billing_standing|is_supervisor|is_member/, table);
      assert.match(text, /InitPlan/, table);
    }
  });

  it('company_has_access and billing_standing are for no API role; records_open_company_ids for a signed-in account', async () => {
    for (const session of [db.anon(), db.as(company.owner), db.serviceRole()]) {
      await refused(session.call('company_has_access', { p_company_id: company.id }), NO_PRIVILEGE, /permission denied for function company_has_access/);
      await refused(session.call('billing_standing', { p_company_id: company.id }), NO_PRIVILEGE, /permission denied for function billing_standing/);
    }
    await refused(db.anon().call('records_open_company_ids'), NO_PRIVILEGE, /permission denied/);
    assert.deepEqual(await db.noAccount().call('records_open_company_ids'), []);
    assert.deepEqual(await db.as(crew).call('records_open_company_ids'), [company.id]);
  });
});

// ---- The signing secret -----------------------------------------------------------------------------

describe('stripe_webhook_secret', () => {
  it('reads the secret the owner keeps in Vault, for the server key, and null when there is none', async () => {
    assert.equal(await db.serviceRole().call('stripe_webhook_secret'), null);
    await db.admin("insert into vault.decrypted_secrets (name, decrypted_secret) values ('another_secret', 'not this one')");
    assert.equal(await db.serviceRole().call('stripe_webhook_secret'), null);
    await db.admin("insert into vault.decrypted_secrets (name, decrypted_secret) values ('stripe_webhook_secret', '  whsec_test_madeup  ')");
    assert.equal(await db.serviceRole().call('stripe_webhook_secret'), 'whsec_test_madeup');
    await db.admin("update vault.decrypted_secrets set decrypted_secret = '' where name = 'stripe_webhook_secret'");
    assert.equal(await db.serviceRole().call('stripe_webhook_secret'), null);
    await db.admin("delete from vault.decrypted_secrets");
  });

  it('no API role reads Vault itself', async () => {
    for (const session of [db.anon(), db.as(a.owner), db.serviceRole()]) {
      await refused(session.query('select * from vault.decrypted_secrets'), NO_PRIVILEGE, /permission denied/);
    }
  });
});
