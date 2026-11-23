import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { myCompanies, signOut } from './lib/api';
import { BillingProvider } from './lib/billingState';
import { companyToOpen, type OpenWhich } from './lib/companies';
import { CompanyProvider } from './lib/company';
import { authProblem, messageOf } from './lib/errors';
import { clearTrialIntent, wantsTrial } from './lib/intent';
import { remember, remembered } from './lib/picked';
import { go, useLocation } from './lib/router';
import type { CompanyChoice } from './lib/server';
import { arrivedWith, supabase, takeInviteTokens, tidyAddress, type Arrival, type InviteTokens } from './lib/supabase';
import { AccountScreen, deletedWords } from './screens/AccountPage';
import { AuthScreen, NewPasswordScreen } from './screens/AuthScreen';
import { EmployeeScreen } from './screens/EmployeeScreen';
import { invitationsFirst, InvitationsScreen, readInvitations, type WaitingInvitations } from './screens/InvitationsScreen';
import { NoCompanyScreen } from './screens/NoCompanyScreen';
import { Shell } from './screens/Shell';
import { Boundary } from './ui/boundary';
import { Button, Loading, Notice } from './ui/kit';

export type Auth =
  /** `invitation`: the session an invite email's link brought is being set. */
  | { state: 'checking'; invitation?: boolean }
  | { state: 'out' }
  | { state: 'in'; session: Session }
  | { state: 'recovery'; session: Session }
  /** Signed in by an invite email's link: a password first, then the invitations (ruling R31). */
  | { state: 'invited'; session: Session };

/** An invite email's link that signed nobody in: it has run out or was used already, or something else went wrong. */
const INVITE_LINK_EXPIRED =
  'That invitation link has expired or was already used. Ask the supervisor who invited you to send it again. If you used it already, sign in below, or choose a password with Forgot your password.';
const INVITE_LINK_FAILED = 'That invitation link did not sign you in. Ask the supervisor who invited you to send it again, or sign in below if you already chose a password.';

/**
 * What to say about a link from an email that did not sign anyone in:
 * one that has run out or was used already, or one opened in another browser
 * than the one that asked for it, which holds the other half of its code. An
 * invitation is sent again by the supervisor who sent it, not from this page.
 */
export function linkProblem(signedIn: boolean, arrival: Arrival = arrivedWith): string | null {
  if (arrival.error) {
    const expired = arrival.error === 'otp_expired' || /expired|invalid/i.test(arrival.errorText ?? '');
    if (arrival.invited) return expired ? INVITE_LINK_EXPIRED : INVITE_LINK_FAILED;
    return expired
      ? 'That link has expired or was already used. Sign in, or ask for a new link with Forgot your password.'
      : 'That link did not sign you in. Sign in, or ask for a new link with Forgot your password.';
  }
  if (arrival.code && !signedIn) {
    return 'That link could not sign you in on this browser. If it was to confirm your email, your email is confirmed: sign in below. If it was to set a new password, ask for a new link with Forgot your password, and open it in this browser.';
  }
  return null;
}

/**
 * What to say when the session an invite email's link brought could not be set. The link itself is used up by
 * then, so the way in is a password of the person's own, or the invitation sent again.
 */
export function invitedSessionProblem(error: unknown): string {
  const next = 'a password with Forgot your password, then sign in to see the invitation. If no email comes, ask the supervisor who invited you to send it again.';
  return authProblem(error).code === 'offline'
    ? `Could not reach the MineMuster server, so the invitation link did not sign you in. Check this computer’s connection, then choose ${next}`
    : `The invitation link did not sign you in on this browser. Choose ${next}`;
}

/**
 * What the page shows once Supabase Auth says the session changed. While the session an invite email's link
 * brought is being set, what Auth says is of the session it replaces, or of none: the invitation's own answer
 * decides (openingAuth), and Auth's first word (INITIAL_SESSION), should it come after that, is of the same. A
 * password a link asked for, a reset's or an invitation's first, stays asked for until it is saved (USER_UPDATED).
 */
export function afterAuthEvent(had: Auth, event: AuthChangeEvent, session: Session | null): Auth {
  if ((had.state === 'checking' && had.invitation) || (had.state === 'invited' && event === 'INITIAL_SESSION')) return had;
  if (event === 'PASSWORD_RECOVERY' && session) return { state: 'recovery', session };
  if (!session) return { state: 'out' };
  if ((had.state === 'recovery' || had.state === 'invited') && event !== 'USER_UPDATED') return had;
  return { state: 'in', session };
}

/** Set the session an invite email's link brought. The answer is null once it is set, or what to say when it was not. */
async function setInvitedSession(tokens: InviteTokens): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.setSession(tokens);
    return !error && data.session ? null : invitedSessionProblem(error);
  } catch (e) {
    return invitedSessionProblem(e);
  }
}

/**
 * How the page opens: on the session an invite email's link brought, once it is set, or else on the one this
 * browser keeps, with what to say about a link that signed nobody in.
 */
async function openingAuth(invitation: Promise<string | null> | null): Promise<{ auth: Auth; said: string | null }> {
  const problem = invitation ? await invitation : null;
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  const kept: Auth = session ? { state: 'in', session } : { state: 'out' };
  if (!invitation) return { auth: kept, said: linkProblem(!!session) };
  if (!problem && session?.user.email) return { auth: { state: 'invited', session }, said: null };
  if (!problem && session) {
    // An invitation is to an email address, which its first screen names: a session with none is not one.
    await signOut();
    return { auth: { state: 'out' }, said: INVITE_LINK_FAILED };
  }
  return { auth: kept, said: problem ?? INVITE_LINK_FAILED };
}

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });
  const [linkSaid, setLinkSaid] = useState<string | null>(null);
  // Sent here once an account was deleted: the sign-in page says so, until someone signs in.
  const [farewell, setFarewell] = useState(() => deletedWords(window.location.search));
  // The session an invite email's link brought, being set: once, though React runs the effect below twice while developing.
  const inviting = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    let live = true;
    const tokens = takeInviteTokens();
    if (tokens) inviting.current = setInvitedSession(tokens);
    const invitation = inviting.current;
    if (invitation) setAuth({ state: 'checking', invitation: true });
    void openingAuth(invitation).then(({ auth: opened, said }) => {
      if (!live) return;
      setLinkSaid(said);
      if (arrivedWith.error || arrivedWith.code || arrivedWith.invited || farewell) tidyAddress();
      setAuth(opened);
    });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) setFarewell(null);
      setAuth((had) => afterAuthEvent(had, event, session));
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, []);

  if (auth.state === 'checking') return <Loading>Opening MineMuster</Loading>;
  if (auth.state === 'out') return <AuthScreen said={linkSaid} done={farewell} trial={wantsTrial()} />;
  if (auth.state === 'recovery') return <NewPasswordScreen onDone={() => setAuth({ state: 'in', session: auth.session })} />;
  if (auth.state === 'invited') {
    // Signed in by an invite email's link: its first screen names the address, with a way out (ruling R31).
    return <NewPasswordScreen invitedAs={auth.session.user.email ?? ''} onDone={() => setAuth({ state: 'in', session: auth.session })} />;
  }
  return (
    <Boundary
      fallback={() => (
        <main className="loading" id="main">
          <div className="stack" style={{ maxWidth: '34rem', padding: '1rem' }}>
            <Notice tone="bo" title="MineMuster could not show this company">
              Something in its records is not the shape the app writes, so the dashboard stopped. Reload the page. If it keeps happening, tell whoever runs MineMuster for your company.
            </Notice>
            <div className="row">
              <Button kind="ink" onClick={() => window.location.reload()}>Reload the page</Button>
              <Button kind="quiet" onClick={() => void signOut()}>Sign out</Button>
            </div>
          </div>
        </main>
      )}
    >
      <Companies key={auth.session.user.id} session={auth.session} />
    </Boundary>
  );
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

function Companies({ session }: { session: Session }) {
  const { path } = useLocation();
  const [list, setList] = useState<CompanyChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(remembered);
  // The invitations to supervise waiting for this account: asked after every sign-in, and shown before the
  // companies until the person accepts one or goes on without.
  const [invitations, setInvitations] = useState<WaitingInvitations | null>(null);
  const [goneOn, setGoneOn] = useState(false);

  /** Load the account's companies again, and open the one asked for. Says whether the account is in any company now. */
  const load = useCallback(async (open?: OpenWhich): Promise<boolean> => {
    setError(null);
    try {
      const { companies, picked: id } = await loadCompanies(open);
      if (id) setPicked(id);
      setList(companies);
      return companies.length > 0;
    } catch (e) {
      setError(messageOf(e));
      return false;
    }
  }, []);

  /**
   * The account's role, asked again while a company is open. A supervisor made
   * crew, or taken off, no longer gets the supervisor's pages or the records on
   * them. A check that cannot reach the server changes nothing.
   */
  const recheckRole = useCallback(async () => {
    try {
      setList(await myCompanies());
    } catch {
      // The next call that works asks again.
    }
  }, []);

  const askInvitations = useCallback(async () => setInvitations(await readInvitations()), []);

  useEffect(() => {
    void load();
    void askInvitations();
  }, [load, askInvitations]);

  const email = session.user.email ?? '';

  if (error) {
    return (
      <main className="loading">
        <div className="stack" style={{ maxWidth: '34rem', padding: '1rem' }}>
          <Notice tone="bo" title="Your companies could not be loaded">{error}</Notice>
          <div className="row">
            <Button kind="ink" onClick={() => void load()}>Try again</Button>
            <Button kind="quiet" onClick={() => void signOut()}>Sign out</Button>
          </div>
        </div>
      </main>
    );
  }
  if (!list || !invitations) return <Loading>Finding your companies</Loading>;
  if (!goneOn && invitationsFirst(invitations)) {
    return <InvitationsScreen email={email} waiting={invitations} onCompany={load} onRetry={askInvitations} onGoOn={() => setGoneOn(true)} />;
  }
  // Your account is anyone's: for an account in no company, and for the crew, it is a page of its own.
  if (list.length === 0) return path === '/account' ? <AccountScreen email={email} openCompany={null} /> : <NoCompanyScreen email={email} onCompany={load} />;

  const choice = list.find((c) => c.id === picked) ?? list[0];
  const pick = (id: string) => {
    setPicked(id);
    remember(id);
  };

  if (choice.role !== 'supervisor') {
    if (path === '/account') return <AccountScreen email={email} openCompany={choice.id} onPick={pick} />;
    return <EmployeeScreen email={email} choice={choice} companies={list} onPick={pick} />;
  }

  // Billing is asked alongside the records, so the gate is ready by the time they are.
  return (
    <BillingProvider key={choice.id} companyId={choice.id} recheckRole={recheckRole}>
      <CompanyProvider
        key={choice.id}
        choice={choice}
        me={session.user.id}
        recheckRole={recheckRole}
        loading={(progress) => <Loading>{progress}</Loading>}
        failed={(message, retry) => (
          <main className="loading">
            <div className="stack" style={{ maxWidth: '34rem', padding: '1rem' }}>
              <Notice tone="bo" title={`${choice.name} could not be loaded`}>{message}</Notice>
              <div className="row">
                <Button kind="ink" onClick={retry}>Try again</Button>
                <Button kind="quiet" onClick={() => void signOut()}>Sign out</Button>
              </div>
            </div>
          </main>
        )}
      >
        <Shell email={email} companies={list} onPick={pick} />
      </CompanyProvider>
    </BillingProvider>
  );
}
