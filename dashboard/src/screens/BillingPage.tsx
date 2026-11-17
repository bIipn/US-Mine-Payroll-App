import { useEffect, useRef, useState } from 'react';

import { fmtTime } from '@app/util/format';

import {
  accessOpens,
  afterCheckout,
  billingWords,
  CHECK_EVERY_MS,
  checkoutDone,
  checkoutLink,
  duplicateWarning,
  MANAGE_LABEL,
  portalLink,
  PRICE,
  START_LABEL,
  startingTitle,
  TRIAL_DAYS,
  type Billing,
} from '../lib/billing';
import { useBilling } from '../lib/billingState';
import { CONTACT_PAGE, RESTART_LINK } from '../lib/config';
import { useCompany } from '../lib/company';
import { remember } from '../lib/picked';
import { go, onLink } from '../lib/router';
import { Button, Notice } from '../ui/kit';
import { PageHead } from './Shell';

/**
 * The company's MineMuster subscription, for its supervisors: where it stands,
 * what is charged, and the two ways to Stripe. Starting the trial is a plain
 * link to Stripe's checkout in this tab; Stripe sends the person back here
 * with ?started=, and the page asks the server until Stripe's word has reached it.
 */
export function BillingPage({ email, started }: { email: string; started: string | null }) {
  const ctx = useCompany();
  const { view, check } = useBilling();
  const name = ctx.shaped.company.name || ctx.choice.name;
  // Said once checkout is confirmed, after ?started= has been taken off the address: where billing stood then.
  const [confirmed, setConfirmed] = useState<Billing | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const again = async () => {
    setChecking(true);
    try {
      await check();
      setCheckedAt(Date.now());
    } finally {
      setChecking(false);
    }
  };

  const done = confirmed ? checkoutDone(confirmed) : null;
  // "What is charged" is for a company that pays: not one let in by hand with nothing charged.
  const showTerms = view.kind !== 'known' || billingWords(view.billing).terms;

  return (
    // One column: every notice, the panel and the terms end at the same edge.
    <div className="billing-page">
      <PageHead title="Billing" lede={`${name}’s MineMuster subscription, through Stripe. Only the company’s supervisors see this page.`} actions={false} />

      {started && !confirmed ? (
        <AfterCheckout
          onConfirmed={(billing) => {
            setConfirmed(billing);
            // Asked once; a reload need not ask again.
            go('/billing', { replace: true });
          }}
        />
      ) : null}
      {done ? (
        <Notice tone="ok" live title={done.title}>
          {done.body}
        </Notice>
      ) : null}

      {view.kind === 'checking' ? (
        <p className="muted" role="status">Checking where billing stands.</p>
      ) : view.kind === 'missing' ? (
        <div className="notice notice-info notice-line">
          <p className="notice-title">Billing is not set up on the server yet.</p>
          <p className="small">Every page stays open until it is. The trial can be started here once it is.</p>
        </div>
      ) : view.kind === 'failed' ? (
        <Notice tone="warn" title="Where billing stands could not be checked">
          <p>{view.message} The other pages open once it can be checked.{checkedAt ? ` Checked at ${fmtTime(checkedAt)}.` : ''}</p>
          <div className="row" style={{ marginTop: '0.6rem' }}>
            <Button kind="line" busy={checking} onClick={() => void again()}>{checking ? 'Checking' : 'Check again'}</Button>
          </div>
        </Notice>
      ) : started && !confirmed && !accessOpens(view.billing.access) ? null : (
        // Back from checkout and still waiting on Stripe's word: no second checkout is offered meanwhile.
        <StatusPanel billing={view.billing} email={email} />
      )}

      {showTerms ? <Terms /> : null}
    </div>
  );
}

/** The panel with where billing stands and what to do: on Billing, and on every page while the dashboard is closed. */
export function StatusPanel({ billing, email, gated }: { billing: Billing; email: string; gated?: boolean }) {
  const ctx = useCompany();
  const words = billingWords(billing);
  const companyId = ctx.choice.id;
  // The trial the first time; once the company has had it, the payment link with no trial.
  const checkout = words.start ? checkoutLink(billing, companyId, email) : null;
  const twice = duplicateWarning(billing);
  const main = checkout || words.writeToUs ? 'start' : words.manage === 'card' ? 'card' : null;
  return (
    // On a closed page the page's own heading is the title, so the panel does not say it twice.
    <section className={`panel billing-panel billing-${words.tone}`} aria-labelledby={gated ? undefined : 'billing-state'} aria-label={gated ? 'Billing' : undefined}>
      <div className="stack" style={{ gap: '0.45rem' }}>
        {gated ? null : <h2 className="h2" id="billing-state">{words.title}</h2>}
        {twice ? (
          <div className="notice notice-warn" role="note">
            <p className="notice-title">Charged more than once</p>
            <p>{twice}</p>
          </div>
        ) : null}
        {words.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {gated ? (
          <p className="muted">
            {words.start === 'restart' ? 'The dashboard’s pages open again once it has started.' : 'The dashboard’s pages open once the trial has started.'}{' '}
            <a href="/billing" onClick={onLink}>See what is charged</a>.
          </p>
        ) : null}
      </div>
      <div className="row">
        {checkout && words.start ? (
          // A link, not a call: Stripe's checkout opens in this tab and sends the person back to /billing.
          <a className="btn btn-main" href={checkout} onClick={() => remember(companyId)}>
            {START_LABEL[words.start]}
          </a>
        ) : null}
        {words.writeToUs ? (
          <a className="btn btn-main" href={CONTACT_PAGE} target="_blank" rel="noopener noreferrer">
            Write to us
            <span className="sr-only"> (opens minemuster.com in a new tab)</span>
          </a>
        ) : null}
        {words.manage ? (
          <a className={main === 'card' ? 'btn btn-main' : 'btn btn-line'} href={portalLink(email)} target="_blank" rel="noopener noreferrer">
            {MANAGE_LABEL[words.manage]}
            <span className="sr-only"> (opens Stripe in a new tab)</span>
          </a>
        ) : null}
      </div>
      {checkout ? (
        <p className="small muted">Checkout opens on Stripe{email ? ` with ${email} filled in` : ''}. The card is entered on Stripe’s page, not here.</p>
      ) : words.writeToUs ? (
        <p className="small muted">Opens the contact form on minemuster.com in a new tab.</p>
      ) : words.manage ? (
        <p className="small muted">Opens Stripe’s billing page in a new tab, to change the card, see invoices or cancel. Stripe checks the email the subscription was started with first.</p>
      ) : null}
    </section>
  );
}

/** Back from checkout: ask every few seconds, for about a minute, until the server has heard from Stripe. */
function AfterCheckout({ onConfirmed }: { onConfirmed: (billing: Billing) => void }) {
  const { view, check } = useBilling();
  const since = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const stage = afterCheckout(view, since.current, now);
  const done = useRef(onConfirmed);
  done.current = onConfirmed;

  useEffect(() => {
    let live = true;
    let timer = 0;
    const tick = async () => {
      const answer = await check();
      if (!live) return;
      const at = Date.now();
      setNow(at);
      if (afterCheckout(answer, since.current, at) === 'waiting') timer = window.setTimeout(() => void tick(), CHECK_EVERY_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [check]);

  useEffect(() => {
    if (stage === 'confirmed' && view.kind === 'known') done.current(view.billing);
  }, [stage, view]);

  if (stage === 'confirmed' || stage === 'missing') return null;
  if (stage === 'waiting') {
    return (
      <div className="notice notice-info" role="status">
        <p className="notice-title">{startingTitle(view)}</p>
        <p>Stripe is telling MineMuster about the checkout. This page opens the rest of the dashboard as soon as it hears.</p>
        <div className="bar" aria-hidden="true" style={{ marginTop: '0.4rem' }}><span /></div>
      </div>
    );
  }
  return (
    <Notice tone="info" live title="Stripe has not told MineMuster yet">
      <p>It can take a moment after checkout. Check again in a minute.{askedAt ? ` Checked at ${fmtTime(askedAt)}.` : ''}</p>
      <p>Checkout has finished, so there is no need to start it again: it shows here once Stripe’s word arrives.</p>
      <div className="row" style={{ marginTop: '0.6rem' }}>
        <Button
          kind="ink"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const answer = await check();
              setAskedAt(Date.now());
              if (answer.kind === 'known' && accessOpens(answer.billing.access)) done.current(answer.billing);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Checking' : 'Check again'}
        </Button>
      </div>
    </Notice>
  );
}

/** What MineMuster costs and how the charge works, the same words as the website. */
function Terms() {
  return (
    <section className="section" aria-labelledby="terms-title">
      <h2 className="h2" id="terms-title">What is charged</h2>
      <dl className="facts facts-terms">
        <div><dt>Price</dt><dd>{PRICE} a month for the company</dd></div>
        <div><dt>The crew</dt><dd>Everyone on the roster, with no charge per person</dd></div>
        <div><dt>Free trial</dt><dd>{TRIAL_DAYS} days, once for each company, with a card taken at checkout</dd></div>
        <div><dt>When the trial ends</dt><dd>That card is charged {PRICE}, then {PRICE} each month</dd></div>
        <div><dt>Until</dt><dd>The company cancels, any time, in Stripe’s billing portal (Manage billing, once the trial has started)</dd></div>
        <div>
          <dt>Starting again</dt>
          <dd>{RESTART_LINK ? `There is no second free trial: the first ${PRICE} is charged at checkout` : 'There is no second free trial: write to us to start the subscription again'}</dd>
        </div>
        <div><dt>Cancelling</dt><dd>Stops the next charge. The dashboard stays open to the end of the period already paid for.</dd></div>
      </dl>
      <p className="section-note">
        Everything is included: equipment checklists, pre shift exams, maintenance requests, the time clock and payroll hours, this office dashboard, the PDF for an MSHA inspector and the exports. Prices are in US dollars.
      </p>
      <p className="section-note">The card is kept by Stripe. MineMuster’s server keeps whether the subscription is on, and its dates.</p>
    </section>
  );
}
