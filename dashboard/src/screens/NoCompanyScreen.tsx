import { useEffect, useState, type FormEvent } from 'react';

import { STATES, stateName } from '@app/domain/company';
import { cleanText } from '@app/domain/roster';
import { fmtTime } from '@app/util/format';

import { companyByCode, createCompany, joinCompany, myJoinRequests, signOut } from '../lib/api';
import type { OpenWhich } from '../lib/companies';
import { messageOf } from '../lib/errors';
import { wantsTrial } from '../lib/intent';
import { joinMessage, REQUEST_STATUS } from '../lib/joinStatus';
import { go } from '../lib/router';
import { REASON_TEXT } from '../lib/rosterTools';
import type { JoinResult, MyJoinRequest } from '../lib/server';
import { browserZone } from '../lib/timezone';
import { zoneChoices } from '../lib/zones';
import { Button, Ledger, Notice, SelectField, TextField } from '../ui/kit';

const STATE_OPTIONS = [{ value: '', label: 'Choose the state' }, ...Object.entries(STATES).sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];

/** A join code typed the forgiving way: capitals or not, with spaces or dashes anywhere. */
export const tidyCode = (text: string) => text.toUpperCase().replace(/[\s\-‐-―]/g, '');

export function TopBand({ email }: { email: string }) {
  return (
    <header className="dark" style={{ background: 'var(--ink)', color: 'var(--on-dark)' }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '0.9rem var(--gutter)' }}>
        <img src="/brand/minemuster-logo-800.webp" width={800} height={371} alt="MineMuster" style={{ width: '8.5rem' }} />
        <div className="row" style={{ gap: '0.5rem 1rem' }}>
          <span className="small" style={{ color: 'var(--on-dark-muted)', overflowWrap: 'anywhere' }}>{email}</span>
          <Button kind="ondark" small onClick={() => void signOut()}>Sign out</Button>
        </div>
      </div>
    </header>
  );
}

/** Load the account's companies again and open one. Resolves to whether the account is in a company now. */
type OnCompany = (open?: OpenWhich) => Promise<boolean>;

export function NoCompanyScreen({ email, onCompany }: { email: string; onCompany: OnCompany }) {
  const [requests, setRequests] = useState<MyJoinRequest[]>([]);
  const [trial] = useState(wantsTrial);
  useEffect(() => {
    myJoinRequests().then(setRequests).catch(() => setRequests([]));
  }, []);

  return (
    <>
      <TopBand email={email} />
      <main className="main" id="main">
        <div className="page">
          <div className="page-head">
            <div className="page-head-text">
              <h1 className="h1">Your company</h1>
              <p className="lede">This account is not part of a company yet. Start one if you run the crew, or join yours with the code a supervisor gave you.</p>
            </div>
          </div>
          {trial ? (
            <Notice tone="info" title="Start your 14-day free trial">
              Start your company first. Its Billing page opens next, and the trial starts there.
            </Notice>
          ) : null}
          <div className="choose">
            <StartCompany onCompany={onCompany} />
            <JoinWithCode onCompany={onCompany} onAsked={() => myJoinRequests().then(setRequests).catch(() => undefined)} />
          </div>
          {requests.length ? <MyRequests requests={requests} /> : null}
        </div>
      </main>
    </>
  );
}

function StartCompany({ onCompany }: { onCompany: OnCompany }) {
  const [name, setName] = useState('');
  const [state, setState] = useState('');
  const [zone, setZone] = useState(browserZone);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ companyId: string; joinCode: string } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!cleanText(name)) return setError('Give the company’s name, the way it is printed on the pay stub.');
    if (!STATES[state]) return setError('Choose the state the crew works in. Its hours rules are the ones the app follows.');
    if (!cleanText(first) || !cleanText(last)) return setError('Give your first and last name, the way the company writes them.');
    setBusy(true);
    try {
      setMade(await createCompany({ name: cleanText(name), state, timezone: zone, firstName: cleanText(first), lastName: cleanText(last), title: cleanText(title) }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    return (
      <section className="panel" aria-labelledby="start-title">
        <h2 className="h2" id="start-title">{cleanText(name)} is started</h2>
        <div className="code-show">
          <span className="small" style={{ color: 'var(--on-dark-muted)' }}>Join code</span>
          <span className="code">{made.joinCode.slice(0, 4)} {made.joinCode.slice(4)}</span>
          <p>Give this code to the crew. Each person types it in the MineMuster app with their name. Put them on the roster first, and they join by themselves; anyone else waits for you to let them in.</p>
        </div>
        <p>Next, start the 14-day free trial on the company’s Billing page. Then put the crew on the roster.</p>
        {/* A new company opens on Billing: the rest of the dashboard opens once its trial has started. */}
        <Button
          kind="main"
          onClick={() => {
            go('/billing', { replace: true });
            void onCompany({ id: made.companyId });
          }}
        >
          Open the company’s Billing page
        </Button>
      </section>
    );
  }

  return (
    <form className="panel" onSubmit={submit} noValidate aria-labelledby="start-title">
      <div className="stack" style={{ gap: '0.3rem' }}>
        <h2 className="h2" id="start-title">Start a company</h2>
        <p className="muted small">You become its first supervisor. Next you start the 14-day free trial, then add the rest of the crew.</p>
      </div>
      <TextField label="Company name" value={name} onChange={setName} autoComplete="organization" maxLength={120} />
      <div className="form-grid">
        <SelectField label="State" value={state} onChange={setState} options={STATE_OPTIONS} hint="Overtime and meal periods follow this state’s rules." />
        <SelectField label="Time zone" value={zone} onChange={setZone} options={zoneChoices()} hint="Days and pay periods are counted in it." />
      </div>
      <div className="form-grid">
        <TextField label="Your first name" value={first} onChange={setFirst} autoComplete="given-name" maxLength={100} />
        <TextField label="Your last name" value={last} onChange={setLast} autoComplete="family-name" maxLength={100} />
      </div>
      <TextField label="Your job title" value={title} onChange={setTitle} maxLength={100} hint="Optional. Safety manager, plant superintendent, and so on." />
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
      <Button kind="main" type="submit" busy={busy}>Start the company</Button>
    </form>
  );
}

function JoinWithCode({ onCompany, onAsked }: { onCompany: OnCompany; onAsked: () => void }) {
  const [code, setCode] = useState('');
  const [found, setFound] = useState<{ name: string; state: string } | null | undefined>(undefined);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);
  const [still, setStill] = useState<string | null>(null);

  const typed = tidyCode(code);
  useEffect(() => {
    setFound(undefined);
    if (typed.length !== 8) return;
    let live = true;
    companyByCode(typed).then((c) => live && setFound(c)).catch(() => live && setFound(undefined));
    return () => {
      live = false;
    };
  }, [typed]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setResult(null);
    setStill(null);
    if (typed.length !== 8) return setError('A join code is 8 letters and numbers. Type it the way the supervisor gave it.');
    if (!cleanText(first) || !cleanText(last)) return setError('Give your first and last name, the way they are on the roster.');
    setBusy(true);
    try {
      const answer = await joinCompany(typed, cleanText(first), cleanText(last));
      setResult(answer);
      onAsked();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const said = result ? joinMessage(result) : null;

  /** Load the account's companies again: in after joining, or after a supervisor let them in. */
  const openIt = async () => {
    setBusy(true);
    setStill(null);
    try {
      const inNow = await onCompany({ id: result?.company_id, name: result?.company_name });
      if (inNow) return;
      setStill(
        result?.status === 'pending'
          ? `Checked at ${fmtTime(Date.now())}: no supervisor has let you in yet.`
          : 'The company is not listed for this account yet. Reload the page in a minute.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit} noValidate aria-labelledby="join-title">
      <div className="stack" style={{ gap: '0.3rem' }}>
        <h2 className="h2" id="join-title">Join with a code</h2>
        <p className="muted small">Ask a supervisor for the code. It is 8 letters and numbers.</p>
      </div>
      <TextField
        label="Join code"
        value={code}
        onChange={setCode}
        className="input-code"
        autoComplete="off"
        maxLength={12}
        hint={found ? `Join ${found.name}, ${stateName(found.state) || found.state}?` : found === null ? 'No company has this code. Check it with a supervisor.' : 'Capitals or not, with or without the dash.'}
      />
      <div className="form-grid">
        <TextField label="Your first name" value={first} onChange={setFirst} autoComplete="given-name" maxLength={100} />
        <TextField label="Your last name" value={last} onChange={setLast} autoComplete="family-name" maxLength={100} />
      </div>
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
      {said && result ? (
        <Notice tone={said.tone} live>
          {said.text}
          {result.status === 'pending' && result.reason ? <p className="small" style={{ marginTop: '0.35rem' }}>{REASON_TEXT[result.reason]}</p> : null}
        </Notice>
      ) : null}
      {still ? <Notice tone="info" live>{still}</Notice> : null}
      {said?.open ? (
        <Button kind="main" busy={busy} onClick={() => void openIt()}>Open the company</Button>
      ) : result?.status === 'pending' ? (
        <Button kind="main" busy={busy} onClick={() => void openIt()}>Check again</Button>
      ) : (
        <Button kind="main" type="submit" busy={busy}>Ask to join</Button>
      )}
    </form>
  );
}

function MyRequests({ requests }: { requests: MyJoinRequest[] }) {
  const named = requests.some((r) => r.company_name);
  return (
    <section className="section" aria-labelledby="mine-title">
      <h2 className="h2" id="mine-title">Your requests to join</h2>
      <Ledger>
          <thead>
            <tr>
              {named ? <th scope="col">Company</th> : null}
              <th scope="col">Name you typed</th>
              <th scope="col">Where it stands</th>
              <th scope="col">Asked</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                {named ? <td>{r.company_name ?? ''}</td> : null}
                <th scope="row">{r.first_name} {r.last_name}</th>
                <td>{REQUEST_STATUS[r.status] ?? r.status}</td>
                <td className="nowrap">{new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
              </tr>
            ))}
          </tbody>
        </Ledger>
    </section>
  );
}
