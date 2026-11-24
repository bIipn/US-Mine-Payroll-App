// Stripe's events and the contact form when two requests overlap, acted out
// on a real PostgreSQL server (see server.mjs; skipped without one). PGlite is
// one session and cannot overlap two transactions, so these are the only tests
// that show, at READ COMMITTED as PostgREST runs:
//
//  * the same Stripe event delivered twice at once is applied once: the second
//    waits for the first, then finds it in stripe_events;
//  * two events for one subscription at once keep the newer one, whichever
//    commits first;
//  * two contact messages at once cannot both slip under a limit: the second
//    waits for the first, then counts it.
//
// All names and ids are made up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { skipWithoutServer, startServerDatabase } from './server.mjs';

let db;
before(async () => {
  if (!skipWithoutServer) db = await startServerDatabase();
});
after(async () => {
  await db?.drop();
});

const T0 = 1795000000;
let made = 0;
const next = (prefix) => `${prefix}_race${(made += 1)}`;
const APPLY = 'select public.apply_stripe_event(p_event => $1::jsonb) as result';

function subscriptionEvent(subscription, { status, created, id = next('evt') }) {
  return {
    id,
    type: 'customer.subscription.updated',
    created,
    livemode: true,
    data: { object: { id: subscription, status, customer: 'cus_race', cancel_at_period_end: false, metadata: { app: 'minemuster' }, items: { data: [{ current_period_end: created + 30 * 86400 }] } } },
  };
}

/** The server key's request, in a transaction of its own. */
const asServer = () => db.request(null, 'read committed', 'service_role');

async function statusOf(subscription) {
  const [row] = await db.adminRows('select status, event_at from public.billing_subscriptions where subscription_id = $1', [subscription]);
  return row;
}

describe('the same Stripe event delivered twice at once', { skip: skipWithoutServer }, () => {
  it('is applied once: the second waits, then answers duplicate', async () => {
    const sub = next('sub');
    const event = JSON.stringify(subscriptionEvent(sub, { status: 'trialing', created: T0 }));
    const first = await asServer();
    const [{ result: one }] = (await first.query(APPLY, [event])).rows;
    assert.equal(one.applied, true);
    const second = await asServer();
    const { settled } = await second.start(APPLY, [event]);
    const [{ waiting }] = await db.adminRows("select count(*)::int as waiting from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [second.pid]);
    assert.equal(waiting, 1, 'the second delivery waits for the first');
    await first.commit();
    const outcome = await settled;
    assert.equal(outcome.ok, true, outcome.message);
    assert.deepEqual(outcome.rows[0].result, { applied: false, reason: 'duplicate' });
    await second.commit();
    const [{ n }] = await db.adminRows('select count(*)::int as n from public.stripe_events where id = $1', [JSON.parse(event).id]);
    assert.equal(n, 1);
    await first.end();
    await second.end();
  });

  it('is applied by the second when the first rolls back, as when its answer to Stripe failed', async () => {
    const sub = next('sub');
    const event = JSON.stringify(subscriptionEvent(sub, { status: 'active', created: T0 }));
    const first = await asServer();
    await first.query(APPLY, [event]);
    const second = await asServer();
    const { settled } = await second.start(APPLY, [event]);
    await first.rollback();
    const outcome = await settled;
    assert.equal(outcome.rows[0].result.applied, true);
    await second.commit();
    assert.equal((await statusOf(sub)).status, 'active');
    await first.end();
    await second.end();
  });
});

describe('two events for one subscription at once', { skip: skipWithoutServer }, () => {
  for (const order of ['newer first', 'older first']) {
    it(`keep the newer one (${order})`, async () => {
      const sub = next('sub');
      await (async () => {
        const setUp = await asServer();
        await setUp.query(APPLY, [JSON.stringify(subscriptionEvent(sub, { status: 'trialing', created: T0 }))]);
        await setUp.commit();
        await setUp.end();
      })();
      const newer = JSON.stringify(subscriptionEvent(sub, { status: 'past_due', created: T0 + 40 * 86400 }));
      const older = JSON.stringify(subscriptionEvent(sub, { status: 'active', created: T0 + 14 * 86400 }));
      const [firstEvent, secondEvent] = order === 'newer first' ? [newer, older] : [older, newer];

      const first = await asServer();
      await first.query(APPLY, [firstEvent]);
      const second = await asServer();
      const { settled } = await second.start(APPLY, [secondEvent]);
      const [{ waiting }] = await db.adminRows("select count(*)::int as waiting from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [second.pid]);
      assert.equal(waiting, 1, 'the second waits for the subscription');
      await first.commit();
      const outcome = await settled;
      assert.equal(outcome.ok, true, outcome.message);
      assert.deepEqual(outcome.rows[0].result.applied, order === 'older first');
      if (order === 'newer first') assert.equal(outcome.rows[0].result.reason, 'stale');
      await second.commit();
      const kept = await statusOf(sub);
      assert.equal(kept.status, 'past_due');
      assert.equal(Date.parse(kept.event_at) / 1000, T0 + 40 * 86400);
      await first.end();
      await second.end();
    });
  }
});

describe('two contact messages at once', { skip: skipWithoutServer }, () => {
  it('cannot both slip under the limit for one address', async () => {
    const email = `${next('pat')}@example.test`;
    const SEND = "select public.submit_contact_request(p_name => 'Pat Cole', p_company => null, p_email => $1, p_phone => null, p_message => 'Hello', p_website => '') as result";
    for (let i = 0; i < 2; i += 1) {
      const setUp = await db.request(null, 'read committed', 'anon');
      await setUp.query(SEND, [email]);
      await setUp.commit();
      await setUp.end();
    }
    const first = await db.request(null, 'read committed', 'anon');
    assert.deepEqual((await first.query(SEND, [email])).rows[0].result, { ok: true });
    const second = await db.request(null, 'read committed', 'anon');
    const { settled } = await second.start(SEND, [email]);
    await first.commit();
    const outcome = await settled;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'PT429');
    await second.rollback();
    const [{ n }] = await db.adminRows('select count(*)::int as n from public.contact_requests where email = $1', [email]);
    assert.equal(n, 3);
    await first.end();
    await second.end();
  });
});
