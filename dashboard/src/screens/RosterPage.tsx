import { useEffect, useRef, useState, type FormEvent } from 'react';

import { cleanText } from '@app/domain/roster';
import type { Role } from '@app/domain/types';
import { fmtDateTime, fmtDayShort } from '@app/util/format';

import {
  addToRoster,
  approveRequest,
  deleteRosterRow,
  denyRequest,
  liftBar,
  releaseClaim,
  rotateJoinCode,
  updateRosterRow,
} from '../lib/api';
import { useCompany } from '../lib/company';
import { messageOf, notAllowed } from '../lib/errors';
import { phonesNotOnRoster, readPastedRoster, REASON_TEXT, rowName, rowsLike } from '../lib/rosterTools';
import type { JoinRequestRow, RosterRow } from '../lib/server';
import { AreaField, Button, Check, Confirm, count, Ledger, Notice, SelectField, tabPanelProps, Tabs, TextField } from '../ui/kit';
import { PageHead } from './Shell';

const when = (iso: string | null | undefined) => (iso ? fmtDateTime(Date.parse(iso)) : '');
const day = (iso: string | null | undefined) => (iso ? `${fmtDayShort(Date.parse(iso))}, ${new Date(Date.parse(iso)).getFullYear()}` : '');

/** A call to the server that says what went wrong, and reloads the roster when it goes through. */
function useAct() {
  const ctx = useCompany();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>, said?: string) => {
    setError(null);
    setDone(null);
    try {
      await work();
      await ctx.reloadRoster();
      // A change to the roster can change this account's own role: ask the server what it is now.
      void ctx.recheckRole();
      if (said) setDone(said);
      return true;
    } catch (e) {
      setError(messageOf(e));
      if (notAllowed(e)) void ctx.recheckRole();
      return false;
    }
  };
  return { act, error, done };
}

/**
 * Who may sign in to the company, and how they join: the sign-in roster on the
 * server, the join code, the requests waiting for a supervisor, and the people
 * the phones know who are not on it yet.
 */
export function RosterPage() {
  const ctx = useCompany();
  const pending = ctx.requests.filter((r) => r.status === 'pending');
  const decided = ctx.requests.filter((r) => r.status !== 'pending').slice(0, 20);
  return (
    <>
      <PageHead title="Roster" lede="The sign-in roster: who may join the company with their own account. A name put here can join by typing it in the app with the join code." />
      <div className="pair">
        <JoinCode />
        <AddPeople />
      </div>
      {pending.length ? (
        <section className="section" aria-labelledby="pending-title">
          <h2 className="h2" id="pending-title">Waiting for a supervisor ({pending.length})</h2>
          <div className="pair">
            {pending.map((r) => <PendingRequest key={r.id} request={r} />)}
          </div>
        </section>
      ) : null}
      <RosterTable />
      <FromThePhones />
      {decided.length ? <Decided requests={decided} /> : null}
    </>
  );
}

function JoinCode() {
  const ctx = useCompany();
  const { act, error } = useAct();
  const code = ctx.choice.join_code;
  return (
    <section className="section" aria-labelledby="code-title">
      <h2 className="h2" id="code-title">Join code</h2>
      <div className="code-show dark">
        <span className="code" aria-label={code ? `Join code ${code.split('').join(' ')}` : undefined}>{code ? `${code.slice(0, 4)} ${code.slice(4)}` : 'Not shown'}</span>
        <p>Give this code to the crew. Each person types it in the MineMuster app with their name. A name on the roster joins by itself; anyone else waits here for a supervisor.</p>
      </div>
      <div className="row">
        <Confirm
          label="Make a new code"
          question="The old code stops working at once. Everyone who joined stays on."
          yes="Make a new code"
          onYes={() =>
            act(async () => {
              ctx.setJoinCode(await rotateJoinCode(ctx.choice.id));
            })
          }
        />
      </div>
      <p className="small muted">Make a new one when the code has gone further than the crew.</p>
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
    </section>
  );
}

function PendingRequest({ request }: { request: JoinRequestRow }) {
  const ctx = useCompany();
  const { act, error } = useAct();
  const like = rowsLike(request, ctx.roster);
  const open = ctx.roster.filter((r) => r.active && !r.user_id);
  const taken = like.filter((r) => r.user_id);
  const [target, setTarget] = useState<string>(() => like.find((r) => !r.user_id)?.id ?? (taken[0] && request.reason !== 'ambiguous' ? `take:${taken[0].id}` : 'new'));
  const [role, setRole] = useState<Role>('employee');
  const [title, setTitle] = useState('');
  const options = [
    { value: 'new', label: `A new row: ${request.last_name}, ${request.first_name}` },
    ...open.map((r) => ({ value: r.id, label: `${rowName(r)}${r.title ? `, ${r.title}` : ''}${r.role === 'supervisor' ? ', supervisor' : ''}` })),
    ...taken.map((r) => ({ value: `take:${r.id}`, label: `${rowName(r)}, taken from the account that joined on it` })),
  ];
  const approve = () => {
    const take = target.startsWith('take:');
    const rosterId = target === 'new' ? undefined : take ? target.slice(5) : target;
    return act(() => approveRequest(request.id, rosterId ? { rosterId, replaceClaim: take } : { role, title: cleanText(title) }));
  };
  const rowId = target.startsWith('take:') ? target.slice(5) : target;
  const asSupervisor = target === 'new' ? role === 'supervisor' : ctx.roster.find((r) => r.id === rowId)?.role === 'supervisor';
  return (
    <article className="request" aria-label={`Request from ${request.first_name} ${request.last_name}`}>
      <div className="stack" style={{ gap: '0.25rem' }}>
        <p className="request-name">{request.last_name}, {request.first_name}</p>
        <p className="small muted">Asked {when(request.created_at)}. The name as they typed it.</p>
        <p>{REASON_TEXT[request.reason] ?? 'A supervisor decides.'}</p>
        {like.length ? (
          <p className="small">
            On the roster it fits: {like.map((r) => `${rowName(r)}${r.user_id ? ' (already joined)' : ''}${r.role === 'supervisor' ? ' (supervisor)' : ''}`).join('; ')}. Check it is the same person before you let them on that row.
          </p>
        ) : null}
      </div>
      {/* The row choice takes the card's whole width: its options carry a full name and a note, and a half-width box cut them off. */}
      <SelectField label="Let them in on" value={target} onChange={setTarget} options={options} />
      {target === 'new' ? (
        <div className="form-grid">
          <SelectField<Role> label="Role" value={role} onChange={setRole} options={[{ value: 'employee', label: 'Crew' }, { value: 'supervisor', label: 'Supervisor' }]} />
          <TextField label="Job title" value={title} onChange={setTitle} hint="Optional." maxLength={100} />
        </div>
      ) : null}
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
      <div className="row">
        {asSupervisor ? (
          <Confirm
            kind="ink"
            label="Let them in"
            question={`${request.last_name}, ${request.first_name} comes in as a supervisor, and will see everyone’s hours, checklists, exams and requests.`}
            yes="Let them in as a supervisor"
            onYes={approve}
          />
        ) : (
          <Button kind="ink" onClick={() => void approve()}>Let them in</Button>
        )}
        <Button kind="danger" onClick={() => void act(() => denyRequest(request.id, false))}>Turn it down</Button>
        <Confirm
          kind="danger"
          label="Turn it down and keep them out"
          question="This account cannot ask again until a supervisor lets it."
          yes="Keep them out"
          onYes={() => act(() => denyRequest(request.id, true))}
        />
      </div>
    </article>
  );
}

function RosterTable() {
  const ctx = useCompany();
  const { act, error, done } = useAct();
  const [open, setOpen] = useState<string | null>(null);
  const [showOff, setShowOff] = useState(false);
  const active = ctx.roster.filter((r) => r.active);
  const off = ctx.roster.filter((r) => !r.active);
  const rows = showOff ? [...active, ...off] : active;
  const joined = active.filter((r) => r.user_id).length;
  // A company keeps at least one supervisor who can sign in; the server turns down anything that would leave it none.
  const signInSupervisors = active.filter((r) => r.role === 'supervisor' && r.user_id);

  return (
    <section className="section" aria-labelledby="roster-title">
      <div className="section-head">
        <h2 className="h2" id="roster-title">On the sign-in roster</h2>
        <span className="section-note">{count(active.length, 'person', 'people')}, {joined} joined with their own account.</span>
      </div>
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
      {done ? <Notice tone="ok" live>{done}</Notice> : null}
      <Ledger>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Job title</th>
              <th scope="col">Role</th>
              <th scope="col">Account</th>
              <th scope="col" data-nolabel><span className="sr-only">Changes</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((row) => {
              const me = !!row.user_id && row.user_id === ctx.me;
              const isOpen = open === row.id;
              const out = [
                <tr key={row.id} style={row.active ? undefined : { color: 'var(--silica)' }}>
                  <th scope="row" className="nowrap">
                    {rowName(row)}
                    {me ? <> <span className="tag tag-ink">You</span></> : null}
                    {row.active ? null : <> <span className="tag">Off the roster</span></>}
                  </th>
                  <td>{row.title ?? <span className="muted">None</span>}</td>
                  <td>{row.role === 'supervisor' ? 'Supervisor' : 'Crew'}</td>
                  <td className="small nowrap">{row.user_id ? <>Joined {day(row.claimed_at)}</> : <span className="muted">Not joined yet</span>}</td>
                  <td className="r">
                    {row.active ? (
                      <Button kind="line" small aria-expanded={isOpen} aria-controls={`change-${row.id}`} onClick={() => setOpen(isOpen ? null : row.id)}>
                        {isOpen ? 'Done' : 'Change'}<span className="sr-only"> {rowName(row)}</span>
                      </Button>
                    ) : (
                      <Button kind="line" small onClick={() => void act(() => updateRosterRow(row.id, { active: true }), `${rowName(row)} is back on the roster.`)}>Put back on</Button>
                    )}
                  </td>
                </tr>,
              ];
              if (isOpen && row.active) {
                out.push(
                  <tr key={`${row.id}-change`} className="row-open">
                    <td colSpan={5} id={`change-${row.id}`}>
                      <RowChanges
                        row={row}
                        me={me}
                        lastSupervisor={row.role === 'supervisor' && !!row.user_id && signInSupervisors.length === 1}
                        act={act}
                        onDone={() => setOpen(null)}
                      />
                    </td>
                  </tr>,
                );
              }
              return out;
            })}
            {rows.length === 0 ? <tr><td colSpan={5} className="ledger-empty">Nobody is on the roster yet. Add the crew with the form beside it.</td></tr> : null}
          </tbody>
        </Ledger>
      {off.length ? <Check label={`Show the ${count(off.length, 'person', 'people')} taken off`} checked={showOff} onChange={setShowOff} /> : null}
      <p className="small muted">A company keeps at least one supervisor who can sign in. To step down, make someone else a supervisor first.</p>
    </section>
  );
}

/** What can be changed about one person on the roster: kept out of the row, so the list stays a list to read. */
function RowChanges({ row, me, lastSupervisor, act, onDone }: {
  row: RosterRow;
  me: boolean;
  lastSupervisor: boolean;
  act: (work: () => Promise<unknown>, said?: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const ctx = useCompany();
  const company = ctx.shaped.company.name || ctx.choice.name;
  const [title, setTitle] = useState(row.title ?? '');
  const name = rowName(row);
  const supervisor = row.role === 'supervisor';
  const onlyOne = 'The only supervisor who can sign in. Make someone else a supervisor first.';
  return (
    <div className="row-changes">
      <form
        className="row"
        style={{ alignItems: 'end' }}
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => updateRosterRow(row.id, { title: cleanText(title) || null }), `The job title of ${name} is saved.`).then((ok) => ok && onDone());
        }}
      >
        <TextField label={`Job title for ${name}`} value={title} onChange={setTitle} maxLength={100} />
        <Button kind="ink" small type="submit">Save the job title</Button>
      </form>
      <div className="row">
        {supervisor ? (
          lastSupervisor ? (
            <Button kind="line" small disabled>Make crew</Button>
          ) : (
            <Confirm
              small
              label={me ? 'Make me crew' : 'Make crew'}
              question={me
                ? `You stop being a supervisor of ${company} at once, and can no longer see its records here.`
                : `${name} can no longer see the company’s records here or change the roster.`}
              yes={me ? 'Make me crew' : 'Make them crew'}
              onYes={() => act(() => updateRosterRow(row.id, { role: 'employee' }), `${name} is now crew.`)}
            />
          )
        ) : (
          <Confirm
            small
            label="Make a supervisor"
            question={`${name} will see everyone’s hours, checklists, exams and requests, and can change the roster.`}
            yes="Make them a supervisor"
            onYes={() => act(() => updateRosterRow(row.id, { role: 'supervisor' }), `${name} is now a supervisor.`)}
          />
        )}
        {row.user_id ? (
          lastSupervisor ? (
            <Button kind="line" small disabled>Let go of the account</Button>
          ) : (
            <Confirm
              small
              label="Let go of the account"
              question={me
                ? 'Your account leaves this row, and you can no longer use the company until a supervisor lets you back in.'
                : `The account that joined as ${name} leaves the row. Do this when the wrong person joined on it.`}
              yes="Let it go"
              onYes={() => act(() => releaseClaim(row.id), `The row for ${name} is free for the right person to join on.`)}
            />
          )
        ) : null}
        {lastSupervisor ? (
          <Button kind="danger" small disabled>Take off</Button>
        ) : (
          <Confirm
            small
            kind="danger"
            label="Take off"
            question={me ? `You can no longer use ${company}, here or in the app.` : row.user_id ? `${name} can no longer use the company.` : `${name} is taken off the roster.`}
            yes={me ? 'Take me off' : 'Take them off'}
            onYes={() => act(() => (row.user_id ? updateRosterRow(row.id, { active: false }) : deleteRosterRow(row.id)), `${name} is off the roster.`)}
          />
        )}
      </div>
      {lastSupervisor ? <p className="small muted">{onlyOne}</p> : null}
    </div>
  );
}

function AddPeople() {
  const ctx = useCompany();
  const { act, error, done } = useAct();
  const [how, setHow] = useState<'one' | 'list'>('one');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [title, setTitle] = useState('');
  const [supervisor, setSupervisor] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<{ first?: string; last?: string }>({});
  const firstRef = useRef<HTMLInputElement>(null);
  const lastRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (problem.first) firstRef.current?.focus();
    else if (problem.last) lastRef.current?.focus();
  }, [problem]);
  const pasted = readPastedRoster(text, ctx.roster);

  const addOne = async (event: FormEvent) => {
    event.preventDefault();
    const wrong = {
      ...(cleanText(first) ? null : { first: 'Give a first name, the way the company writes it.' }),
      ...(cleanText(last) ? null : { last: 'Give a last name, the way the company writes it.' }),
    };
    setProblem(wrong);
    if (wrong.first || wrong.last) return;
    const ok = await act(
      () => addToRoster(ctx.choice.id, [{ firstName: cleanText(first), lastName: cleanText(last), title: cleanText(title), role: supervisor ? 'supervisor' : 'employee' }]),
      `${cleanText(last)}, ${cleanText(first)} is on the roster.`,
    );
    if (ok) {
      setFirst('');
      setLast('');
      setTitle('');
      setSupervisor(false);
    }
  };

  const addList = async () => {
    const ok = await act(() => addToRoster(ctx.choice.id, pasted.add), `${count(pasted.add.length, 'person', 'people')} added to the roster.`);
    if (ok) setText('');
  };

  return (
    <section className="panel" aria-labelledby="add-title">
      <h2 className="h2" id="add-title">Add to the roster</h2>
      <Tabs<'one' | 'list'>
        label="How to add"
        value={how}
        onChange={setHow}
        panelId="add-panel"
        options={[{ value: 'one', label: 'One person' }, { value: 'list', label: 'Paste a list' }]}
      />
      {how === 'one' ? (
        <form className="stack" onSubmit={addOne} noValidate {...tabPanelProps('add-panel', how)}>
          <div className="form-grid">
            <TextField label="First name" value={first} onChange={setFirst} maxLength={100} hint="With a middle initial or a nickname in quotes, if the company writes it." error={problem.first} inputRef={firstRef} />
            <TextField label="Last name" value={last} onChange={setLast} maxLength={100} hint="With Jr or III, if they have one." error={problem.last} inputRef={lastRef} />
          </div>
          <TextField label="Job title" value={title} onChange={setTitle} maxLength={100} hint="Optional." />
          <Check label="A supervisor" checked={supervisor} onChange={setSupervisor} />
          <Button kind="main" type="submit">Add to the roster</Button>
        </form>
      ) : (
        <div className="stack" {...tabPanelProps('add-panel', how)}>
          <AreaField
            label="The list"
            value={text}
            onChange={setText}
            hint={<>One person to a line: the name, then the job title, then supervisor for a supervisor, with a bar between. For example: <span className="written">Quinn, Riley J | Maintenance | supervisor</span></>}
          />
          {text.trim() ? (
            <div className="stack" style={{ gap: '0.4rem' }}>
              <p><strong>{count(pasted.add.length, 'person', 'people')} to add.</strong></p>
              {pasted.add.length ? (
                <ul className="small" style={{ display: 'grid', gap: '0.15rem' }}>
                  {pasted.add.slice(0, 12).map((p) => (
                    <li key={`${p.lastName}|${p.firstName}`}>{p.lastName}, {p.firstName}{p.title ? `, ${p.title}` : ''}{p.role === 'supervisor' ? ', supervisor' : ''}</li>
                  ))}
                  {pasted.add.length > 12 ? <li className="muted">and {pasted.add.length - 12} more</li> : null}
                </ul>
              ) : null}
              {pasted.skipped.length ? (
                <Notice tone="warn" title={`${count(pasted.skipped.length, 'line')} passed over`}>
                  <ul className="small">
                    {pasted.skipped.map((s, i) => <li key={i}>{s.line}: {s.why}.</li>)}
                  </ul>
                </Notice>
              ) : null}
            </div>
          ) : null}
          <Button kind="main" disabled={pasted.add.length === 0} onClick={() => void addList()}>
            {pasted.add.length ? `Add ${count(pasted.add.length, 'person', 'people')}` : 'Add the list'}
          </Button>
        </div>
      )}
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
      {done ? <Notice tone="ok" live>{done}</Notice> : null}
    </section>
  );
}

function FromThePhones() {
  const ctx = useCompany();
  const { act, error, done } = useAct();
  const missing = phonesNotOnRoster(ctx.shaped.data.employees, ctx.roster, ctx.shaped.placeholders);
  if (missing.length === 0) return null;
  const put = (people: typeof missing) =>
    act(
      () => addToRoster(ctx.choice.id, people.map((e) => ({ firstName: e.firstName, lastName: e.lastName, title: e.title, role: e.role }))),
      `${count(people.length, 'person', 'people')} put on the sign-in roster.`,
    );
  return (
    <section className="section" aria-labelledby="phones-title">
      <div className="section-head">
        <h2 className="h2" id="phones-title">On the phones, not on the sign-in roster</h2>
        {missing.length > 1 ? <Button kind="ink" small onClick={() => void put(missing)}>Put all {missing.length} on the sign-in roster</Button> : null}
      </div>
      <p className="section-note">The app’s own roster, as a supervisor’s phone sent it. Until a name is on the sign-in roster too, that person cannot join the company under it.</p>
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
      {done ? <Notice tone="ok" live>{done}</Notice> : null}
      <Ledger>
          <thead><tr><th scope="col">Name</th><th scope="col">Job title</th><th scope="col">Role</th><th scope="col" data-nolabel><span className="sr-only">Add</span></th></tr></thead>
          <tbody>
            {missing.map((e) => (
              <tr key={e.id}>
                <th scope="row">{e.lastName}, {e.firstName}</th>
                <td>{e.title ?? ''}</td>
                <td>{e.role === 'supervisor' ? 'Supervisor' : 'Crew'}</td>
                <td className="r"><Button kind="line" small onClick={() => void put([e])}>Put on the sign-in roster</Button></td>
              </tr>
            ))}
          </tbody>
        </Ledger>
    </section>
  );
}

const DECIDED: Record<string, string> = { approved: 'Let in', denied: 'Turned down', withdrawn: 'Settled by itself' };

function Decided({ requests }: { requests: JoinRequestRow[] }) {
  const { act, error, done } = useAct();
  return (
    <section className="section" aria-labelledby="decided-title">
      <h2 className="h2" id="decided-title">Decided requests</h2>
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
      {done ? <Notice tone="ok" live>{done}</Notice> : null}
      <ul className="daylist">
        {requests.map((r) => (
          <li key={r.id} style={{ padding: '0.6rem 0.9rem', display: 'grid', gap: '0.3rem' }}>
            <span><strong>{r.last_name}, {r.first_name}</strong> <span className="small muted">{DECIDED[r.status] ?? r.status}{r.decided_at ? `, ${when(r.decided_at)}` : ''}</span></span>
            {r.status === 'denied' ? (
              <span>
                <Button kind="quiet" small className="btn-flush" onClick={() => void act(() => liftBar(r.id), `${r.first_name} ${r.last_name} may ask again.`)}>Let them ask again</Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="small muted">A request turned down can be made again. One turned down with “keep them out” cannot, until a supervisor lets them ask again.</p>
    </section>
  );
}
