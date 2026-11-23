import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

import { acceptInvitation, myCompanies, myInvitations, signOut } from './api';
import { companyToOpen, type OpenWhich } from './companies';
import { authProblem, messageOf } from './errors';
import { clearTrialIntent, wantsTrial } from './intent';
import { remember, remembered } from './picked';
import { go } from './router';
import type { CompanyChoice, SupervisorInvitation } from './server';
import { arrivedWith, supabase, type Arrival, type InviteTokens } from './supabase';

/**
 * How the dashboard opens, and what it shows first: the session an invite email's link brought (ruling R31), or
 * the one this browser keeps; what a link that signed nobody in says, and where; what Supabase Auth's events
 * change; and, once signed in, whether the invitations to supervise come before the companies. App draws what
 * these say.
 */

export type Auth =
  /** `invitation`: the session an invite email's link brought is being set. */
  | { state: 'checking'; invitation?: boolean }
  | { state: 'out' }
  /** `invited`: the account came in by an invite email's link, through its password screen. */
  | { state: 'in'; session: Session; invited?: boolean }
  | { state: 'recovery'; session: Session }
  /** Signed in by an invite email's link: a password first, then the invitations. */
  | { state: 'invited'; session: Session }
  /** A link signed nobody in, and this browser stays signed in to an account: what went wrong shows first. */
  | { state: 'kept'; session: Session; trouble: LinkTrouble };

/** Why an invite email's link, or a session in the address, signed nobody in. */
export type LinkTrouble =
  /** The invite link ran out, or was used already. */
  | { kind: 'invite_expired' }
  /** The invite link came back with another error, or with a session that is no invitation's. */
  | { kind: 'invite_failed' }
  /** The session the invite link brought could not be set. */
  | { kind: 'invite_not_set'; offline: boolean }
  /** A session in the address that is not an invitation's: taken off the address, and not taken (readArrival). */
  | { kind: 'refused' };

const expired = (arrival: Arrival) => arrival.error === 'otp_expired' || /expired|invalid/i.test(arrival.errorText ?? '');

/** What went wrong with the address's invite link or session, or null when nothing did. */
function troubleOf(arrival: Arrival): LinkTrouble | null {
  if (arrival.invited && arrival.error) return { kind: expired(arrival) ? 'invite_expired' : 'invite_failed' };
  if (arrival.refused) return { kind: 'refused' };
  return null;
}

/** A link's trouble as the sign-in page says it, with what to do there. */
function troubleOut(trouble: LinkTrouble): string {
  switch (trouble.kind) {
    case 'invite_expired':
      return 'That invitation link has expired or was already used. Ask the supervisor who invited you to send it again. If you used it already, sign in below, or choose a password with Forgot your password.';
    case 'invite_failed':
      return 'That invitation link did not sign you in. Ask the supervisor who invited you to send it again. If you already chose a password, sign in below.';
    case 'invite_not_set':
      // The link is used up by then: the way in is a password of the person's own, or the invitation sent again.
      return trouble.offline
        ? 'Could not reach the MineMuster server, so the invitation link did not sign you in. Check this computer’s connection, then choose a password with Forgot your password and sign in to see the invitation. If no email comes, ask the supervisor who invited you to send it again.'
        : 'The invitation link did not sign you in on this browser. Choose a password with Forgot your password, then sign in to see the invitation. If no email comes, ask the supervisor who invited you to send it again.';
    case 'refused':
      return 'That link did not sign you in. Sign in below, choosing a password first with Forgot your password if you have none. If the link was an invitation, it shows once you are signed in, or ask the supervisor who invited you to send it again.';
  }
}

/** Under the heading of a link's trouble, for a browser that stays signed in: what went wrong, and about the invitation. */
function whyKept(trouble: LinkTrouble): string {
  switch (trouble.kind) {
    case 'invite_expired':
      return 'It has expired or was already used. Ask the supervisor who invited you to send it again.';
    case 'invite_failed':
      return 'Ask the supervisor who invited you to send it again.';
    case 'invite_not_set':
      return trouble.offline ? 'The MineMuster server could not be reached. Check this computer’s connection.' : 'It could not finish signing you in on this browser.';
    case 'refused':
      return 'If it was an invitation, ask the supervisor who invited you to send it again.';
  }
}

/** A link's trouble as said to a browser that stays signed in to an account, which it names. */
export function troubleKept(trouble: LinkTrouble, email: string): { title: string; why: string; next: string } {
  return {
    title: trouble.kind === 'refused' ? 'That link did not sign you in' : 'That invitation link did not sign you in',
    why: whyKept(trouble),
    next: `This browser is still signed in to that account. If the link was sent to ${email}, go on: an invitation sent there shows next. If not, sign out, then sign in with your own email, choosing a password first with Forgot your password if you have none.`,
  };
}

/**
 * What the sign-in page says about a link from a sign-in email that did not sign anyone in: one that has run out
 * or was used already, or one opened in another browser than the one that asked for it, which holds the other
 * half of its code.
 */
function linkProblem(signedIn: boolean, arrival: Arrival): string | null {
  if (arrival.error) {
    return expired(arrival)
      ? 'That link has expired or was already used. Sign in, or ask for a new link with Forgot your password.'
      : 'That link did not sign you in. Sign in, or ask for a new link with Forgot your password.';
  }
  if (arrival.code && !signedIn) {
    return 'That link could not sign you in on this browser. If it was to confirm your email, your email is confirmed: sign in below. If it was to set a new password, ask for a new link with Forgot your password, and open it in this browser.';
  }
  return null;
}

/**
 * What the page shows once Supabase Auth says the session changed. While the session an invite email's link
 * brought is being set, what Auth says is of the session it replaces, or of none: the invitation's own answer
 * decides (openingAuth), and Auth's first word (INITIAL_SESSION), should it come once a link's screen is up, is
 * of the same. A screen a link put first stays while the session is that screen's account's, whatever another
 * tab does: a password it asks for until it is saved (USER_UPDATED), and a link's trouble until the person goes
 * on. Another account signed in, from another tab, is followed. An account that came in by an invite link is
 * known to have, until it signs out or another account signs in.
 */
export function afterAuthEvent(had: Auth, event: AuthChangeEvent, session: Session | null): Auth {
  if (had.state === 'checking' && had.invitation) return had;
  if (event === 'INITIAL_SESSION' && (had.state === 'invited' || had.state === 'recovery' || had.state === 'kept')) return had;
  if (event === 'PASSWORD_RECOVERY' && session) return { state: 'recovery', session };
  if (!session) return { state: 'out' };
  const sameAccount = 'session' in had && had.session.user.id === session.user.id;
  if (sameAccount && (had.state === 'kept' || ((had.state === 'recovery' || had.state === 'invited') && event !== 'USER_UPDATED'))) return had;
  if (sameAccount && (had.state === 'invited' || (had.state === 'in' && had.invited))) return { state: 'in', session, invited: true };
  return { state: 'in', session };
}

/** Set the session an invite email's link brought. The answer is null once it is set, or why it was not. */
export async function setInvitedSession(tokens: InviteTokens): Promise<LinkTrouble | null> {
  const notSet = (error: unknown): LinkTrouble => ({ kind: 'invite_not_set', offline: authProblem(error).code === 'offline' });
  try {
    const { data, error } = await supabase.auth.setSession(tokens);
    return !error && data.session ? null : notSet(error);
  } catch (e) {
    return notSet(e);
  }
}

/**
 * How the page opens: on the session an invite email's link brought, once it is set (`invitation`, from
 * setInvitedSession), or else on the one this browser keeps. A link that signed nobody in says so first, even to a
 * browser that stays signed in to another account, which it names and never signs out (`kept`); signed out, the
 * sign-in page says it (`said`).
 */
export async function openingAuth(invitation: Promise<LinkTrouble | null> | null, arrival: Arrival = arrivedWith): Promise<{ auth: Auth; said: string | null }> {
  const notSet = invitation ? await invitation : null;
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (invitation && !notSet && session) {
    if (session.user.email) return { auth: { state: 'invited', session }, said: null };
    // An invitation is to an email address, which its first screen names: a session with none is not one.
    await signOut();
    return { auth: { state: 'out' }, said: troubleOut({ kind: 'invite_failed' }) };
  }
  const trouble: LinkTrouble | null = invitation ? (notSet ?? { kind: 'invite_failed' }) : troubleOf(arrival);
  if (trouble) return session ? { auth: { state: 'kept', session, trouble }, said: null } : { auth: { state: 'out' }, said: troubleOut(trouble) };
  return { auth: session ? { state: 'in', session } : { state: 'out' }, said: linkProblem(!!session, arrival) };
}

/**
 * Read the account's companies again, and the one to open: the one asked for, by id or by the name the server
 * gave (companyToOpen), which this browser then remembers.
 */
export async function loadCompanies(open?: OpenWhich): Promise<{ companies: CompanyChoice[]; picked?: string }> {
  const companies = await myCompanies();
  const id = companyToOpen(companies, open);
  if (id) remember(id);
  // Sent from the website to start a trial: once a company opens, it opens on Billing, for a supervisor.
  // The crew never sees billing, so for them the wish is simply spent.
  if (companies.length > 0 && wantsTrial()) {
    const opening = companies.find((c) => c.id === (id ?? remembered())) ?? companies[0];
    clearTrialIntent();
    if (opening.role === 'supervisor') go('/billing', { replace: true });
  }
  return { companies, picked: id };
}

/** This account's invitations to supervise as the page shows them: the list, or why it could not be read. */
export interface WaitingInvitations {
  list: SupervisorInvitation[];
  problem: string | null;
}

/** Ask for this account's invitations to supervise. It never throws: what went wrong is said on the page. */
export async function readInvitations(): Promise<WaitingInvitations> {
  try {
    return { list: await myInvitations(), problem: null };
  } catch (e) {
    return { list: [], problem: messageOf(e) };
  }
}

/**
 * Accept an invitation, then read the companies again and open the one it was for (`reopen` is App's own). A
 * refusal is thrown, worded for the person invited, and nothing is opened.
 */
export async function acceptAndOpen(invitation: SupervisorInvitation, email: string, reopen: (open: OpenWhich) => Promise<unknown>): Promise<void> {
  const accepted = await acceptInvitation(invitation, email);
  await reopen({ id: accepted.companyId, name: accepted.companyName });
}

/** What a signed-in account sees: `problem` is why its invitations could not be read, said above its companies. */
export type CompaniesView =
  | { show: 'failed' }
  | { show: 'loading' }
  | { show: 'invitations'; waiting: WaitingInvitations; companies: CompanyChoice[] }
  | { show: 'account'; open: string | null }
  | { show: 'no_company'; problem: string | null }
  | { show: 'crew'; choice: CompanyChoice; companies: CompanyChoice[]; problem: string | null }
  | { show: 'company'; choice: CompanyChoice; companies: CompanyChoice[]; problem: string | null };

/**
 * What a signed-in account sees, once its companies and its invitations are read. The invitations come first
 * while any wait, and after an invite link even when none do, to say why, until the person accepts one or goes
 * on; never over Your account. Otherwise invitations that could not be read hold nobody up: the companies open,
 * with the trouble above them.
 */
export function companiesView(at: {
  error: string | null;
  list: CompanyChoice[] | null;
  invitations: WaitingInvitations | null;
  /** The person went on to the companies, or accepted an invitation. */
  goneOn: boolean;
  /** The account came in by an invite email's link. */
  invited: boolean;
  path: string;
  /** The company this browser opens. */
  picked: string | null;
}): CompaniesView {
  const { list, invitations } = at;
  if (at.error) return { show: 'failed' };
  if (!list || !invitations) return { show: 'loading' };
  if (!at.goneOn && at.path !== '/account' && (invitations.list.length > 0 || at.invited)) return { show: 'invitations', waiting: invitations, companies: list };
  // Your account is anyone's: for an account in no company, and for the crew, it is a page of its own.
  if (list.length === 0) return at.path === '/account' ? { show: 'account', open: null } : { show: 'no_company', problem: invitations.problem };
  const choice = list.find((c) => c.id === at.picked) ?? list[0];
  if (choice.role !== 'supervisor') return at.path === '/account' ? { show: 'account', open: choice.id } : { show: 'crew', choice, companies: list, problem: invitations.problem };
  return { show: 'company', choice, companies: list, problem: invitations.problem };
}
