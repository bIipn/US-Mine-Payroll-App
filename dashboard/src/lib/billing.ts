import { BILLING_PORTAL, EARLY_ACCESS, RESTART_LINK, TRIAL_LINK } from './config';
import { dataProblem } from './errors';

/**
 * Billing, the rules. The server's `company_billing(p_company_id)` says where a
 * company's MineMuster subscription stands, from the Stripe events it has taken
 * in (supabase/migrations/20261117000500_billing.sql). This file reads that
 * answer, decides from it which pages open and whether the records load,
 * builds the Stripe addresses and puts each state into words. The screens only
 * show what it decides.
 *
 * The server holds the lock: it lets a supervisor read the company's records
 * only while the company has MineMuster. The dashboard follows the same answer
 * and loads no records until it says the company is in. It lets the supervisor
 * in without that answer only when the server has no billing at all yet (no
 * `company_billing`): a company is never shut out because the server is behind.
 * A check that fails is not a yes: the page says so and offers to check again.
 */

/** What MineMuster costs: one price for the company, the whole crew included. Prices are in US dollars. */
export const PRICE = '$300';
export const TRIAL_DAYS = 14;

/** Where a company stands, as `company_billing` puts it. */
export type Access = 'trial' | 'active' | 'past_due' | 'comped' | 'ended' | 'none';
const ACCESS: readonly Access[] = ['trial', 'active', 'past_due', 'comped', 'ended', 'none'];

export interface Billing {
  access: Access;
  /** Stripe's own status of the subscription the server goes by, or null when it has none. */
  status: string | null;
  /** When the trial ends, and with it when the first charge is made. */
  trialEnd: number | null;
  /** When the period already paid for (or the trial) runs out: the next charge, or the day access ends. */
  periodEnd: number | null;
  /** The company has cancelled: nothing more is charged, and access lasts to `periodEnd`. */
  cancelAtPeriodEnd: boolean;
  /** How many of the company's subscriptions Stripe will charge again. More than one is charged more than once. */
  running: number;
  /** The company has had its free trial: a new checkout gets none. */
  hadTrial: boolean;
}

export type BillingView =
  | { kind: 'checking' }
  | { kind: 'known'; billing: Billing }
  /** The server has no `company_billing` yet. */
  | { kind: 'missing' }
  /** The server did not answer, or not in a way this page knows. */
  | { kind: 'failed'; message: string; code?: string };

const when = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** The server's answer, or null when it is not the shape `company_billing` gives. */
export function readBilling(data: unknown): Billing | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.access !== 'string' || !ACCESS.includes(r.access as Access)) return null;
  if (r.status != null && typeof r.status !== 'string') return null;
  if (r.cancel_at_period_end != null && typeof r.cancel_at_period_end !== 'boolean') return null;
  if (r.running != null && !(typeof r.running === 'number' && Number.isInteger(r.running) && r.running >= 0)) return null;
  if (r.had_trial != null && typeof r.had_trial !== 'boolean') return null;
  return {
    access: r.access as Access,
    status: (r.status as string | null | undefined) || null,
    trialEnd: when(r.trial_end),
    periodEnd: when(r.current_period_end),
    cancelAtPeriodEnd: r.cancel_at_period_end === true,
    // A server from before these two were added says neither: nothing to warn of, and no trial known to be used.
    running: typeof r.running === 'number' ? r.running : 0,
    hadTrial: r.had_trial === true,
  };
}

interface Answer {
  data: unknown;
  error: { code?: unknown; message?: unknown } | null;
  status?: number;
}

/** A PostgREST answer to `company_billing`, as what the dashboard knows about billing. */
export function billingAnswer({ data, error }: Answer): BillingView {
  if (error) {
    const code = typeof error.code === 'string' ? error.code : '';
    const message = typeof error.message === 'string' ? error.message : '';
    // No such function: the billing migration is not on the server yet, or its schema cache is behind.
    // Only PostgREST's own word for it counts; any other failure is not taken as "no billing".
    if (code === 'PGRST202' || code === '42883') return { kind: 'missing' };
    if (/abort|timed? ?out/i.test(message) || code === '20') {
      return { kind: 'failed', message: 'The server took too long to say where billing stands.', code: 'timeout' };
    }
    const problem = dataProblem(error, 'Checking billing');
    return { kind: 'failed', message: problem.message, code: problem.code };
  }
  const billing = readBilling(data);
  if (!billing) {
    return {
      kind: 'failed',
      message: 'The server’s answer about billing is not one this page knows. Reload the page. If it keeps happening, tell whoever runs MineMuster for your company.',
      code: 'shape',
    };
  }
  return { kind: 'known', billing };
}

/**
 * What the page keeps after asking again. A check that fails once the page
 * already knows where billing stands keeps what it knew, so a page never shuts
 * (or opens) because one request did not get through; the failure shows only
 * while nothing is known yet.
 */
export function nextView(had: BillingView, answer: BillingView): BillingView {
  if (answer.kind === 'failed' && (had.kind === 'known' || had.kind === 'missing')) return had;
  return answer;
}

/** Whether a company in this state has the dashboard: in a trial, paid up, a charge being tried again, or let in by hand. */
export const accessOpens = (access: Access): boolean => access === 'trial' || access === 'active' || access === 'past_due' || access === 'comped';

/**
 * Whether the company's records may be loaded: yes once the server says the
 * company is in, or has no billing at all yet; not yet (null) while the first
 * check is under way; no otherwise, a failed check included. The server
 * refuses them anyway; this keeps the dashboard from asking.
 */
export function recordsOpen(view: BillingView): boolean | null {
  if (view.kind === 'checking') return null;
  if (view.kind === 'missing') return true;
  return view.kind === 'known' && accessOpens(view.billing.access);
}

/**
 * What a supervisor page shows: the page ('in'), a wait while billing is first
 * checked ('wait'), the panel to start the trial ('start') or to start the
 * subscription again ('restart'), or, when the check failed, a panel that says
 * so and checks again ('unknown'). Billing itself always opens, and so does
 * signing out, which is in the sidebar.
 */
export type Gate = 'in' | 'wait' | 'start' | 'restart' | 'unknown';

export function gate(view: BillingView, path: string): Gate {
  // Billing is how the company opens again, and anyone may delete their own account whatever it owes.
  if (path === '/billing' || path === '/account') return 'in';
  switch (view.kind) {
    case 'checking':
      return 'wait';
    case 'missing':
      return 'in';
    case 'failed':
      return 'unknown';
    case 'known':
      if (accessOpens(view.billing.access)) return 'in';
      return view.billing.access === 'ended' ? 'restart' : 'start';
  }
}

/**
 * The payment link that starts the trial, for this company and this person.
 * Stripe puts the company's id on the checkout (client_reference_id), which is
 * how the server ties the subscription to the company, and fills in the email.
 */
export function trialLink(companyId: string, email: string): string {
  return withCompany(TRIAL_LINK, companyId, email);
}

/** The payment link with no trial, for a company that has had its trial, or null while there is none (`RESTART_LINK`). */
export function restartLink(companyId: string, email: string, link: string = RESTART_LINK): string | null {
  return link ? withCompany(link, companyId, email) : null;
}

/** Where this company's checkout opens: the trial the first time, the link with no trial after. Null when there is none to offer. */
export function checkoutLink(b: Billing, companyId: string, email: string, link: string = RESTART_LINK): string | null {
  return b.hadTrial ? restartLink(companyId, email, link) : trialLink(companyId, email);
}

function withCompany(link: string, companyId: string, email: string): string {
  const url = new URL(link);
  url.searchParams.set('client_reference_id', companyId);
  if (email.trim()) url.searchParams.set('prefilled_email', email.trim());
  return toHref(url);
}

/** Stripe's billing portal, where the company changes its card, sees its invoices and cancels. */
export function portalLink(email: string): string {
  const url = new URL(BILLING_PORTAL);
  if (email.trim()) url.searchParams.set('prefilled_email', email.trim());
  return toHref(url);
}

/** URLSearchParams writes a space as "+", which Stripe could read as a plus; every value goes out percent-encoded instead. */
function toHref(url: URL): string {
  const query = [...url.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

// ---- After checkout ---------------------------------------------------------------------------

/** How often the page asks again once Stripe has sent the person back, and for how long. */
export const CHECK_EVERY_MS = 3000;
export const CHECK_FOR_MS = 60_000;

/**
 * Back from checkout: has the server heard from Stripe? 'confirmed' once the
 * company is in, 'missing' when the server has no billing to ask, 'gave_up'
 * after about a minute, and 'waiting' until then. A failed check is waited
 * out like a slow one.
 */
export function afterCheckout(view: BillingView, since: number, now: number): 'confirmed' | 'waiting' | 'gave_up' | 'missing' {
  if (view.kind === 'known' && accessOpens(view.billing.access)) return 'confirmed';
  if (view.kind === 'missing') return 'missing';
  return now - since >= CHECK_FOR_MS ? 'gave_up' : 'waiting';
}

/** What the page says once checkout has reached the server. */
export function checkoutDone(b: Billing): { title: string; body: string } {
  const trial = b.access === 'trial' && (b.status === 'trialing' || !b.hadTrial);
  return {
    title: trial ? `Your ${TRIAL_DAYS}-day free trial has started` : 'Your subscription has started',
    body: `Every page of the dashboard is open. Put the crew on the Roster page. ${EARLY_ACCESS}`,
  };
}

/** While the page waits for Stripe's word: a trial, or a subscription started again. */
export const startingTitle = (view: BillingView): string =>
  view.kind === 'known' && view.billing.hadTrial ? 'Your subscription is starting' : 'Your trial is starting';

// ---- In words ---------------------------------------------------------------------------------

/** December 1, 2026 */
export const fmtDay = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

export interface BillingWords {
  tone: 'ok' | 'info' | 'warn';
  title: string;
  lines: string[];
  /** The checkout to open: the first trial, or the subscription again. */
  start?: 'start' | 'restart';
  /** Stripe's billing portal: to manage the subscription, or to put a new card on it. */
  manage?: 'manage' | 'card';
  /** There is no checkout to offer: the company writes to us. */
  writeToUs?: boolean;
  /** Whether "What is charged" belongs under it: not for a company that pays nothing. */
  terms: boolean;
}

export const START_LABEL = { start: `Start your ${TRIAL_DAYS}-day free trial`, restart: 'Start the subscription again' } as const;
export const MANAGE_LABEL = { manage: 'Manage billing', card: 'Update the card' } as const;

const UNTIL_CANCELLED = `then ${PRICE} each month until the company cancels`;
const RUNNING = ['trialing', 'active', 'past_due'];

/** Whether Stripe will charge the company again: a subscription still running, not cancelled. */
export function stillCharged(b: Billing): boolean {
  return b.running > 0 || (!!b.status && RUNNING.includes(b.status) && !b.cancelAtPeriodEnd);
}

/** More than one subscription is running: the company is charged for each. */
export function duplicateWarning(b: Billing): string | null {
  if (b.running < 2) return null;
  return b.running === 2
    ? 'This company has 2 subscriptions running and both are charged. Cancel one in Manage billing, or write to us.'
    : `This company has ${b.running} subscriptions running and each is charged. Cancel all but one in Manage billing, or write to us.`;
}

/**
 * Where the company's billing stands, said plainly, with what to do next.
 * `restartLink` says whether there is a payment link with no trial to start
 * again on (`RESTART_LINK`).
 */
export function billingWords(b: Billing, { restartLink = !!RESTART_LINK }: { restartLink?: boolean } = {}): BillingWords {
  const hasSubscription = !!b.status;
  switch (b.access) {
    case 'none':
      return {
        tone: 'info',
        title: START_LABEL.start,
        lines: [
          `MineMuster is ${PRICE} a month for the company, the whole crew included. Checkout takes a card on Stripe, and nothing is charged during the ${TRIAL_DAYS} days.`,
          `When the trial ends, that card is charged ${PRICE}, ${UNTIL_CANCELLED}. Cancel before then and nothing is charged.`,
        ],
        start: 'start',
        terms: true,
      };
    case 'trial': {
      const end = b.trialEnd ?? b.periodEnd;
      if (b.cancelAtPeriodEnd) {
        return {
          tone: 'warn',
          title: 'Trial cancelled',
          lines: [end ? `MineMuster stays open until ${fmtDay(end)}, when the trial ends. Nothing is charged.` : 'MineMuster stays open until the trial ends. Nothing is charged.'],
          manage: 'manage',
          terms: true,
        };
      }
      return {
        tone: 'ok',
        title: end ? `Free trial until ${fmtDay(end)}` : 'Free trial',
        lines: [
          end
            ? `The first charge is ${PRICE} on ${fmtDay(end)}, to the card given at checkout, ${UNTIL_CANCELLED}.`
            : `When the ${TRIAL_DAYS} days are up, the card given at checkout is charged ${PRICE}, ${UNTIL_CANCELLED}.`,
          'Cancel before then in Manage billing and nothing is charged.',
        ],
        manage: 'manage',
        terms: true,
      };
    }
    case 'active':
      if (b.cancelAtPeriodEnd) {
        return {
          tone: 'warn',
          title: 'Subscription cancelled',
          lines: [
            b.periodEnd
              ? `MineMuster stays open until ${fmtDay(b.periodEnd)}, the end of the month already paid for. Nothing more is charged.`
              : 'MineMuster stays open to the end of the month already paid for. Nothing more is charged.',
          ],
          manage: 'manage',
          terms: true,
        };
      }
      return {
        tone: 'ok',
        title: 'Subscription active',
        lines: [
          b.periodEnd ? `The next charge is ${PRICE} on ${fmtDay(b.periodEnd)}, to the card on file.` : `The card on file is charged ${PRICE} each month.`,
          'It goes on each month until the company cancels. Cancelling stops the next charge, and MineMuster stays open to the end of the month already paid for.',
        ],
        manage: 'manage',
        terms: true,
      };
    case 'past_due':
      return {
        tone: 'warn',
        title: 'The last charge did not go through',
        lines: [`Stripe is trying the card again, and MineMuster stays open while it does. Update the card so the ${PRICE} goes through.`],
        manage: 'card',
        terms: true,
      };
    case 'comped':
      if (stillCharged(b)) {
        // Let in by hand, but a subscription started before that still runs, and Stripe still charges it.
        return {
          tone: 'warn',
          title: 'Let in by arrangement, with a subscription still running',
          lines: ['Your company is let in by arrangement, but a Stripe subscription is still running and will be charged. Cancel it in Manage billing.'],
          manage: 'manage',
          terms: true,
        };
      }
      return {
        tone: 'info',
        title: 'No charge for this company',
        lines: ['MineMuster is open for this company by arrangement, without a subscription. Nothing is charged to a card.'],
        manage: hasSubscription ? 'manage' : undefined,
        terms: false,
      };
    case 'ended':
      if (b.status === 'trialing') {
        // A second trial: the server does not count it, and Stripe charges it when it ends.
        const end = b.trialEnd ?? b.periodEnd;
        return {
          tone: 'warn',
          title: 'The free trial has been used',
          lines: [
            `This company has had its ${TRIAL_DAYS}-day free trial, so the trial started again does not open the dashboard.`,
            end
              ? `Stripe charges its card ${PRICE} on ${fmtDay(end)}, when that trial ends, and the dashboard opens then. Cancel it in Manage billing if it was started by mistake.`
              : `Stripe charges its card ${PRICE} when that trial ends, and the dashboard opens then. Cancel it in Manage billing if it was started by mistake.`,
          ],
          manage: 'manage',
          terms: true,
        };
      }
      return {
        tone: 'warn',
        title: endedTitle(b.status),
        lines: [endedWhy(b), restartWords(b, restartLink)],
        start: !b.hadTrial || restartLink ? 'restart' : undefined,
        writeToUs: b.hadTrial && !restartLink,
        manage: hasSubscription ? 'manage' : undefined,
        terms: true,
      };
  }
}

/** How a company whose subscription ended starts again: its first trial, a checkout with no trial, or by writing to us. */
function restartWords(b: Billing, restartLink: boolean): string {
  if (!b.hadTrial) return `Start it again on Stripe the same way as the first time: a card at checkout, a ${TRIAL_DAYS}-day free trial, ${UNTIL_CANCELLED}.`;
  if (restartLink) return `Start it again on Stripe. There is no second free trial: the card is charged ${PRICE} at checkout, ${UNTIL_CANCELLED}.`;
  return 'To start it again, write to us at minemuster.com/contact. There is no second free trial.';
}

function endedTitle(status: string | null): string {
  switch (status) {
    case 'paused':
      return 'Subscription paused';
    case 'unpaid':
      return 'Subscription stopped';
    case 'incomplete':
    case 'incomplete_expired':
      return 'The subscription did not start';
    default:
      return 'Subscription ended';
  }
}

function endedWhy(b: Billing): string {
  switch (b.status) {
    case 'canceled':
      return b.periodEnd ? `It was cancelled, and the dashboard closed on ${fmtDay(b.periodEnd)}.` : 'It was cancelled, so the dashboard is closed.';
    case 'unpaid':
      return 'The charges did not go through, so the subscription stopped and the dashboard is closed.';
    case 'paused':
      return 'Stripe paused it, so the dashboard is closed.';
    case 'incomplete':
    case 'incomplete_expired':
      return 'The first payment did not go through at checkout, so the dashboard is closed.';
    default:
      return 'The dashboard is closed until the subscription starts again.';
  }
}
