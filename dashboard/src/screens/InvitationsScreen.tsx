import { useState } from 'react';

import { fmtDateTime } from '@app/util/format';

import { acceptInvitation, myInvitations } from '../lib/api';
import type { OpenWhich } from '../lib/companies';
import { messageOf } from '../lib/errors';
import type { SupervisorInvitation } from '../lib/server';
import { Button, Notice } from '../ui/kit';
import { TopBand } from './NoCompanyScreen';

/** This account's invitations as the screen shows them: the list, or why it could not be read. */
export interface WaitingInvitations {
  list: SupervisorInvitation[];
  problem: string | null;
}

/** Ask for this account's invitations to supervise. It never throws: what went wrong is said on the screen. */
export async function readInvitations(): Promise<WaitingInvitations> {
  try {
    return { list: await myInvitations(), problem: null };
  } catch (e) {
    return { list: [], problem: messageOf(e) };
  }
}

/** Whether the invitations show before the companies: some are waiting, or they could not be read. */
export const invitationsFirst = (waiting: WaitingInvitations): boolean => waiting.list.length > 0 || waiting.problem !== null;

/**
 * Accept an invitation, then read the companies again and open the one it was for (`reopen` is App's own). A
 * refusal is thrown, worded for the person invited, and nothing is opened.
 */
export async function acceptAndOpen(invitation: SupervisorInvitation, email: string, reopen: (open: OpenWhich) => Promise<unknown>): Promise<void> {
  const accepted = await acceptInvitation(invitation, email);
  await reopen({ id: accepted.companyId, name: accepted.companyName });
}

/**
 * The invitations to supervise waiting for this account, shown after it signs in and before its companies.
 * Accepting one puts the account on the roster row it is for, as a supervisor, and opens that company. There is
 * nothing to decline on the server: an invitation left alone ends by itself, and the supervisor who sent it can
 * cancel it.
 */
export function InvitationsScreen({ email, waiting, onCompany, onRetry, onGoOn }: {
  email: string;
  waiting: WaitingInvitations;
  /** Read the account's companies again and open one: App's own. */
  onCompany: (open?: OpenWhich) => Promise<boolean>;
  onRetry: () => Promise<void>;
  /** On to the companies, leaving the invitations as they are. */
  onGoOn: () => void;
}) {
  const [accepting, setAccepting] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ id: string; words: string } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { list, problem } = waiting;

  const accept = async (invitation: SupervisorInvitation) => {
    if (accepting) return;
    setAccepting(invitation.id);
    setRefused(null);
    try {
      await acceptAndOpen(invitation, email, onCompany);
      onGoOn();
    } catch (e) {
      setRefused({ id: invitation.id, words: messageOf(e) });
      setAccepting(null);
    }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
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
              <p className="lede">Signed in as {email}. Accepting an invitation makes you a supervisor of the company, under the name on its roster, and opens it here.</p>
            </div>
          </div>
          {problem ? (
            <Notice tone="bo" title="Your invitations could not be loaded" live>
              <p>{problem}</p>
              <div className="row" style={{ marginTop: '0.5rem' }}>
                <Button kind="ink" small busy={retrying} onClick={() => void retry()}>Try again</Button>
              </div>
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
                  <Button kind="main" busy={accepting === invitation.id} onClick={() => void accept(invitation)}>Accept and open {invitation.company_name}</Button>
                </div>
              </section>
            );
          })}
          {list.length ? <p className="small muted">To turn an invitation down, leave it. It ends by itself when its time is up, and the supervisor who sent it can cancel it.</p> : null}
          <div className="row">
            <Button kind="quiet" onClick={onGoOn}>{list.length ? 'Go on without accepting' : 'Go on'}</Button>
          </div>
        </div>
      </main>
    </>
  );
}
