import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { keepsTime } from '@app/domain/company';
import { cleanText, titleCase, type PersonName } from '@app/domain/roster';
import type { Employee, Role } from '@app/domain/types';
import { fmtDateTime } from '@app/util/format';

import {
  addToRoster,
  approveRequest,
  cancelInvitation,
  deleteCrewSignIn,
  deleteRosterRow,
  denyRequest,
  inviteSupervisor,
  liftBar,
  makeResetCode,
  releaseClaim,
  resendInvitation,
  rosterSignIns,
  rotateJoinCode,
  updateRosterRow,
} from '../lib/api';
import { useCompany } from '../lib/company';
import { messageOf, notAllowed } from '../lib/errors';
import {
  ACCEPTED_NOT_WRITTEN,
  addPeople,
  addToApp,
  appPeople,
  changeRow,
  CLOCK_ANSWERS,
  clockQuestion,
  finishAccepting,
  finishAdding,
  inAppWords,
  keptIds,
  letInOnNewRow,
  makeBoth,
  notInApp,
  offAppQuestion,
  oneAtATime,
  onTheClock,
  PEOPLE_NOT_LOADED,
  personName,
  planAdd,
  roleMismatch,
  ROSTER_LEDE,
  ROSTER_LEDE_SAFETY_ONLY,
  rowPerson,
  savePayrollId,
  takeOff,
  takeOffApp,
  takenOffQuestion,
  type AddPlan,
  type Answer,
  type Answered,
  type Ids,
  type PeopleWrites,
  type Rosters,
  type Told,
} from '../lib/rosterPeople';
import { matchRows, offRosterInApp, phonesNotOnRoster, readPastedRoster, REASON_TEXT, rowName, rowsLike, type RowMatch } from '../lib/rosterTools';
import { useFormFields, useSaver } from '../lib/save';
import type { JoinRequestRow, RosterRow, RosterSignIn } from '../lib/server';
import {
  accountWords,
  deleteSignInQuestion,
  groupCode,
  INVITE_SENT_ALWAYS,
  inviteAddress,
  inviteWords,
  KEEP_OUT_NOTE,
  KEEP_OUT_QUESTION,
  makeSupervisorBy,
  makeSupervisorByEmail,
  RESET_CODE_GOOD_FOR,
  RESET_CODE_HELP,
  RESET_CODE_ONCE,
  reloadAfter,
  signInTools,
} from '../lib/signIns';
import { AreaField, Button, Check, Confirm, count, Ledger, Notice, Seg, SelectField, tabPanelProps, Tabs, TextField } from '../ui/kit';
import { PageHead } from './Shell';

const when = (iso: string | null | undefined) => (iso ? fmtDateTime(Date.parse(iso)) : '');

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
 * The company's people: the sign-in roster on the server (who may join the
 * company with their own account), and the roster in the app, the employee
 * records every phone receives. People are added, changed and taken off here,
 * and both are written together (`src/lib/rosterPeople.ts`). Also the join
 * code, the requests waiting for a supervisor, and payroll IDs.
 */
export function RosterPage() {
  const ctx = useCompany();
  const app = useAppRoster();
  // What letting a request in came to: said here, since the request it was about leaves the page.
  const letIn = useTell();
  const pending = ctx.requests.filter((r) => r.status === 'pending');
  const decided = ctx.requests.filter((r) => r.status !== 'pending').slice(0, 20);
  return (
    <>
      <PageHead title="Roster" lede={keepsTime(ctx.shaped.company) ? ROSTER_LEDE : ROSTER_LEDE_SAFETY_ONLY} />
      {app.known ? null : (
        <Notice tone="warn" title="The app’s roster is not loaded">
          Who is on the sign-in roster is shown, and the company code and requests work. Adding people, changing a job title, making someone a supervisor and putting someone back wait for the records, because the two rosters are written together. Taking someone off and making a supervisor crew still change the sign-in roster at once; look at the app’s roster once the records load. Load new records to try again.
        </Notice>
      )}
      <div className="pair">
        <JoinCode />
        <AddPeople />
      </div>
      {pending.length || letIn.told ? (
        <section className="section" aria-labelledby="pending-title">
          <h2 className="h2" id="pending-title">Waiting for a supervisor ({pending.length})</h2>
          <ToldNotice told={letIn.told} onFinish={(adds) => void letIn.tell(() => app.run(() => finishAdding(app.io, app.rosters!, adds, app.ids)))} />
          {pending.length ? (
            <div className="pair">
              {pending.map((r) => <PendingRequest key={r.id} request={r} tell={letIn.tell} />)}
            </div>
          ) : null}
        </section>
      ) : null}
      <RosterTable />
      <NotInApp />
      <FromThePhones />
      <OffRosterInApp />
      <PayrollIds />
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
      <h2 className="h2" id="code-title">Company code</h2>
      <div className="code-show dark">
        <span className="code" aria-label={code ? `Company code ${code.split('').join(' ')}` : undefined}>{code ? `${code.slice(0, 4)} ${code.slice(4)}` : 'Not shown'}</span>
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

function PendingRequest({ request, tell }: { request: JoinRequestRow; tell: Tell }) {
  const ctx = useCompany();
  const app = useAppRoster();
  const { act, error } = useAct();
  const [busy, once] = useBusy();
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
  const approve = () =>
    once(async () => {
      const take = target.startsWith('take:');
      const rosterId = target === 'new' ? undefined : take ? target.slice(5) : target;
      if (rosterId) return act(() => approveRequest(request.id, { rosterId, replaceClaim: take }));
      // A new row: the server writes it, and the person in the app is written after it, as for any addition.
      return tell(async () => {
        const typedTitle = cleanText(title);
        const id = await approveRequest(request.id, { role, title: typedTitle });
        const at = new Date().toISOString();
        const row: RosterRow = {
          id, company_id: ctx.choice.id, first_name: request.first_name, last_name: request.last_name, title: typedTitle || null, role, active: true,
          user_id: request.user_id, claimed_at: at, created_at: at,
        };
        return letInOnNewRow(app.io, app.rosters && { ...app.rosters, rows: [...app.rosters.rows.filter((r) => r.id !== id), row] }, row, app.ids);
      });
    });
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
          <Button kind="ink" busy={busy} onClick={() => void approve()}>Let them in</Button>
        )}
        <Button kind="danger" onClick={() => void act(() => denyRequest(request.id, false))}>Turn it down</Button>
        <Confirm
          kind="danger"
          label="Turn it down and keep them out"
          question={KEEP_OUT_QUESTION}
          yes="Keep them out"
          onYes={() => act(() => denyRequest(request.id, true))}
        />
      </div>
    </article>
  );
}

// ---- The two rosters, written together ------------------------------------------------------------------

/**
 * The people in the app as the records hold them, and the writes that change
 * them: the person through `saveRecord` (with `revOf` and the version the page
 * loaded as its base), the sign-in row through the roster table. Nothing about
 * a person is written while the records are not loaded (`known`).
 */
function useAppRoster() {
  const ctx = useCompany();
  const save = useSaver();
  const { employees } = ctx.shaped.data;
  const { placeholders } = ctx.shaped;
  const known = !ctx.recordsHeld && !ctx.recordsError;
  const io: PeopleWrites = {
    savePerson: (person, what) => save({ kind: 'employee', id: person.id, record: person, what }),
    addRows: (rows) => addToRoster(ctx.choice.id, rows),
    updateRow: (id, patch) => updateRosterRow(id, patch),
    deleteRow: (id) => deleteRosterRow(id),
  };
  const people = appPeople(employees, placeholders);
  /** People a page names only from the sign-in row of the account that sent their hours. */
  const named = employees.filter((e) => placeholders.has(e.id));
  return {
    known,
    people,
    named,
    /** Both rosters, or null while the app's is not loaded. */
    rosters: known ? ({ people, named, rows: ctx.roster } satisfies Rosters) : null,
    /** Which person in the app each active row is for, one to a row. */
    matches: known ? matchRows(ctx.roster, people) : new Map<string, RowMatch>(),
    io,
    ids: idsOf(ctx.choice.id),
    /** Run a change of people, or say why it cannot run now. */
    run: (work: () => Promise<Told>): Promise<Told> => (known ? work() : Promise.resolve(PEOPLE_NOT_LOADED)),
  };
}

/** The ids new people are saved under, kept for each company while this page is open (`keptIds`). */
const KEPT_IDS = new Map<string, Ids>();
function idsOf(companyId: string): Ids {
  let ids = KEPT_IDS.get(companyId);
  if (!ids) KEPT_IDS.set(companyId, (ids = keptIds()));
  return ids;
}

/** A button's work one run at a time (`oneAtATime`), and whether a run is under way, for the button to say. */
function useBusy() {
  const [busy, setBusy] = useState(false);
  const only = useRef(oneAtATime()).current;
  const once = <T,>(work: () => Promise<T>) =>
    only(async () => {
      setBusy(true);
      try {
        return await work();
      } finally {
        setBusy(false);
      }
    });
  return [busy, once] as const;
}

type AppRoster = ReturnType<typeof useAppRoster>;

/** A change of people, said when it is done, with the roster loaded again and this account's role asked again after it. */
function useTell() {
  const ctx = useCompany();
  const [told, setTold] = useState<Told | null>(null);
  const tell = async (work: () => Promise<Told>): Promise<boolean> => {
    setTold(null);
    let result: Told;
    try {
      result = await work();
    } catch (e) {
      result = { tone: 'bo', text: messageOf(e) };
    }
    try {
      await ctx.reloadRoster();
    } catch {
      // The page keeps the roster it has; what was done is said below.
    }
    // A change to the roster can change this account's own role: ask the server what it is now.
    void ctx.recheckRole();
    setTold(result);
    return result.tone === 'ok';
  };
  return { told, tell, say: setTold };
}

type Tell = ReturnType<typeof useTell>['tell'];

const TOLD_TITLE: Record<Told['tone'], string | undefined> = { ok: undefined, warn: 'Look again', bo: 'Not saved' };

/**
 * What a change of people came to, where the person can see it: half done is
 * said as not finished, with what the server said and the button that
 * finishes it. It takes the focus, since the button pressed may have gone with
 * what it changed; a field saved in place keeps it (`keepFocus`).
 */
export function ToldNotice({ told, onFinish, keepFocus }: { told: Told | null; onFinish?: (adds: Answered[]) => void; keepFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!told) return;
    ref.current?.scrollIntoView({ block: 'nearest' });
    if (!keepFocus) ref.current?.focus({ preventScroll: true });
  }, [told, keepFocus]);
  if (!told) return null;
  return (
    <div ref={ref} tabIndex={-1} className="said">
      <Notice tone={told.tone} title={told.tone === 'warn' && told.why ? 'Not finished' : TOLD_TITLE[told.tone]} live alert={told.tone !== 'ok'}>
        {told.text}
        {told.why ? <> {told.why}</> : null}
        {told.finish && onFinish ? (
          <span className="row" style={{ marginTop: '0.5rem' }}>
            <Button kind="ink" small onClick={() => onFinish(told.finish!.adds)}>{told.finish.label}</Button>
          </span>
        ) : null}
      </Notice>
    </div>
  );
}

/**
 * Once a company opens on an invitation just accepted: the acceptance made the person's sign-in row a supervisor's,
 * and this makes the person in the app one too, through Make both supervisor's own write (`finishAccepting`, with
 * the page's writes: `saveRecord`, from the version the page loaded), so the app does not go on treating them as
 * crew. Run once, when the company's records have loaded (the company opens only then); what it says stays above the
 * company's pages until another company is picked. With the records not loaded, or the write refused, it says so
 * and points to Make both supervisor on the person's row.
 */
export function AcceptedNotice() {
  const ctx = useCompany();
  const app = useAppRoster();
  const [told, setTold] = useState<Told | null>(null);
  const ran = useRef(false);
  const run = useRef({ app, me: ctx.me });
  run.current = { app, me: ctx.me };
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const { app: now, me } = run.current;
    void finishAccepting(now.io, now.rosters, me).then(setTold, (e: unknown) => setTold({ tone: 'bo', text: ACCEPTED_NOT_WRITTEN, why: messageOf(e) }));
  }, []);
  return <ToldNotice told={told} keepFocus />;
}

const ANSWERS: { value: Answer; label: string }[] = [
  { value: 'back', label: 'Bring them back' },
  { value: 'new', label: 'Add a new person' },
];

/**
 * The question asked when someone taken off the roster has the name being
 * added, with its two answers as buttons. The question itself takes the focus
 * and names the group, so it is read first; neither answer has the focus,
 * since both write, and a second press of Enter must not answer it.
 */
export function TakenOffAsk({ person, onAnswer, busy }: { person: Employee; onAnswer: (answer: Answer) => void; busy?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div ref={ref} tabIndex={-1} className="inline-confirm" role="group" aria-labelledby={id}>
      <span id={id}>{takenOffQuestion(person)}</span>
      <Button kind="ink" small busy={busy} onClick={() => onAnswer('back')}>Bring them back</Button>
      <Button kind="line" small busy={busy} onClick={() => onAnswer('new')}>Add a new person</Button>
    </div>
  );
}

const firstLast = (row: Pick<RosterRow, 'first_name' | 'last_name'>) => personName(rowPerson(row));

function RosterTable() {
  const ctx = useCompany();
  const app = useAppRoster();
  const { act, error, done } = useAct();
  const { told, tell } = useTell();
  const [busy, once] = useBusy();
  const { signIns, trouble, reload: reloadSignIns } = useSignIns();
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
      <ToldNotice told={told} />
      {trouble ? <Notice tone="warn" title="How each person signs in is not shown">{trouble}</Notice> : null}
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
              const match = row.active ? app.matches.get(row.id) : undefined;
              const person = match?.kind === 'person' ? match.person : undefined;
              const differs = roleMismatch(row, person);
              const out = [
                <tr key={row.id} style={row.active ? undefined : { color: 'var(--silica)' }}>
                  <th scope="row" className="nowrap">
                    {rowName(row)}
                    {me ? <> <span className="tag tag-ink">You</span></> : null}
                    {row.active ? null : <> <span className="tag">Off the roster</span></>}
                    {match?.kind === 'none' ? <> <span className="tag tag-warn">Not in the app</span></> : null}
                    {match?.kind === 'two' ? <> <span className="tag tag-warn">Two in the app</span></> : null}
                    {match?.kind === 'two' ? (
                      <span className="under">
                        {match.people.map((p) => (
                          <span key={p.id} className="row" style={{ gap: '0.5rem' }}>
                            <span className="small">{p.lastName}, {p.firstName}{p.title ? `, ${p.title}` : ''}</span>
                            <TakeOffApp person={p} tell={tell} app={app} />
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </th>
                  <td>{row.title ?? <span className="muted">None</span>}</td>
                  <td>
                    {row.role === 'supervisor' ? 'Supervisor' : 'Crew'}
                    {differs && person ? (
                      <span className="under">
                        {differs.line}{' '}
                        <Button kind="quiet" small className="btn-flush" busy={busy} onClick={() => void once(() => tell(() => app.run(() => makeBoth(app.io, person, row.role))))}>
                          {differs.label}<span className="sr-only">: {firstLast(row)}</span>
                        </Button>
                      </span>
                    ) : null}
                  </td>
                  <AccountCell signIn={signIns.get(row.id)} claimedAt={row.claimed_at} now={ctx.now} />
                  <td className="r">
                    {row.active ? (
                      <Button kind="line" small aria-expanded={isOpen} aria-controls={`change-${row.id}`} onClick={() => setOpen(isOpen ? null : row.id)}>
                        {isOpen ? 'Done' : 'Change'}<span className="sr-only"> {rowName(row)}</span>
                      </Button>
                    ) : (
                      <Button kind="line" small busy={busy} onClick={() => void once(() => tell(() => changeRow(app.io, app.rosters, row, { active: true }, `${firstLast(row)} is back on the roster.`)))}>
                        Put back on<span className="sr-only"> {rowName(row)}</span>
                      </Button>
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
                        app={app}
                        person={person}
                        signIn={signIns.get(row.id)}
                        reloadSignIns={reloadSignIns}
                        tell={tell}
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
function RowChanges({ row, me, lastSupervisor, app, person, signIn, reloadSignIns, tell, act, onDone }: {
  row: RosterRow;
  me: boolean;
  lastSupervisor: boolean;
  app: AppRoster;
  /** The person in the app the row is for, when there is one. */
  person: Employee | undefined;
  /** How the row is signed in, when the server has said. */
  signIn: RosterSignIn | undefined;
  reloadSignIns: () => Promise<void>;
  tell: (work: () => Promise<Told>) => Promise<boolean>;
  act: (work: () => Promise<unknown>, said?: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const ctx = useCompany();
  const company = ctx.shaped.company.name || ctx.choice.name;
  const [title, setTitle] = useState(row.title ?? '');
  const name = rowName(row);
  const said = firstLast(row);
  const supervisor = row.role === 'supervisor';
  const onlyOne = 'The only supervisor who can sign in. Make someone else a supervisor first.';
  // On the clock, as far as their phone has sent: their clock-out reaches the company only while they are on the roster.
  const since = person ? onTheClock(person.id, ctx.shaped.data.shifts, ctx.now, ctx.shaped.company) : null;
  // Without the app's roster, `changeRow` and `takeOff` go ahead only with what takes a sign-in's access away.
  const change = (patch: Parameters<typeof changeRow>[3], words: string) => tell(() => changeRow(app.io, app.rosters, row, patch, words));
  const typed = cleanText(title);
  const [inviting, setInviting] = useState(false);
  return (
    <div className="row-changes">
      <form
        className="row"
        style={{ alignItems: 'end' }}
        onSubmit={(e) => {
          e.preventDefault();
          void change({ title: typed || null }, typed ? `${said}’s job title is ${typed} now.` : `${said} has no job title now.`).then((ok) => ok && onDone());
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
              onYes={() => change({ role: 'employee' }, `${said} is now crew.`)}
            />
          )
        ) : makeSupervisorBy(signIn) === 'invite' ? (
          // A passcode account cannot be a supervisor's: a supervisor signs in with email, so they are invited.
          <Button kind="line" small aria-expanded={inviting} onClick={() => setInviting(true)}>Make a supervisor<span className="sr-only">: {name}</span></Button>
        ) : (
          <Confirm
            small
            label="Make a supervisor"
            question={`${name} will see everyone’s hours, checklists, exams and requests, and can change the roster.`}
            yes="Make them a supervisor"
            onYes={() => change({ role: 'supervisor' }, `${said} is now a supervisor.`)}
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
            question={since !== null
              ? clockQuestion(said, since)
              : me ? `You can no longer use ${company}, here or in the app.` : row.user_id ? `${name} can no longer use the company.` : `${name} is taken off the roster.`}
            yes={since !== null ? CLOCK_ANSWERS.yes : me ? 'Take me off' : 'Take them off'}
            no={since !== null ? CLOCK_ANSWERS.no : undefined}
            onYes={() => tell(() => takeOff(app.io, app.rosters, row, `${said} is off the roster.`))}
          />
        )}
      </div>
      <SignInTools row={row} signIn={signIn} inviting={inviting} setInviting={setInviting} onChanged={reloadSignIns} />
      {lastSupervisor ? <p className="small muted">{onlyOne}</p> : null}
    </div>
  );
}

// ---- How each person signs in --------------------------------------------------------------------------

/**
 * How every row of the company is signed in (roster_sign_ins), read again whenever the roster is. A read that
 * fails is said, and the page keeps what it had; the Account column then says only joined or not.
 */
function useSignIns() {
  const ctx = useCompany();
  const [signIns, setSignIns] = useState<Map<string, RosterSignIn>>(new Map());
  const [trouble, setTrouble] = useState<string | null>(null);
  const turn = useRef(0);
  const companyId = ctx.choice.id;
  const reload = useCallback(async () => {
    const mine = ++turn.current;
    try {
      const rows = await rosterSignIns(companyId);
      if (mine !== turn.current) return;
      setSignIns(new Map(rows.map((r) => [r.roster_id, r])));
      setTrouble(null);
    } catch (e) {
      if (mine === turn.current) setTrouble(messageOf(e));
    }
  }, [companyId]);
  useEffect(() => {
    void reload();
  }, [reload, ctx.roster]);
  return { signIns, trouble, reload };
}

/** The Account column: how the row is held, and where an open invitation went. */
export function AccountCell({ signIn, claimedAt, now }: { signIn: RosterSignIn | undefined; claimedAt: string | null; now: number }) {
  const words = accountWords(signIn, claimedAt, now);
  return (
    <td className="small">
      {words === 'Not joined yet' ? <span className="muted">{words}</span> : words}
      {signIn?.invitation_id && signIn.invited_email ? <span className="under">Sent to {signIn.invited_email}{signIn.invited_at ? `, ${when(signIn.invited_at)}` : ''}</span> : null}
    </td>
  );
}

/** A reset code, shown once: large, in groups, and read digit by digit by a screen reader. */
export function ResetCode({ name, code, onClose }: { name: string; code: string; onClose: () => void }) {
  return (
    <div className="code-show dark" role="group" aria-label={`Reset code for ${name}`}>
      <span className="code" aria-label={`Reset code for ${name}: ${code.split('').join(' ')}`}>{groupCode(code)}</span>
      <p>{RESET_CODE_HELP}</p>
      <p>{RESET_CODE_GOOD_FOR}</p>
      <p>{RESET_CODE_ONCE}</p>
      <div className="row"><Button kind="ink" small onClick={onClose}>Done, I have given it</Button></div>
    </div>
  );
}

/**
 * The tools for how a row is signed in, under the row's other changes: a reset code and deleting a passcode
 * account's sign-in, an invitation by email, and sending an open invitation again or cancelling it. Which of them a
 * row gets is `signInTools`. Each reloads the sign-ins after it, and the roster, which `useAct` does.
 */
export function SignInTools({ row, signIn, inviting, setInviting, onChanged }: {
  row: RosterRow;
  signIn: RosterSignIn | undefined;
  inviting: boolean;
  setInviting: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const { act, error, done } = useAct();
  const [busy, once] = useBusy();
  const [code, setCode] = useState<string | null>(null);
  const tools = signInTools(row, signIn);
  const name = rowName(row);
  const said = firstLast(row);
  const address = signIn?.invited_email ?? 'the address';
  // A new action puts away the code of the last: a code is shown once.
  const run = (work: () => Promise<unknown>, words?: string) =>
    once(() => {
      setCode(null);
      return act(() => reloadAfter(work, onChanged), words);
    });
  if (!signIn || (!Object.values(tools).some(Boolean) && !inviting && !error && !done && !code)) return null;
  return (
    <div className="stack" style={{ gap: '0.75rem' }}>
      <div className="row">
        {tools.resetPasscode ? (
          <Button kind="line" small busy={busy} onClick={() => void run(async () => setCode(await makeResetCode(row.id)))}>
            Reset passcode<span className="sr-only">: {name}</span>
          </Button>
        ) : null}
        {tools.deleteSignIn ? (
          <Confirm
            small
            kind="danger"
            label="Delete sign-in"
            name={`Delete the passcode sign-in of ${said}`}
            question={deleteSignInQuestion(said)}
            yes="Delete the sign-in"
            onYes={() => run(() => deleteCrewSignIn(row.id), `${said}’s passcode sign-in is deleted. The row and every record stay with the company, and ${said} can sign up for the row again.`)}
          />
        ) : null}
        {tools.invite && !inviting ? (
          <Button kind="line" small aria-expanded={false} onClick={() => setInviting(true)}>Invite by email<span className="sr-only">: {name}</span></Button>
        ) : null}
        {tools.sendAgain && signIn.invitation_id ? (
          <Button kind="line" small busy={busy} onClick={() => void run(() => resendInvitation(signIn.invitation_id as string), INVITE_SENT_ALWAYS(address))}>
            Send again<span className="sr-only">: invitation to {name}</span>
          </Button>
        ) : null}
        {tools.cancelInvitation && signIn.invitation_id ? (
          <Confirm
            small
            label="Cancel invitation"
            name={`Cancel the invitation to ${address}`}
            question={`${address} can no longer accept it. Nothing about ${said}’s row changes.`}
            yes="Cancel the invitation"
            no="Keep the invitation"
            onYes={() => run(() => cancelInvitation(signIn.invitation_id as string), 'The invitation is cancelled.')}
          />
        ) : null}
      </div>
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
      {done ? <Notice tone="ok" live>{done}</Notice> : null}
      {code ? <ResetCode name={said} code={code} onClose={() => setCode(null)} /> : null}
      {inviting ? <InviteForm row={row} signIn={signIn} onClose={() => setInviting(false)} onChanged={onChanged} /> : null}
    </div>
  );
}

/**
 * The email address an invitation goes to. It is checked here first, as strictly as the database and Supabase
 * Auth, and the answer is always "sent", whether or not the address has an account, so the page never tells which.
 */
export function InviteForm({ row, signIn, onClose, onChanged }: {
  row: RosterRow;
  signIn: RosterSignIn;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { act, error, done } = useAct();
  const [busy, once] = useBusy();
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const said = firstLast(row);
  const explain = signIn.sign_in === 'passcode' ? makeSupervisorByEmail(said) : inviteWords(said);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const checked = inviteAddress(email);
    setProblem(checked.ok ? null : checked.why);
    if (!checked.ok) return;
    void once(async () => {
      const sent = await act(() => reloadAfter(() => inviteSupervisor(row.id, checked.address), onChanged), INVITE_SENT_ALWAYS(checked.address));
      if (sent) setEmail('');
    });
  };
  return (
    <form className="stack" style={{ gap: '0.5rem' }} onSubmit={submit} noValidate>
      <p className="small">{explain}</p>
      <div className="row" style={{ alignItems: 'end' }}>
        <TextField label={`Email address for ${rowName(row)}`} value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="off" maxLength={254} error={problem} />
        <Button kind="ink" small type="submit" busy={busy}>Send invitation</Button>
        <Button kind="line" small onClick={onClose}>Close</Button>
      </div>
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
      {done ? <Notice tone="ok" live>{done}</Notice> : null}
    </form>
  );
}

const nameKey = (p: PersonName) => `${p.lastName.toLowerCase()}|${p.firstName.toLowerCase()}`;

function AddPeople() {
  const ctx = useCompany();
  const app = useAppRoster();
  const { told, tell, say } = useTell();
  const [busy, once] = useBusy();
  const [how, setHow] = useState<'one' | 'list'>('one');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [title, setTitle] = useState('');
  const [supervisor, setSupervisor] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<{ first?: string; last?: string }>({});
  // Someone taken off the roster has the name typed: the page asks before it adds.
  const [asked, setAsked] = useState<Employee | null>(null);
  // The answers to the same question for the people in a pasted list.
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const firstRef = useRef<HTMLInputElement>(null);
  const lastRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (problem.first) firstRef.current?.focus();
    else if (problem.last) lastRef.current?.focus();
  }, [problem]);
  const pasted = readPastedRoster(text, ctx.roster);
  const planned = app.rosters ? pasted.add.map((p) => ({ ...p, plan: planAdd(app.rosters!, p) })) : [];
  const refused = planned.filter((p) => p.plan.kind === 'refused');
  const toAdd = planned.filter((p) => p.plan.kind !== 'refused');
  const asks = toAdd.flatMap((p) => (p.plan.kind === 'ask' ? [{ ...p, person: p.plan.person }] : []));
  const unanswered = asks.filter((p) => !answers[nameKey(p)]).length;

  /** A name typed in: what was asked about the one before no longer holds. */
  const typedName = () => {
    if (asked) setAsked(null);
  };

  const addOne = (event?: FormEvent, answer?: Answer) => {
    event?.preventDefault();
    return once(async () => {
      const wrong = {
        ...(cleanText(first) ? null : { first: 'Give a first name, the way the company writes it.' }),
        ...(cleanText(last) ? null : { last: 'Give a last name, the way the company writes it.' }),
      };
      setProblem(wrong);
      if (wrong.first || wrong.last) return;
      if (!app.rosters) return say(PEOPLE_NOT_LOADED);
      const typed = { firstName: titleCase(first), lastName: titleCase(last), title: cleanText(title) || undefined, role: (supervisor ? 'supervisor' : 'employee') as Role };
      // A name the sign-in roster has already is turned down here, as a pasted list passes it over.
      const plan: AddPlan = planAdd(app.rosters, typed);
      if (plan.kind === 'refused') return say({ tone: 'bo', text: plan.text });
      if (plan.kind === 'ask' && !answer) {
        say(null);
        setAsked(plan.person);
        return;
      }
      setAsked(null);
      const ok = await tell(() => addPeople(app.io, app.rosters!, [{ ...typed, plan, answer }], app.ids));
      if (ok) {
        setFirst('');
        setLast('');
        setTitle('');
        setSupervisor(false);
      }
    });
  };

  const addList = () =>
    once(async () => {
      if (!app.rosters) return say(PEOPLE_NOT_LOADED);
      const ok = await tell(() => addPeople(app.io, app.rosters!, toAdd.map((p) => ({ ...p, answer: answers[nameKey(p)] })), app.ids));
      if (ok) {
        setText('');
        setAnswers({});
      }
    });

  const finish = (adds: Answered[]) => void once(() => tell(() => app.run(() => finishAdding(app.io, app.rosters!, adds, app.ids))));

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
            <TextField label="First name" value={first} onChange={(v) => { setFirst(v); typedName(); }} maxLength={100} hint="With a middle initial or a nickname in quotes, if the company writes it." error={problem.first} inputRef={firstRef} />
            <TextField label="Last name" value={last} onChange={(v) => { setLast(v); typedName(); }} maxLength={100} hint="With Jr or III, if they have one." error={problem.last} inputRef={lastRef} />
          </div>
          <TextField label="Job title" value={title} onChange={setTitle} maxLength={100} hint="Optional." />
          <Check label="A supervisor" checked={supervisor} onChange={setSupervisor} />
          {asked ? <TakenOffAsk person={asked} busy={busy} onAnswer={(answer) => void addOne(undefined, answer)} /> : null}
          <Button kind="main" type="submit" busy={busy}>Add to the roster</Button>
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
              <p><strong>{count(toAdd.length, 'person', 'people')} to add.</strong></p>
              {toAdd.length ? (
                <ul className="small" style={{ display: 'grid', gap: '0.15rem' }}>
                  {toAdd.slice(0, 12).map((p) => (
                    <li key={nameKey(p)}>{p.lastName}, {p.firstName}{p.title ? `, ${p.title}` : ''}{p.role === 'supervisor' ? ', supervisor' : ''}{p.plan.kind === 'in_app' ? `, ${inAppWords(p, p.plan.person).replace(/\.$/, '').replace(/^In /, 'in ')}` : ''}</li>
                  ))}
                  {toAdd.length > 12 ? <li className="muted">and {toAdd.length - 12} more</li> : null}
                </ul>
              ) : null}
              {asks.map((p) => (
                <Seg<Answer>
                  key={nameKey(p)}
                  label={takenOffQuestion(p.person)}
                  showLabel
                  value={answers[nameKey(p)]}
                  onChange={(answer) => setAnswers((had) => ({ ...had, [nameKey(p)]: answer }))}
                  options={ANSWERS}
                />
              ))}
              {pasted.skipped.length || refused.length ? (
                <Notice tone="warn" title={`${count(pasted.skipped.length + refused.length, 'line')} passed over`}>
                  <ul className="small">
                    {pasted.skipped.map((s, i) => <li key={i}>{s.line}: {s.why}.</li>)}
                    {refused.map((p) => <li key={nameKey(p)}>{p.plan.kind === 'refused' ? p.plan.text : ''}</li>)}
                  </ul>
                </Notice>
              ) : null}
            </div>
          ) : null}
          <Button kind="main" busy={busy} disabled={toAdd.length === 0 || unanswered > 0} onClick={() => void addList()}>
            {toAdd.length ? `Add ${count(toAdd.length, 'person', 'people')}` : 'Add the list'}
          </Button>
          {unanswered ? <p className="small muted">Answer {unanswered === 1 ? 'the question' : `the ${unanswered} questions`} above, then add the list.</p> : null}
        </div>
      )}
      <ToldNotice told={told} onFinish={finish} />
    </section>
  );
}

/** Rows of the sign-in roster nobody in the app is for: they can join, and no phone has them yet. */
function NotInApp() {
  const ctx = useCompany();
  const app = useAppRoster();
  const { told, tell } = useTell();
  const [busy, once] = useBusy();
  const [asking, setAsking] = useState<{ rowId: string; person: Employee } | null>(null);
  const rows = app.known ? notInApp(ctx.roster, app.people) : [];
  if (rows.length === 0 && !told) return null;

  const add = (row: RosterRow, answer?: Answer) =>
    once(async () => {
      if (!app.rosters) return tell(() => Promise.resolve(PEOPLE_NOT_LOADED));
      const plan = planAdd(app.rosters, rowPerson(row), row.id);
      if (plan.kind === 'ask' && !answer) {
        setAsking({ rowId: row.id, person: plan.person });
        return;
      }
      setAsking(null);
      await tell(() => app.run(() => addToApp(app.io, app.rosters!, row, plan, answer, app.ids)));
    });

  return (
    <section className="section" aria-labelledby="not-in-app-title">
      <h2 className="h2" id="not-in-app-title" tabIndex={-1}>On the sign-in roster, not in the app</h2>
      <p className="section-note">They can join the company with the company code, but no phone has them on its roster until they are on the app’s roster too.</p>
      <ToldNotice told={told} />
      {rows.length ? (
        <Ledger>
          <thead><tr><th scope="col">Name</th><th scope="col">Job title</th><th scope="col">Role</th><th scope="col" data-nolabel><span className="sr-only">Add</span></th></tr></thead>
          <tbody>
            {rows.flatMap((row) => {
              const out = [
                <tr key={row.id}>
                  <th scope="row">{rowName(row)}</th>
                  <td>{row.title ?? ''}</td>
                  <td>{row.role === 'supervisor' ? 'Supervisor' : 'Crew'}</td>
                  <td className="r"><Button kind="line" small busy={busy} onClick={() => void add(row)}>Add to the app’s roster<span className="sr-only">: {rowName(row)}</span></Button></td>
                </tr>,
              ];
              if (asking?.rowId === row.id) {
                out.push(
                  <tr key={`${row.id}-ask`} className="row-open">
                    <td colSpan={4}><TakenOffAsk person={asking.person} busy={busy} onAnswer={(answer) => void add(row, answer)} /></td>
                  </tr>,
                );
              }
              return out;
            })}
          </tbody>
        </Ledger>
      ) : null}
    </section>
  );
}

/** Take someone off the app's roster alone, asked first: about their shift when they are on the clock. */
function TakeOffApp({ person, tell, app }: { person: Employee; tell: Tell; app: AppRoster }) {
  const ctx = useCompany();
  const name = personName(person);
  const since = onTheClock(person.id, ctx.shaped.data.shifts, ctx.now, ctx.shaped.company);
  return (
    <Confirm
      small
      kind="danger"
      label="Take off the app’s roster"
      name={`Take ${name} off the app’s roster`}
      question={since !== null ? clockQuestion(name, since) : offAppQuestion(name)}
      yes={since !== null ? CLOCK_ANSWERS.yes : 'Take them off'}
      no={since !== null ? CLOCK_ANSWERS.no : undefined}
      onYes={() => tell(() => app.run(() => takeOffApp(app.io, person)))}
    />
  );
}

function FromThePhones() {
  const ctx = useCompany();
  const app = useAppRoster();
  const { act, error, done } = useAct();
  const { told, tell } = useTell();
  const [busy, once] = useBusy();
  const missing = phonesNotOnRoster(ctx.shaped.data.employees, ctx.roster, ctx.shaped.placeholders);
  if (missing.length === 0 && !told) return null;
  const put = (people: typeof missing) =>
    once(() =>
      act(
        () => addToRoster(ctx.choice.id, people.map((e) => ({ firstName: e.firstName, lastName: e.lastName, title: e.title, role: e.role }))),
        `${count(people.length, 'person', 'people')} put on the sign-in roster.`,
      ),
    );
  return (
    <section className="section" aria-labelledby="phones-title">
      <div className="section-head">
        <h2 className="h2" id="phones-title">On the phones, not on the sign-in roster</h2>
        {missing.length > 1 ? <Button kind="ink" small busy={busy} onClick={() => void put(missing)}>Put all {missing.length} on the sign-in roster</Button> : null}
      </div>
      <p className="section-note">People on the app’s roster with no row on the sign-in roster. Until a name is on the sign-in roster too, that person cannot join the company under it. Someone who should not be on the phones at all comes off the app’s roster here.</p>
      {error ? <Notice tone="bo" live>{error}</Notice> : null}
      {done ? <Notice tone="ok" live>{done}</Notice> : null}
      <ToldNotice told={told} />
      {missing.length ? <Ledger>
          <thead><tr><th scope="col">Name</th><th scope="col">Job title</th><th scope="col">Role</th><th scope="col" data-nolabel><span className="sr-only">Add</span></th></tr></thead>
          <tbody>
            {missing.map((e) => (
              <tr key={e.id}>
                <th scope="row">{e.lastName}, {e.firstName}</th>
                <td>{e.title ?? ''}</td>
                <td>{e.role === 'supervisor' ? 'Supervisor' : 'Crew'}</td>
                <td className="r">
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button kind="line" small busy={busy} onClick={() => void put([e])}>Put on the sign-in roster<span className="sr-only">: {e.lastName}, {e.firstName}</span></Button>
                    <TakeOffApp person={e} tell={tell} app={app} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </Ledger> : null}
    </section>
  );
}

/** People whose row was taken off the sign-in roster and who are still on the app's roster, and so on every phone. */
function OffRosterInApp() {
  const ctx = useCompany();
  const app = useAppRoster();
  const { told, tell } = useTell();
  const left = app.known ? offRosterInApp(ctx.shaped.data.employees, ctx.roster, ctx.shaped.placeholders) : [];
  if (left.length === 0 && !told) return null;
  return (
    <section className="section" aria-labelledby="off-in-app-title">
      <h2 className="h2" id="off-in-app-title">Off the sign-in roster, still in the app</h2>
      <p className="section-note">Their row was taken off the sign-in roster, but every phone still has them on its roster. Take them off the app’s roster too, or put their row back on: show the people taken off, above.</p>
      <ToldNotice told={told} />
      {left.length ? (
        <Ledger>
          <thead><tr><th scope="col">Name</th><th scope="col">Job title</th><th scope="col">Role</th><th scope="col" data-nolabel><span className="sr-only">Take off</span></th></tr></thead>
          <tbody>
            {left.map((e) => (
              <tr key={e.id}>
                <th scope="row">{e.lastName}, {e.firstName}</th>
                <td>{e.title ?? ''}</td>
                <td>{e.role === 'supervisor' ? 'Supervisor' : 'Crew'}</td>
                <td className="r"><TakeOffApp person={e} tell={tell} app={app} /></td>
              </tr>
            ))}
          </tbody>
        </Ledger>
      ) : null}
    </section>
  );
}

const byName = (a: Employee, b: Employee) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);

/** Each person's payroll ID, for the hours file: only for a company that keeps time. The Payroll page links here. */
function PayrollIds() {
  const ctx = useCompany();
  const app = useAppRoster();
  const ref = useRef<HTMLElement>(null);
  const shown = keepsTime(ctx.shaped.company) && app.known;
  useEffect(() => {
    if (shown && window.location.hash === '#payroll-ids') ref.current?.scrollIntoView({ block: 'start' });
  }, [shown]);
  if (!shown) return null;
  const people = app.people.filter((e) => e.active).sort(byName);
  const without = people.filter((e) => !e.payrollId).length;
  return (
    <section className="section" id="payroll-ids" ref={ref} tabIndex={-1} aria-labelledby="payroll-ids-title">
      <div className="section-head">
        <h2 className="h2" id="payroll-ids-title">Payroll IDs</h2>
        <span className="section-note">{without ? `${count(without, 'person', 'people')} with none yet.` : 'Everyone has one.'}</span>
      </div>
      <p className="section-note">Each person’s number in the company’s payroll system, which the hours file carries. Only a supervisor’s phone holds payroll IDs.</p>
      {people.length ? (
        <div className="form-grid">
          {people.map((person) => <PayrollIdField key={person.id} person={person} app={app} />)}
        </div>
      ) : (
        <p className="small muted">Nobody is on the app’s roster yet.</p>
      )}
    </section>
  );
}

function PayrollIdField({ person, app }: { person: Employee; app: AppRoster }) {
  // A field nobody touched follows a newer version of the person; one that was typed in stays as typed.
  const { fields, set, dirty, restart } = useFormFields({ id: person.payrollId ?? '' });
  const [told, setTold] = useState<Told | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const result = await app.run(() => savePayrollId(app.io, app.people, person, fields.id));
      setTold(result);
      if (result.tone === 'ok') restart({ id: fields.id.trim() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" style={{ gap: '0.4rem' }} onSubmit={save} noValidate>
      <div className="row" style={{ alignItems: 'end', flexWrap: 'nowrap' }}>
        <TextField
          label={`Payroll ID for ${person.lastName}, ${person.firstName}`}
          value={fields.id}
          onChange={(id) => {
            set({ id });
            setTold(null);
          }}
          maxLength={20}
          hint={person.title}
          error={told?.tone === 'bo' ? told.text : undefined}
        />
        <Button kind="line" small type="submit" disabled={!dirty} busy={busy}>Save<span className="sr-only"> the payroll ID for {personName(person)}</span></Button>
      </div>
      {told && told.tone !== 'bo' ? <ToldNotice told={told} keepFocus /> : null}
    </form>
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
      <p className="small muted">{KEEP_OUT_NOTE}</p>
    </section>
  );
}
