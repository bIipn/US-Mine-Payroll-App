import { describe, expect, it } from 'vitest';

import {
  accessOpens,
  afterCheckout,
  billingAnswer,
  billingWords,
  CHECK_FOR_MS,
  checkoutDone,
  checkoutLink,
  duplicateWarning,
  gate,
  nextView,
  portalLink,
  readBilling,
  recordsOpen,
  restartLink,
  startingTitle,
  stillCharged,
  trialLink,
  type Access,
  type Billing,
  type BillingView,
} from '../src/lib/billing';
import { BILLING_PORTAL, EARLY_ACCESS, RESTART_LINK, TRIAL_LINK } from '../src/lib/config';
import { asksForTrial, freshIntent, INTENT_FOR_MS } from '../src/lib/intent';

const COMPANY = '7f1c2a9e-3b4d-4c5e-8f60-112233445566';
const DEC_1 = Date.parse('2026-12-01T17:00:00Z');
const JAN_1 = Date.parse('2027-01-01T17:00:00Z');

const billing = (access: Access, more: Partial<Billing> = {}): Billing => ({
  access,
  status: null,
  trialEnd: null,
  periodEnd: null,
  cancelAtPeriodEnd: false,
  running: 0,
  hadTrial: false,
  ...more,
});
const known = (access: Access, more: Partial<Billing> = {}): BillingView => ({ kind: 'known', billing: billing(access, more) });

describe('who has the dashboard', () => {
  it('opens for a trial, a paid subscription, a charge Stripe is trying again, and a company let in by hand', () => {
    expect(accessOpens('trial')).toBe(true);
    expect(accessOpens('active')).toBe(true);
    expect(accessOpens('past_due')).toBe(true);
    expect(accessOpens('comped')).toBe(true);
  });

  it('is closed with no subscription and once one has ended', () => {
    expect(accessOpens('none')).toBe(false);
    expect(accessOpens('ended')).toBe(false);
  });
});

describe('the gate on the supervisor pages', () => {
  const pages = ['/', '/roster', '/records', '/exams/x1', '/defects', '/requests', '/payroll', '/exports'];

  it('lets every page open while the company has access', () => {
    for (const access of ['trial', 'active', 'past_due', 'comped'] as const) {
      for (const page of pages) expect(gate(known(access), page)).toBe('in');
    }
  });

  it('shows the start panel with no subscription, and the restart panel once one has ended', () => {
    for (const page of pages) {
      expect(gate(known('none'), page)).toBe('start');
      expect(gate(known('ended', { status: 'canceled' }), page)).toBe('restart');
    }
  });

  it('always opens Billing itself', () => {
    for (const view of [known('none'), known('ended'), { kind: 'checking' } as const, { kind: 'missing' } as const]) {
      expect(gate(view, '/billing')).toBe('in');
    }
  });

  it('waits for the first answer, and lets the supervisor in without one only when the server has no billing yet', () => {
    expect(gate({ kind: 'checking' }, '/')).toBe('wait');
    // The server has no billing yet: never shut a company out because the server is behind.
    expect(gate({ kind: 'missing' }, '/')).toBe('in');
  });

  it('does not open a page on a check that failed: offline, too slow, or an answer of the wrong shape', () => {
    for (const code of ['offline', 'timeout', 'shape', '42501']) {
      expect(gate({ kind: 'failed', message: 'x', code }, '/roster')).toBe('unknown');
      expect(gate({ kind: 'failed', message: 'x', code }, '/billing')).toBe('in');
    }
  });
});

describe('the records wait for billing', () => {
  it('load once the company is in, or the server has no billing yet', () => {
    for (const access of ['trial', 'active', 'past_due', 'comped'] as const) expect(recordsOpen(known(access))).toBe(true);
    expect(recordsOpen({ kind: 'missing' })).toBe(true);
  });

  it('wait for the first answer, and are not asked for without access or after a check that failed', () => {
    expect(recordsOpen({ kind: 'checking' })).toBeNull();
    expect(recordsOpen(known('none'))).toBe(false);
    expect(recordsOpen(known('ended', { status: 'canceled' }))).toBe(false);
    expect(recordsOpen({ kind: 'failed', message: 'Could not reach the MineMuster server.', code: 'offline' })).toBe(false);
  });

  it('keep what billing said when a later check fails, so a page neither shuts nor opens on one lost request', () => {
    const failed: BillingView = { kind: 'failed', message: 'x', code: 'offline' };
    expect(nextView(known('active'), failed)).toEqual(known('active'));
    expect(nextView(known('ended'), failed)).toEqual(known('ended'));
    expect(nextView({ kind: 'missing' }, failed)).toEqual({ kind: 'missing' });
    // With nothing known yet, the failure shows.
    expect(nextView({ kind: 'checking' }, failed)).toEqual(failed);
    expect(nextView(failed, failed)).toEqual(failed);
    // A real answer always replaces what was known.
    expect(nextView(known('active'), known('ended'))).toEqual(known('ended'));
  });
});

describe('the answer from company_billing', () => {
  it('reads the server’s object, with Stripe’s times as dates', () => {
    expect(
      readBilling({ access: 'trial', status: 'trialing', trial_end: '2026-12-01T17:00:00+00:00', current_period_end: '2026-12-01T17:00:00+00:00', cancel_at_period_end: false }),
    ).toEqual({ access: 'trial', status: 'trialing', trialEnd: DEC_1, periodEnd: DEC_1, cancelAtPeriodEnd: false, running: 0, hadTrial: false });
    expect(readBilling({ access: 'trial', status: 'trialing', running: 2, had_trial: true })).toMatchObject({ running: 2, hadTrial: true });
    expect(readBilling({ access: 'none', status: null, trial_end: null, current_period_end: null, cancel_at_period_end: null })).toEqual(billing('none'));
    // A set-returning function comes back as a list of one.
    expect(readBilling([{ access: 'comped' }])).toEqual(billing('comped'));
  });

  it('turns down an answer that is not the shape the server gives', () => {
    expect(readBilling(null)).toBeNull();
    expect(readBilling('trial')).toBeNull();
    expect(readBilling({ access: 'free' })).toBeNull();
    expect(readBilling({ access: 'active', status: 7 })).toBeNull();
    expect(readBilling({ access: 'active', cancel_at_period_end: 'yes' })).toBeNull();
    expect(readBilling({ access: 'active', running: '2' })).toBeNull();
    expect(readBilling({ access: 'active', running: -1 })).toBeNull();
    expect(readBilling({ access: 'active', running: 1.5 })).toBeNull();
    expect(readBilling({ access: 'active', had_trial: 'yes' })).toBeNull();
  });

  it('keeps an answer whose date it cannot read, without the date', () => {
    expect(readBilling({ access: 'active', status: 'active', current_period_end: 'soon' })?.periodEnd).toBeNull();
  });

  it('knows a server that has no company_billing yet', () => {
    expect(billingAnswer({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.company_billing(p_company_id) in the schema cache' }, status: 404 })).toEqual({ kind: 'missing' });
    expect(billingAnswer({ data: null, error: { code: '42883', message: 'function public.company_billing(uuid) does not exist' } })).toEqual({ kind: 'missing' });
  });

  it('takes only PostgREST’s own word that there is no billing: a bare 404 is a failed check', () => {
    expect(billingAnswer({ data: null, error: { message: '' }, status: 404 })).toMatchObject({ kind: 'failed' });
    expect(billingAnswer({ data: null, error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 })).toMatchObject({ kind: 'failed' });
  });

  it('says what went wrong when the call fails, and keeps the code', () => {
    const turnedDown = billingAnswer({ data: null, error: { code: '42501', message: 'Only a supervisor can see billing.' }, status: 403 });
    expect(turnedDown).toMatchObject({ kind: 'failed', code: '42501' });
    // Not this company's supervisor: "No such company.", PT404 (HTTP 404) now, P0002 (HTTP 500) before migration 20261117000600.
    for (const [code, status] of [['PT404', 404], ['P0002', 500]] as const) {
      expect(billingAnswer({ data: null, error: { code, message: 'No such company.' }, status })).toMatchObject({
        kind: 'failed',
        code,
        message: expect.stringMatching(/^Checking billing did not work: it was not found/),
      });
    }
    const offline = billingAnswer({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    expect(offline).toEqual({ kind: 'failed', message: 'Could not reach the MineMuster server. Check this computer’s connection, then try again.', code: 'offline' });
    expect(billingAnswer({ data: null, error: { message: 'AbortError: signal is aborted without reason' } })).toMatchObject({ kind: 'failed', code: 'timeout' });
    expect(billingAnswer({ data: { access: 'gold' }, error: null, status: 200 })).toMatchObject({ kind: 'failed', code: 'shape' });
  });

  it('hands back what billing is when the call works', () => {
    expect(billingAnswer({ data: { access: 'active', status: 'active', current_period_end: '2027-01-01T17:00:00Z' }, error: null, status: 200 })).toEqual(
      known('active', { status: 'active', periodEnd: JAN_1 }),
    );
  });
});

describe('the addresses on Stripe', () => {
  it('opens the trial checkout for this company, with the email filled in, every value percent-encoded', () => {
    const href = trialLink(COMPANY, 'pat+office@sample-mining.example');
    expect(href).toBe(`${TRIAL_LINK}?client_reference_id=${COMPANY}&prefilled_email=pat%2Boffice%40sample-mining.example`);
    const read = new URL(href);
    expect(read.searchParams.get('client_reference_id')).toBe(COMPANY);
    expect(read.searchParams.get('prefilled_email')).toBe('pat+office@sample-mining.example');
  });

  it('never lets a value add a parameter of its own', () => {
    const href = trialLink('a&b=c', 'x y@z.example&client_reference_id=evil');
    const read = new URL(href);
    expect([...read.searchParams.keys()]).toEqual(['client_reference_id', 'prefilled_email']);
    expect(read.searchParams.get('client_reference_id')).toBe('a&b=c');
    expect(href).not.toContain('+');
    expect(href).toContain('x%20y%40z.example');
  });

  it('leaves the email off when there is none', () => {
    expect(trialLink(COMPANY, '  ')).toBe(`${TRIAL_LINK}?client_reference_id=${COMPANY}`);
    expect(portalLink('')).toBe(BILLING_PORTAL);
  });

  it('opens the billing portal’s sign-in with the email filled in', () => {
    expect(portalLink(' pat@sample-mining.example ')).toBe(`${BILLING_PORTAL}?prefilled_email=pat%40sample-mining.example`);
  });

  it('goes only to Stripe’s own addresses', () => {
    expect(new URL(trialLink(COMPANY, 'a@b.example')).origin).toBe('https://buy.stripe.com');
    expect(new URL(portalLink('a@b.example')).origin).toBe('https://billing.stripe.com');
  });
});

describe('one free trial for each company', () => {
  const NO_TRIAL = 'https://buy.stripe.com/test_no_trial_link';

  it('opens the trial the first time, and the payment link with no trial once the company has had it', () => {
    expect(checkoutLink(billing('none'), COMPANY, 'a@b.example', NO_TRIAL)).toBe(trialLink(COMPANY, 'a@b.example'));
    expect(checkoutLink(billing('ended', { status: 'canceled' }), COMPANY, 'a@b.example', NO_TRIAL)).toBe(trialLink(COMPANY, 'a@b.example'));
    const again = checkoutLink(billing('ended', { status: 'canceled', hadTrial: true }), COMPANY, 'pat+office@sample-mining.example', NO_TRIAL);
    expect(again).toBe(`${NO_TRIAL}?client_reference_id=${COMPANY}&prefilled_email=pat%2Boffice%40sample-mining.example`);
    expect(restartLink(COMPANY, '', NO_TRIAL)).toBe(`${NO_TRIAL}?client_reference_id=${COMPANY}`);
  });

  it('offers no checkout to a company that has had its trial while there is no link without one', () => {
    expect(checkoutLink(billing('ended', { status: 'canceled', hadTrial: true }), COMPANY, 'a@b.example', '')).toBeNull();
    expect(restartLink(COMPANY, 'a@b.example', '')).toBeNull();
    // The link the build has: empty until the lead makes it in Stripe, and then Stripe's own.
    if (RESTART_LINK) expect(new URL(RESTART_LINK).origin).toBe('https://buy.stripe.com');
  });

  it('says how to start again: the first trial, a first charge at checkout, or by writing to us', () => {
    const first = billingWords(billing('ended', { status: 'canceled' }), { restartLink: false });
    expect(first.start).toBe('restart');
    expect(first.lines[1]).toBe('Start it again on Stripe the same way as the first time: a card at checkout, a 14-day free trial, then $300 each month until the company cancels.');

    const charged = billingWords(billing('ended', { status: 'canceled', hadTrial: true }), { restartLink: true });
    expect(charged.start).toBe('restart');
    expect(charged.writeToUs).toBeFalsy();
    expect(charged.lines[1]).toBe('Start it again on Stripe. There is no second free trial: the card is charged $300 at checkout, then $300 each month until the company cancels.');

    const write = billingWords(billing('ended', { status: 'unpaid', hadTrial: true }), { restartLink: false });
    expect(write.start).toBeUndefined();
    expect(write.writeToUs).toBe(true);
    expect(write.lines[1]).toBe('To start it again, write to us at minemuster.com/contact. There is no second free trial.');
  });

  it('tells a company in a second trial that it does not open the dashboard, and when Stripe charges it', () => {
    const w = billingWords(billing('ended', { status: 'trialing', trialEnd: DEC_1, hadTrial: true, running: 1 }));
    expect(w.title).toBe('The free trial has been used');
    expect(w.lines).toEqual([
      'This company has had its 14-day free trial, so the trial started again does not open the dashboard.',
      'Stripe charges its card $300 on December 1, 2026, when that trial ends, and the dashboard opens then. Cancel it in Manage billing if it was started by mistake.',
    ]);
    expect(w.manage).toBe('manage');
    expect(w.start).toBeUndefined();
    expect(w.writeToUs).toBeFalsy();
  });
});

describe('after checkout', () => {
  it('says a first trial has started, or the subscription, and that the crew’s app is set up with the company', () => {
    expect(checkoutDone(billing('trial', { status: 'trialing', hadTrial: true })).title).toBe('Your 14-day free trial has started');
    expect(checkoutDone(billing('trial')).title).toBe('Your 14-day free trial has started');
    // Started again with no trial: its status has not come in, or it is active.
    expect(checkoutDone(billing('trial', { hadTrial: true })).title).toBe('Your subscription has started');
    expect(checkoutDone(billing('active', { status: 'active', hadTrial: true })).title).toBe('Your subscription has started');
    expect(checkoutDone(billing('trial')).body).toBe(
      'Every page of the dashboard is open. Put the crew on the Roster page. During early access we set up the crew’s app with you: write to us at minemuster.com/contact.',
    );
    expect(checkoutDone(billing('trial')).body).not.toMatch(/join code/);
    expect(EARLY_ACCESS).toMatch(/early access/);
  });

  it('says what is starting while it waits for Stripe', () => {
    expect(startingTitle({ kind: 'checking' })).toBe('Your trial is starting');
    expect(startingTitle(known('none'))).toBe('Your trial is starting');
    expect(startingTitle(known('ended', { status: 'canceled', hadTrial: true }))).toBe('Your subscription is starting');
  });
});

describe('more than one subscription running', () => {
  it('is said, with what to do, since each one is charged', () => {
    expect(duplicateWarning(billing('trial', { running: 1 }))).toBeNull();
    expect(duplicateWarning(billing('trial', { running: 0 }))).toBeNull();
    expect(duplicateWarning(billing('trial', { status: 'trialing', running: 2 }))).toBe(
      'This company has 2 subscriptions running and both are charged. Cancel one in Manage billing, or write to us.',
    );
    expect(duplicateWarning(billing('active', { status: 'active', running: 3 }))).toBe(
      'This company has 3 subscriptions running and each is charged. Cancel all but one in Manage billing, or write to us.',
    );
  });
});

describe('back from checkout', () => {
  const since = 1_000_000;

  it('is confirmed as soon as the server lets the company in', () => {
    expect(afterCheckout(known('trial'), since, since + 2000)).toBe('confirmed');
    expect(afterCheckout(known('active'), since, since + 2000)).toBe('confirmed');
  });

  it('keeps asking for about a minute, through a failed check too, then gives up', () => {
    expect(afterCheckout(known('none'), since, since + 3000)).toBe('waiting');
    expect(afterCheckout({ kind: 'failed', message: 'x' }, since, since + 30_000)).toBe('waiting');
    expect(afterCheckout({ kind: 'checking' }, since, since)).toBe('waiting');
    expect(afterCheckout(known('none'), since, since + CHECK_FOR_MS)).toBe('gave_up');
  });

  it('stops at once when the server has no billing to ask', () => {
    expect(afterCheckout({ kind: 'missing' }, since, since)).toBe('missing');
  });
});

describe('where billing stands, in words', () => {
  it('offers the trial with no subscription, and says what is charged and when', () => {
    const w = billingWords(billing('none'));
    expect(w.title).toBe('Start your 14-day free trial');
    expect(w.start).toBe('start');
    expect(w.manage).toBeUndefined();
    expect(w.lines.join(' ')).toBe(
      'MineMuster is $300 a month for the company, the whole crew included. Checkout takes a card on Stripe, and nothing is charged during the 14 days. ' +
        'When the trial ends, that card is charged $300, then $300 each month until the company cancels. Cancel before then and nothing is charged.',
    );
  });

  it('gives a trial’s end, and the first charge’s date and amount', () => {
    const w = billingWords(billing('trial', { status: 'trialing', trialEnd: DEC_1, periodEnd: DEC_1 }));
    expect(w.title).toBe('Free trial until December 1, 2026');
    expect(w.lines[0]).toBe('The first charge is $300 on December 1, 2026, to the card given at checkout, then $300 each month until the company cancels.');
    expect(w.manage).toBe('manage');
    expect(w.start).toBeUndefined();
  });

  it('says a cancelled trial charges nothing and when it closes', () => {
    const w = billingWords(billing('trial', { status: 'trialing', trialEnd: DEC_1, cancelAtPeriodEnd: true }));
    expect(w.title).toBe('Trial cancelled');
    expect(w.lines).toEqual(['MineMuster stays open until December 1, 2026, when the trial ends. Nothing is charged.']);
  });

  it('gives an active subscription’s next charge', () => {
    const w = billingWords(billing('active', { status: 'active', periodEnd: JAN_1 }));
    expect(w.title).toBe('Subscription active');
    expect(w.lines[0]).toBe('The next charge is $300 on January 1, 2027, to the card on file.');
    expect(w.lines[1]).toMatch(/Cancelling stops the next charge, and MineMuster stays open to the end of the month already paid for\.$/);
  });

  it('says a cancelled subscription stays open to the end of the period paid for', () => {
    const w = billingWords(billing('active', { status: 'active', periodEnd: JAN_1, cancelAtPeriodEnd: true }));
    expect(w.title).toBe('Subscription cancelled');
    expect(w.lines).toEqual(['MineMuster stays open until January 1, 2027, the end of the month already paid for. Nothing more is charged.']);
  });

  it('asks for a new card when a charge did not go through', () => {
    const w = billingWords(billing('past_due', { status: 'past_due' }));
    expect(w.title).toBe('The last charge did not go through');
    expect(w.manage).toBe('card');
    expect(w.tone).toBe('warn');
  });

  it('offers to start again once a subscription has ended, and says why it ended', () => {
    const cancelled = billingWords(billing('ended', { status: 'canceled', periodEnd: JAN_1 }));
    expect(cancelled.title).toBe('Subscription ended');
    expect(cancelled.lines[0]).toBe('It was cancelled, and the dashboard closed on January 1, 2027.');
    expect(cancelled.start).toBe('restart');
    expect(cancelled.manage).toBe('manage');
    expect(billingWords(billing('ended', { status: 'unpaid' })).title).toBe('Subscription stopped');
    expect(billingWords(billing('ended', { status: 'incomplete_expired' })).title).toBe('The subscription did not start');
    expect(billingWords(billing('ended')).manage).toBeUndefined();
  });

  it('charges nothing for a company let in by hand, and shows no charges for it', () => {
    const w = billingWords(billing('comped'));
    expect(w.title).toBe('No charge for this company');
    expect(w.start).toBeUndefined();
    expect(w.manage).toBeUndefined();
    expect(w.terms).toBe(false);
    // An old subscription that has ended charges nothing either.
    expect(billingWords(billing('comped', { status: 'canceled' })).lines[0]).toMatch(/Nothing is charged/);
  });

  it('never tells a company let in by hand that nothing is charged while a subscription is still running', () => {
    for (const status of ['trialing', 'active', 'past_due']) {
      const b = billing('comped', { status, running: 1 });
      expect(stillCharged(b)).toBe(true);
      const w = billingWords(b);
      const text = w.lines.join(' ');
      expect(text).toBe('Your company is let in by arrangement, but a Stripe subscription is still running and will be charged. Cancel it in Manage billing.');
      expect(text).not.toMatch(/without a subscription|Nothing is charged/);
      expect(w.manage).toBe('manage');
      expect(w.terms).toBe(true);
    }
    // A server that does not count them yet: the status says so.
    expect(stillCharged(billing('comped', { status: 'active' }))).toBe(true);
    // Cancelled at the end of the period: no further charge.
    expect(stillCharged(billing('comped', { status: 'active', cancelAtPeriodEnd: true }))).toBe(false);
  });

  it('shows what is charged under every state but a company that pays nothing', () => {
    for (const a of ['none', 'trial', 'active', 'past_due', 'ended'] as const) expect(billingWords(billing(a)).terms).toBe(true);
  });

  it('never promises what MineMuster does not do', () => {
    const all = (['none', 'trial', 'active', 'past_due', 'comped', 'ended'] as const).flatMap((a) => {
      const w = billingWords(billing(a, { status: 'x', trialEnd: DEC_1, periodEnd: JAN_1 }));
      return [w.title, ...w.lines];
    });
    for (const text of all) {
      expect(text).not.toMatch(/refund|discount|year|annual|compliant|certified|approved|tax/i);
      // Oxide red is for a Bad Order, a red tag or a danger: billing words never take that tone.
    }
    for (const a of ['none', 'trial', 'active', 'past_due', 'comped', 'ended'] as const) {
      expect(['ok', 'info', 'warn']).toContain(billingWords(billing(a)).tone);
    }
  });
});

describe('a trial asked for on the website', () => {
  it('is read from ?start=trial and nothing else', () => {
    expect(asksForTrial('?start=trial')).toBe(true);
    expect(asksForTrial('?code=abc&start=trial')).toBe(true);
    expect(asksForTrial('?start=trials')).toBe(false);
    expect(asksForTrial('')).toBe(false);
  });

  it('is kept for a week at most', () => {
    const now = Date.parse('2026-11-17T18:00:00Z');
    expect(freshIntent(JSON.stringify({ trial: now - 1000 }), now)).toBe(true);
    expect(freshIntent(JSON.stringify({ trial: now - INTENT_FOR_MS }), now)).toBe(false);
    expect(freshIntent(JSON.stringify({ trial: now + 3_600_000 }), now)).toBe(false);
    expect(freshIntent(JSON.stringify({ trial: 'yes' }), now)).toBe(false);
    expect(freshIntent('not json', now)).toBe(false);
    expect(freshIntent(null, now)).toBe(false);
  });
});
