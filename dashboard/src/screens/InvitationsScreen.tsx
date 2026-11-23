import { useState } from 'react';

import { fmtDateTime } from '@app/util/format';

import { acceptAndOpen, type WaitingInvitations } from '../lib/arrival';
import type { OpenWhich } from '../lib/companies';
import { messageOf } from '../lib/errors';
import type { CompanyChoice, SupervisorInvitation } from '../lib/server';
import { Button, Notice } from '../ui/kit';
import { TopBand } from './NoCompanyScreen';

/** Where going on leads: the account's company, its companies, or the page to start or join one. */
const goOnWords = (companies: CompanyChoice[]) =>
  companies.length === 0 ? 'Go on to start or join a company' : companies.length === 1 ? `Go on to ${companies[0].name}` : 'Go on to your companies';

/** The invitations could not be read: said with a way to ask again, here and above the companies. */
export function InvitationsNotice({ problem, onRetry }: { problem: string; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice tone="warn" title="Your invitations to supervise could not be checked" live>
      <p>{problem}</p>
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <Button kind="line" small busy={busy} onClick={() => void retry()}>Try again</Button>
      </div>
    </Notice>
  );
}

/**
 * The invitations to supervise waiting for this account, shown after it signs in and before its companies.
 * Accepting one puts the account on the roster row it is for, as a supervisor, and opens that company. There is
 * nothing to decline on the server: an invitation left alone ends by itself, and the supervisor who sent it can
 * cancel it. After an invite link with none left, it says that invitation is no longer open.
 */
export function InvitationsScreen({ email, waiting, invited, companies, onCompany, onAccepted, onRetry, onGoOn }: {
  email: string;
  waiting: WaitingInvitations;
  /** The account came in by an invite email's link. */
  invited: boolean;
  /** The account's companies, which going on opens. */
  companies: CompanyChoice[];
  /** Read the account's companies again and open one: App's own. */
  onCompany: (open?: OpenWhich) => Promise<boolean>;
  /** An invitation to this company was accepted: App finishes it once the company is open (AcceptedNotice). */
  onAccepted?: (companyId: string) => void;
  onRetry: () => Promise<void>;
  /** On to the companies, leaving the invitations as they are. */
  onGoOn: () => void;
}) {
  const [accepting, setAccepting] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ id: string; words: string } | null>(null);
  const { list, problem } = waiting;

  const accept = async (invitation: SupervisorInvitation) => {
    if (accepting) return;
    setAccepting(invitation.id);
    setRefused(null);
    try {
      const companyId = await acceptAndOpen(invitation, email, onCompany);
      onAccepted?.(companyId);
      onGoOn();
    } catch (e) {
      setRefused({ id: invitation.id, words: messageOf(e) });
      setAccepting(null);
    }
  };

  return (
    <>
      <TopBand email={email} />
      <main className="main" id="main">
        <div className="page" style={{ maxWidth: '44rem' }}>
          <div className="page-head">
            <div className="page-head-text">
              <h1 className="h1">{list.length === 1 ? 'An invitation to supervise' : 'Invitations to supervise'}</h1>
              {/* An address is one long word: it breaks where it must, not past the edge of a phone. */}
              <p className="lede" style={{ overflowWrap: 'anywhere' }}>
                Signed in as {email}.{list.length ? ' Accepting an invitation makes you a supervisor of the company, under the name on its roster, and opens it here.' : ''}
              </p>
            </div>
          </div>
          {problem ? <InvitationsNotice problem={problem} onRetry={onRetry} /> : null}
          {invited && !problem && list.length === 0 ? (
            <Notice tone="warn" title="The invitation you came from is no longer open">
              It was cancelled, the row it was for has changed, or the supervisor who sent it is no longer a supervisor there. Ask the supervisor who invited you to invite you again.
            </Notice>
          ) : null}
          {list.map((invitation) => {
            const until = Date.parse(invitation.expires_at);
            return (
              <section key={invitation.id} className="panel" aria-labelledby={`invitation-${invitation.id}`}>
                <h2 className="h2" id={`invitation-${invitation.id}`}>{invitation.company_name}</h2>
                <p>
                  On its roster as {invitation.first_name} {invitation.last_name}.{Number.isFinite(until) ? ` Good until ${fmtDateTime(until)}.` : ''}
                </p>
                {refused?.id === invitation.id ? <Notice tone="bo" live>{refused.words}</Notice> : null}
                <div className="row">
                  <Button kind="main" className="btn-wrap" busy={accepting === invitation.id} onClick={() => void accept(invitation)}>Accept and open {invitation.company_name}</Button>
                </div>
              </section>
            );
          })}
          {list.length ? <p className="small muted">To turn an invitation down, leave it. It ends by itself when its time is up, and the supervisor who sent it can cancel it.</p> : null}
          <div className="row">
            <Button kind={list.length ? 'quiet' : 'main'} className="btn-wrap" onClick={onGoOn}>{goOnWords(companies)}</Button>
          </div>
        </div>
      </main>
    </>
  );
}
