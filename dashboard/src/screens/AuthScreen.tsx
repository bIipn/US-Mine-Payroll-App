import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { sendPasswordReset, signIn, signUp } from '../lib/api';
import { authProblem, messageOf } from '../lib/errors';
import { supabase } from '../lib/supabase';
import { Button, Check, Notice, tabPanelProps, Tabs, TextField } from '../ui/kit';

/** The dark half of the first screens: MineMuster's logo, made for a dark background, and what this is. */
export function Gate({ children, title, say, tab }: { children: ReactNode; title: string; say: ReactNode; tab?: string }) {
  useEffect(() => {
    document.title = `${tab ?? title} – MineMuster`;
  }, [tab, title]);
  return (
    <div className="gate">
      <div className="gate-dark dark">
        <img className="gate-logo" src="/brand/minemuster-logo-800.webp" width={800} height={371} alt="MineMuster" />
        <div className="gate-say">
          <h1 className="h1">{title}</h1>
          {say}
        </div>
      </div>
      <main className="gate-light" id="main">
        {children}
      </main>
    </div>
  );
}

type Tab = 'in' | 'up' | 'reset';

/** `trial`: sent from the website to start a free trial, so the page opens on making an account and says what comes next. */
export function AuthScreen({ said: arrived = null, trial = false }: { said?: string | null; trial?: boolean } = {}) {
  const [tab, setTab] = useState<Tab>(trial ? 'up' : 'in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What is wrong with what was typed, beside the field it is wrong in.
  const [fieldError, setFieldError] = useState<{ email?: string; password?: string }>({});
  const [said, setSaid] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (fieldError.email) emailRef.current?.focus();
    else if (fieldError.password) passwordRef.current?.focus();
  }, [fieldError]);

  const switchTo = (next: Tab) => {
    setTab(next);
    setError(null);
    setFieldError({});
    setSaid(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaid(null);
    const wrong: { email?: string; password?: string } = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) wrong.email = 'Enter your email address, like name@company.com.';
    if (tab !== 'reset' && !password) wrong.password = 'Enter your password.';
    else if (tab === 'up' && password.length < 8) wrong.password = 'Use a password of at least 8 characters.';
    setFieldError(wrong);
    if (wrong.email || wrong.password) return;
    setBusy(true);
    try {
      if (tab === 'in') {
        await signIn(email, password);
      } else if (tab === 'up') {
        const { confirmFirst } = await signUp(email, password);
        if (confirmFirst) {
          setPassword('');
          setTab('in');
          // The same answer whether or not the email already has an account, so the page tells no one which do.
          setSaid('Check your email for a link to confirm, then sign in. If this email already has an account, sign in with it instead.');
        }
      } else {
        await sendPasswordReset(email);
        setSaid('If there is an account with this email, a link to set a new password is on its way. Open it in this browser.');
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Gate
      tab={tab === 'up' ? 'Create an account' : tab === 'reset' ? 'Set a new password' : 'Sign in'}
      title="The office side of MineMuster"
      say={
        <>
          <p>The crew’s equipment checklists, pre shift exams, maintenance requests and hours, as they arrive from their phones.</p>
          <p>For supervisors and the office. The crew keeps using the app on their phones.</p>
        </>
      }
    >
      <form className="gate-form" onSubmit={submit} noValidate aria-labelledby="auth-title">
        <h2 className={tab === 'reset' ? 'h2' : 'sr-only'} id="auth-title">{tab === 'up' ? 'Create an account' : tab === 'reset' ? 'Set a new password' : 'Sign in'}</h2>
        {tab !== 'reset' ? (
          <Tabs<Tab>
            label="Sign in or create an account"
            value={tab}
            onChange={switchTo}
            panelId="auth-panel"
            options={[{ value: 'in', label: 'Sign in' }, { value: 'up', label: 'Create an account' }]}
          />
        ) : null}
        <div className="stack" style={{ gap: '1.25rem' }} {...(tab !== 'reset' ? tabPanelProps('auth-panel', tab) : null)}>
        {arrived && !said && !error ? <Notice tone="warn" live>{arrived}</Notice> : null}
        {trial && !arrived && !said && tab !== 'reset' ? (
          <Notice tone="info" title="Start your 14-day free trial">
            {tab === 'up'
              ? 'Make an account and confirm your email. Then start your company, and the trial starts from its Billing page.'
              : 'Sign in, or make an account first. The trial starts from your company’s Billing page.'}
          </Notice>
        ) : null}
        {said ? <Notice tone="info" live>{said}</Notice> : null}
        <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" inputMode="email" required error={fieldError.email} inputRef={emailRef} />
        {tab !== 'reset' ? (
          <div className="stack" style={{ gap: '0.25rem' }}>
            <TextField
              label="Password"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={setPassword}
              autoComplete={tab === 'up' ? 'new-password' : 'current-password'}
              required
              hint={tab === 'up' ? 'At least 8 characters. It is kept by the sign-in service, never by this page.' : undefined}
              error={fieldError.password}
              inputRef={passwordRef}
            />
            <Check label="Show the password" checked={show} onChange={setShow} />
          </div>
        ) : (
          <p className="muted">We will email you a link. Open it in this browser to choose a new password.</p>
        )}
        {error ? <Notice tone="bo" live>{error}</Notice> : null}
        <Button kind="main" type="submit" block busy={busy}>
          {tab === 'in' ? 'Sign in' : tab === 'up' ? 'Create the account' : 'Email me a link'}
        </Button>
        {tab === 'in' ? (
          <Button kind="quiet" onClick={() => switchTo('reset')}>Forgot your password?</Button>
        ) : tab === 'reset' ? (
          <Button kind="quiet" onClick={() => switchTo('in')}>Back to sign in</Button>
        ) : (
          <p className="small muted">After you confirm your email, you start your company here or join one with the code a supervisor gives you.</p>
        )}
        </div>
      </form>
    </Gate>
  );
}

export function NewPasswordScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [short, setShort] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShort(password.length < 8);
    if (password.length < 8) return;
    setBusy(true);
    setError(null);
    const { error: problem } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (problem) return setError(authProblem(problem).message);
    onDone();
  };
  return (
    <Gate title="Choose a new password" say={<p>Then you are signed in.</p>}>
      <form className="gate-form" onSubmit={submit} noValidate>
        <h2 className="h2">Set a new password</h2>
        <TextField label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters." error={short ? 'Use a password of at least 8 characters.' : null} />
        {error ? <Notice tone="bo" live>{error}</Notice> : null}
        <Button kind="main" type="submit" block busy={busy}>Save the new password</Button>
      </form>
    </Gate>
  );
}
