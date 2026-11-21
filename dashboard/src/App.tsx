import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useState } from 'react';

import { myCompanies, signOut } from './lib/api';
import { BillingProvider } from './lib/billingState';
import { companyToOpen, type OpenWhich } from './lib/companies';
import { CompanyProvider } from './lib/company';
import { messageOf } from './lib/errors';
import { clearTrialIntent, wantsTrial } from './lib/intent';
import { remember, remembered } from './lib/picked';
import { go, useLocation } from './lib/router';
import type { CompanyChoice } from './lib/server';
import { arrivedWith, supabase, tidyAddress } from './lib/supabase';
import { AccountScreen, deletedWords } from './screens/AccountPage';
import { AuthScreen, NewPasswordScreen } from './screens/AuthScreen';
import { EmployeeScreen } from './screens/EmployeeScreen';
import { NoCompanyScreen } from './screens/NoCompanyScreen';
import { Shell } from './screens/Shell';
import { Boundary } from './ui/boundary';
import { Button, Loading, Notice } from './ui/kit';

type Auth = { state: 'checking' } | { state: 'out' } | { state: 'in'; session: Session } | { state: 'recovery'; session: Session };

/**
 * What to say about a link from a sign-in email that did not sign anyone in:
 * one that has run out or was used already, or one opened in another browser
 * than the one that asked for it, which holds the other half of its code.
 */
function linkProblem(signedIn: boolean): string | null {
  if (arrivedWith.error) {
    return arrivedWith.error === 'otp_expired' || /expired|invalid/i.test(arrivedWith.errorText ?? '')
      ? 'That link has expired or was already used. Sign in, or ask for a new link with Forgot your password.'
      : 'That link did not sign you in. Sign in, or ask for a new link with Forgot your password.';
  }
  if (arrivedWith.code && !signedIn) {
    return 'That link could not sign you in on this browser. If it was to confirm your email, your email is confirmed: sign in below. If it was to set a new password, ask for a new link with Forgot your password, and open it in this browser.';
  }
  return null;
}

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });
  const [linkSaid, setLinkSaid] = useState<string | null>(null);
  // Sent here once an account was deleted: the sign-in page says so, until someone signs in.
  const [farewell, setFarewell] = useState(() => deletedWords(window.location.search));

  useEffect(() => {
    let live = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!live) return;
      setLinkSaid(linkProblem(!!data.session));
      if (arrivedWith.error || arrivedWith.code || farewell) tidyAddress();
      setAuth(data.session ? { state: 'in', session: data.session } : { state: 'out' });
    });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) setFarewell(null);
      if (event === 'PASSWORD_RECOVERY' && session) setAuth({ state: 'recovery', session });
      else if (session) setAuth((had) => (had.state === 'recovery' && event !== 'USER_UPDATED' ? had : { state: 'in', session }));
      else setAuth({ state: 'out' });
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, []);

  if (auth.state === 'checking') return <Loading>Opening MineMuster</Loading>;
  if (auth.state === 'out') return <AuthScreen said={linkSaid} done={farewell} trial={wantsTrial()} />;
  if (auth.state === 'recovery') return <NewPasswordScreen onDone={() => setAuth({ state: 'in', session: auth.session })} />;
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

function Companies({ session }: { session: Session }) {
  const { path } = useLocation();
  const [list, setList] = useState<CompanyChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(remembered);

  /** Load the account's companies again, and open the one asked for. Says whether the account is in any company now. */
  const load = useCallback(async (open?: OpenWhich): Promise<boolean> => {
    setError(null);
    try {
      const companies = await myCompanies();
      const id = companyToOpen(companies, open);
      if (id) {
        setPicked(id);
        remember(id);
      }
      // Sent from the website to start a trial: once a company opens, it opens on Billing, for a supervisor.
      // The crew never sees billing, so for them the wish is simply spent.
      if (companies.length > 0 && wantsTrial()) {
        const opening = companies.find((c) => c.id === (id ?? remembered())) ?? companies[0];
        clearTrialIntent();
        if (opening.role === 'supervisor') go('/billing', { replace: true });
      }
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

  useEffect(() => {
    void load();
  }, [load]);

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
  if (!list) return <Loading>Finding your companies</Loading>;
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
