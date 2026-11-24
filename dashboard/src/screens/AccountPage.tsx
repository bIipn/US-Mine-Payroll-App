import { useEffect, useState } from 'react';

import type { DeletionAnswer, DeletionCheckCompany } from '@app/domain/accountDeletion';
import { deletionAnswerWords } from '@app/domain/serverAnswers';

import { accountPlan, deleteBody, namedAs, stepWords, type CompanyStep } from '../lib/accountPlan';
import { accountDeletionCheck, deleteMyAccount, signOut } from '../lib/api';
import { messageOf } from '../lib/errors';
import { go } from '../lib/router';
import { A, Button, Loading, Notice, TextField } from '../ui/kit';
import { TopBand } from './NoCompanyScreen';

/** Where a finished deletion sends the browser: the sign-in page says what was done. */
export const DELETED_PATH = { deleted: '/?deleted=1', already: '/?deleted=already' } as const;

/** What the sign-in page says after a deletion, by the address it was sent to; nothing for any other. */
export function deletedWords(search: string): string | null {
  const said = new URLSearchParams(search).get('deleted');
  if (said === '1') return 'Your account is deleted. This browser is signed out.';
  if (said === 'already') return 'Your account was deleted already. This browser is signed out.';
  return null;
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

/** The words for an answer, as this page says them: the phone's words where they fit a browser too. */
function answerWords(answer: DeletionAnswer, email: string): string {
  switch (answer.kind) {
    case 'unreachable':
      return 'Could not reach MineMuster’s server. Nothing was deleted. Check the connection and try again.';
    case 'last_supervisor': {
      const names = answer.companies.length ? answer.companies : ['A company'];
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return `${list} ${names.length === 1 ? 'has' : 'have'} no other supervisor now, so nothing was deleted. See what to do above.`;
    }
    default:
      return deletionAnswerWords(answer, { email });
  }
}

/** What the page shows, from what it holds: drawn the same in the browser and in the tests. */
export interface AccountViewProps {
  email: string;
  check: DeletionCheckCompany[] | 'checking' | { failed: string };
  typed: Record<string, string>;
  password: string;
  busy: boolean;
  problem: string | null;
  onRetry: () => void;
  onType: (companyId: string, value: string) => void;
  onPassword: (value: string) => void;
  /** A page of one of the person's companies, such as its Roster page. */
  onOpen: (companyId: string, path: string) => void;
  onSubmit: () => void;
}

/** Whether the delete can be asked for now: nothing needed elsewhere first, the password typed, and each company to close named. */
export function canSubmit(check: AccountViewProps['check'], email: string, typed: Record<string, string>, password: string): boolean {
  if (!Array.isArray(check)) return false;
  const plan = accountPlan(email, check);
  return !plan.blocked && !!password && plan.closes.every((c) => namedAs(typed[c.id] ?? '', c.name));
}

export function AccountView({ email, check, typed, password, busy, problem, onRetry, onType, onPassword, onOpen, onSubmit }: AccountViewProps) {
  const companies = Array.isArray(check) ? check : null;
  const failed = !companies && check !== 'checking' ? (check as { failed: string }).failed : null;
  const plan = companies ? accountPlan(email, companies) : null;
  const ready = canSubmit(check, email, typed, password);

  // Every button that names a company may wrap (btn-wrap), as the invitations page's do: a name of 24 characters
  // already took the close button past a phone's width.
  const action = (step: CompanyStep) => {
    const { id, name } = step.company;
    switch (step.kind) {
      case 'hand_over':
      case 'wait':
        return <Button small className="btn-wrap" onClick={() => onOpen(id, '/roster')}>Open {name}’s Roster page</Button>;
      case 'cancel_first':
        return <Button small className="btn-wrap" onClick={() => onOpen(id, '/billing')}>Open {name}’s Billing</Button>;
      case 'close':
        return (
          <div className="stack" style={{ gap: '0.5rem' }}>
            <div>
              <Button small kind="quiet" className="btn-wrap" style={{ paddingInline: 0 }} onClick={() => onOpen(id, '/exports')}>Open {name}’s Exports</Button>
            </div>
            <TextField label={`Type ${name} to close it`} value={typed[id] ?? ''} onChange={(v) => onType(id, v)} autoComplete="off" hint="Capitals and spacing do not matter." />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    // The address is said as one long word, here and in what deleting does: it may break anywhere, to fit a phone.
    <div className="stack" style={{ gap: '1.5rem', maxWidth: '44rem', overflowWrap: 'anywhere' }}>
      <header className="page-head">
        <div className="page-head-text">
          <h1 className="h1" tabIndex={-1}>Your account</h1>
          <p className="lede">Signed in as {email}.</p>
        </div>
      </header>

      <section className="section" aria-labelledby="delete-title">
        <h2 className="h2" id="delete-title">Delete your account</h2>
        {check === 'checking' ? <Loading>Checking your account</Loading> : null}
        {failed !== null ? (
          <Notice tone="bo" title="Your account could not be checked" live>
            <p>{failed} Nothing has been deleted.</p>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <Button small kind="ink" onClick={onRetry}>Try again</Button>
            </div>
          </Notice>
        ) : null}
        {plan ? (
          <div className="stack" style={{ gap: '1.25rem' }}>
            <p>{plan.intro}</p>
            {plan.steps.map((step) => {
              const words = stepWords(step, day);
              return words ? (
                <Notice key={step.company.id} tone={step.kind === 'close' ? 'bo' : 'warn'} title={words.title}>
                  <p>{words.body}</p>
                  <div style={{ marginTop: '0.6rem' }}>{action(step)}</div>
                </Notice>
              ) : null;
            })}
            {plan.warnings.map((line) => (
              <Notice key={line} tone="warn">{line}</Notice>
            ))}

            <div className="stack" style={{ gap: '0.4rem' }}>
              <h3 className="h3">What is deleted</h3>
              <ul className="notice-list">
                {plan.deletes.map((line) => <li key={line}>{line}</li>)}
                {plan.closes.map((c) => <li key={c.id}>{c.name}, and every record of it on MineMuster’s server.</li>)}
              </ul>
            </div>
            <div className="stack" style={{ gap: '0.4rem' }}>
              <h3 className="h3">What stays</h3>
              <ul className="notice-list">
                {plan.keeps.map((line) => <li key={line}>{line}</li>)}
              </ul>
              {plan.legal ? <p className="small muted">{plan.legal}</p> : null}
            </div>

            {plan.blocked ? (
              <p className="small muted">Once that is done, come back to this page to delete your account.</p>
            ) : (
              <form
                className="stack"
                style={{ gap: '0.75rem' }}
                onSubmit={(e) => {
                  e.preventDefault();
                  onSubmit();
                }}
              >
                <TextField
                  label={`Password for ${email}`}
                  type="password"
                  value={password}
                  onChange={onPassword}
                  autoComplete="current-password"
                  hint="Checked with MineMuster’s server to show this is you. Not kept by this page."
                  required
                />
                {problem ? <p className="field-error" role="alert">{problem}</p> : null}
                <div className="row">
                  <Button type="submit" kind="danger" className="btn-wrap" busy={busy} disabled={!ready || busy}>
                    {plan.closes.length ? `Close ${plan.closes.map((c) => c.name).join(' and ')} and delete my account` : 'Delete my account'}
                  </Button>
                </div>
              </form>
            )}
            {plan.blocked && problem ? <p className="field-error" role="alert">{problem}</p> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Your account: deleting the signed-in account, for good. It says what goes, what stays with each
 * company and why, and what a company needs first, as the server's account_deletion_check has it.
 * Where the person is a company's only supervisor, they make someone else a supervisor on that
 * company's Roster page, which this page sends them to (it writes nothing of the roster itself), or
 * the company is closed with the account, with its name typed as it is. The password is typed again,
 * and the delete-account function does the rest. Opened from the menu, the crew's page and the page of
 * an account in no company, and never behind the billing gate: anyone may delete their own account.
 */
export function AccountPage({ email, openCompany, onPick }: { email: string; openCompany: string | null; onPick?: (id: string) => void }) {
  const [check, setCheck] = useState<AccountViewProps['check']>('checking');
  const [tries, setTries] = useState(0);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Your account – MineMuster';
  }, []);
  useEffect(() => {
    let live = true;
    setCheck('checking');
    accountDeletionCheck()
      .then((companies) => live && setCheck(companies))
      .catch((e) => live && setCheck({ failed: messageOf(e) }));
    return () => {
      live = false;
    };
  }, [tries]);

  const submit = async () => {
    if (busy || !Array.isArray(check) || !canSubmit(check, email, typed, password)) return;
    setBusy(true);
    setProblem(null);
    const answer = await deleteMyAccount(email, password, deleteBody(accountPlan(email, check).closes, typed));
    setPassword('');
    if (answer.kind === 'deleted' || answer.kind === 'already_deleted') {
      // The session is for an account that is gone: off this browser, then the sign-in page says so.
      await signOut();
      window.location.replace(answer.kind === 'deleted' ? DELETED_PATH.deleted : DELETED_PATH.already);
      return;
    }
    setBusy(false);
    setProblem(answerWords(answer, email));
    // What the server said may have changed what each company needs: ask it again.
    if (answer.kind === 'last_supervisor' || answer.kind === 'close_refused' || answer.kind === 'try_again' || answer.kind === 'not_known') setTries((n) => n + 1);
  };

  return (
    <AccountView
      email={email}
      check={check}
      typed={typed}
      password={password}
      busy={busy}
      problem={problem}
      onRetry={() => setTries((n) => n + 1)}
      onType={(id, value) => setTyped((t) => ({ ...t, [id]: value }))}
      onPassword={(value) => {
        setPassword(value);
        setProblem(null);
      }}
      onOpen={(companyId, path) => {
        if (companyId !== openCompany) onPick?.(companyId);
        go(path);
      }}
      onSubmit={() => void submit()}
    />
  );
}

/** Your account for someone on no company's roster, or on it as crew: the page on its own, under the top band. */
export function AccountScreen({ email, openCompany, onPick }: { email: string; openCompany: string | null; onPick?: (id: string) => void }) {
  return (
    <>
      <TopBand email={email} />
      <main className="main" id="main">
        <div className="page">
          <p className="crumb">
            <A href="/">Back</A>
          </p>
          <AccountPage email={email} openCompany={openCompany} onPick={onPick} />
        </div>
      </main>
    </>
  );
}
