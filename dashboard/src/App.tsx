import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { myCompanies, signOut } from './lib/api';
import { afterAuthEvent, companiesView, loadCompanies, openingAuth, readInvitations, setInvitedSession, type Auth, type LinkTrouble, type WaitingInvitations } from './lib/arrival';
import { BillingProvider } from './lib/billingState';
import type { OpenWhich } from './lib/companies';
import { CompanyProvider } from './lib/company';
import { messageOf } from './lib/errors';
import { wantsTrial } from './lib/intent';
import { remember, remembered } from './lib/picked';
import { useLocation } from './lib/router';
import type { CompanyChoice } from './lib/server';
import { arrivedWith, supabase, takeInviteTokens, tidyAddress } from './lib/supabase';
import { AccountScreen, deletedWords } from './screens/AccountPage';
import { AuthScreen, LinkTroubleScreen, NewPasswordScreen } from './screens/AuthScreen';
import { EmployeeScreen } from './screens/EmployeeScreen';
import { InvitationsNotice, InvitationsScreen } from './screens/InvitationsScreen';
import { NoCompanyScreen } from './screens/NoCompanyScreen';
import { Shell } from './screens/Shell';
import { Boundary } from './ui/boundary';
import { Button, Loading, Notice } from './ui/kit';

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });
  const [linkSaid, setLinkSaid] = useState<string | null>(null);
  // Sent here once an account was deleted: the sign-in page says so, until someone signs in.
  const [farewell, setFarewell] = useState(() => deletedWords(window.location.search));
  // The session an invite email's link brought, being set: once, though React runs the effect below twice while developing.
  const inviting = useRef<Promise<LinkTrouble | null> | null>(null);

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
    return <NewPasswordScreen invitedAs={auth.session.user.email ?? ''} onDone={() => setAuth({ state: 'in', session: auth.session, invited: true })} />;
  }
  if (auth.state === 'kept') {
    // A link signed nobody in, and this browser stays signed in to an account: said first, naming it.
    return <LinkTroubleScreen trouble={auth.trouble} email={auth.session.user.email ?? ''} onGoOn={() => setAuth({ state: 'in', session: auth.session })} />;
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
      <Companies key={auth.session.user.id} session={auth.session} invited={!!auth.invited} />
    </Boundary>
  );
}

/** A signed-in account: its invitations to supervise first when companiesView says so, then its companies. */
function Companies({ session, invited }: { session: Session; invited: boolean }) {
  const { path } = useLocation();
  const [list, setList] = useState<CompanyChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(remembered);
  // The invitations to supervise waiting for this account, asked after every sign-in, until the person accepts one or goes on.
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
  const pick = (id: string) => {
    setPicked(id);
    remember(id);
  };
  const notice = (problem: string | null) => (problem ? <InvitationsNotice problem={problem} onRetry={askInvitations} /> : null);

  const view = companiesView({ error, list, invitations, goneOn, invited, path, picked });
  switch (view.show) {
    case 'failed':
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
    case 'loading':
      return <Loading>Finding your companies</Loading>;
    case 'invitations':
      return <InvitationsScreen email={email} waiting={view.waiting} invited={invited} companies={view.companies} onCompany={load} onRetry={askInvitations} onGoOn={() => setGoneOn(true)} />;
    case 'account':
      return <AccountScreen email={email} openCompany={view.open} onPick={view.open ? pick : undefined} />;
    case 'no_company':
      return <NoCompanyScreen email={email} onCompany={load} notice={notice(view.problem)} />;
    case 'crew':
      return <EmployeeScreen email={email} choice={view.choice} companies={view.companies} onPick={pick} notice={notice(view.problem)} />;
    case 'company':
      // Billing is asked alongside the records, so the gate is ready by the time they are.
      return (
        <BillingProvider key={view.choice.id} companyId={view.choice.id} recheckRole={recheckRole}>
          <CompanyProvider
            key={view.choice.id}
            choice={view.choice}
            me={session.user.id}
            recheckRole={recheckRole}
            loading={(progress) => <Loading>{progress}</Loading>}
            failed={(message, retry) => (
              <main className="loading">
                <div className="stack" style={{ maxWidth: '34rem', padding: '1rem' }}>
                  <Notice tone="bo" title={`${view.choice.name} could not be loaded`}>{message}</Notice>
                  <div className="row">
                    <Button kind="ink" onClick={retry}>Try again</Button>
                    <Button kind="quiet" onClick={() => void signOut()}>Sign out</Button>
                  </div>
                </div>
              </main>
            )}
          >
            <Shell email={email} companies={view.companies} onPick={pick} notice={notice(view.problem)} />
          </CompanyProvider>
        </BillingProvider>
      );
  }
}
