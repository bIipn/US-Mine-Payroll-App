import { keepsTime, type Company } from '@app/domain/company';
import { listed } from '@app/domain/receive';
import { addedPerson, findOnRoster, payrollIdProblem, sameName, type PersonName } from '@app/domain/roster';
import { rulesFor } from '@app/domain/stateRules';
import { stableJson } from '@app/domain/sync';
import type { Employee, Role, Shift } from '@app/domain/types';
import { fmtDateTime } from '@app/util/format';
import { uid } from '@app/util/hash';

import type { NewRosterRow } from './api';
import { refusalWords } from './changes';
import { messageOf } from './errors';
import { matchRows, type RowMatch } from './rosterTools';
import type { RosterRow } from './server';

/**
 * The Roster page writes a person in two places: the sign-in row on the
 * server, which says who may join the company, and the person in the app's
 * roster, the `employee` record every phone receives. A connected phone no
 * longer changes people, so this page is where they are added, taken off and
 * given a role, a job title or a payroll ID.
 *
 * Each change writes the two in an order that never says the wrong thing when
 * the second fails: an addition puts the sign-in row in first, so nobody is on
 * the phones who cannot join; a change or a taking off writes the person first,
 * from the version the page loaded (the server refuses one made from an older
 * version), and the row after. Whatever is left half done is said, with what
 * finishes it. Which person a row is for is `matchRows` (one person to a row);
 * the rules for a person are the app's own (`addedPerson`, `payrollIdProblem`
 * in src/domain/roster.ts).
 */

// ---- The words ---------------------------------------------------------------------------------------

export const ROSTER_LEDE =
  'The sign-in roster, and the roster in the app. People are added, taken off and given a role or a payroll ID here; phones have the change the next time they are open with signal.';

/** The same, for a company that keeps no time: it has no payroll IDs. */
export const ROSTER_LEDE_SAFETY_ONLY =
  'The sign-in roster, and the roster in the app. People are added, taken off and given a role here; phones have the change the next time they are open with signal.';

/** Said after a save of a person, and only then: a change to the sign-in row alone reaches no phone. */
export const PEOPLE_SAVED = 'Saved. Phones get it the next time they are open with signal.';

/**
 * Said, and nothing written, when the company's records are not loaded: the
 * page cannot tell who is in the app, and a person added blind could be a
 * second one of the same name.
 */
export const PEOPLE_NOT_LOADED: Told = {
  tone: 'bo',
  text: 'The app’s roster is not loaded, so nothing was changed: the sign-in roster and the app’s roster are written together. Load new records, then try again.',
};

/** Said after a payroll ID is saved: only a supervisor's phone holds one. */
const PAYROLL_REACH = 'Supervisors’ phones get it the next time they are open with signal; crew phones never hold payroll IDs.';

/** "Sam Ortiz" */
export const personName = (p: PersonName) => `${p.firstName} ${p.lastName}`;

/** A sign-in row's name, as a name the app's rules match. */
export const rowPerson = (row: Pick<RosterRow, 'first_name' | 'last_name'>): PersonName => ({ firstName: row.first_name, lastName: row.last_name });

const rowName = (row: Pick<RosterRow, 'first_name' | 'last_name'>) => personName(rowPerson(row));

export const takenOffQuestion = (p: PersonName) => `${personName(p)}, who was taken off the roster, has this name. Bring them back, or add a new person?`;

export const twoPeopleWords = (name: string) => `Two people in the app are called ${name}. Tell them apart on the sign-in roster first, by a middle initial.`;

/** Said of a row two people in the app are called by, when only the row was changed. */
export const twoNotChangedWords = (name: string) => `Two people in the app are called ${name}, so the app’s roster was not changed.`;

/** A typed name the sign-in roster has already: a second row of it and nobody could join under the name. */
export const onRosterWords = (name: string) => `${name} is on the sign-in roster already. To change them, use Change beside their name.`;

/** A typed name of a row taken off: that row is put back on, with the person it was for. */
export const offRosterWords = (name: string) => `${name} was taken off the sign-in roster. To bring them back, show the people taken off, then Put back on.`;

/** Said of an addition the app had the person for already: only the sign-in row was written. */
export const inAppWords = (typed: PersonName, person: PersonName) =>
  sameName(person, typed.firstName, typed.lastName) ? 'In the app already.' : `In the app already as ${personName(person)}.`;

/** Said when the sign-in row went in and the person did not. */
export const notInAppWords = (names: readonly string[]) =>
  names.length === 1
    ? `${names[0]} is on the sign-in roster but not in the app yet, so phones do not have them. Add them to the app’s roster to finish.`
    : `${listed(names)} are on the sign-in roster but not in the app yet, so phones do not have them. Add them to the app’s roster to finish.`;

/** The button that finishes a half-done addition. */
export const ADD_TO_APP = 'Add to the app’s roster';

/** Said when the server would not write the person over the version this page loaded. */
export const personRefusedWords = (name: string) => refusalWords('superseded', name);

/** Said when the person was changed and the sign-in row was not. */
export const rowNotChangedWords = (name: string, field: 'role' | 'title') =>
  `${name}’s ${field === 'role' ? 'role' : 'job title'} is changed in the app but not on the sign-in roster. Change it again to finish.`;

const rowNotBackWords = (name: string) => `${name} is back on the app’s roster but not on the sign-in roster. Put them back on again to finish.`;

/** Said when the person is off the app's roster and their sign-in row is still there. */
export const rowStillOnWords = (name: string) =>
  `${name} is off the app’s roster but still on the sign-in roster, so their sign-in still reads the company’s records. Remove the row again to finish.`;

/** Said when another active row has the same person: the row goes, the person stays. */
export const sharedRowWords = (name: string) => `Another row on the sign-in roster has the same name, so ${name} stays on the app’s roster.`;

/** Said when someone was taken off the sign-in roster while the app's roster was not loaded. */
export const notLoadedOffWords = (name: string) =>
  `The app’s roster is not loaded, so ${name} is still on it and on the phones. Once the records load, take them off it too: they are listed below the sign-in roster.`;

/** Said when a supervisor was made crew on the sign-in roster while the app's roster was not loaded. */
export const notLoadedCrewWords = (name: string) =>
  `The app’s roster is not loaded, so it still has ${name} as a supervisor. Once the records load, use Make both crew beside their name.`;

/** Asked before someone on the clock is taken off. */
export const clockQuestion = (name: string, since: number) =>
  `${name} is on the clock since ${fmtDateTime(since)}, as far as their phone has sent. Their clock-out reaches the company only while they are on the roster. Take them off after their shift?`;

export const CLOCK_ANSWERS = { yes: 'Take off now', no: 'Cancel' } as const;

/** Asked before someone is taken off the app's roster alone. */
export const offAppQuestion = (name: string) => `${name} comes off every phone’s roster. Their records stay theirs.`;

const roleWord = (role: Role) => (role === 'supervisor' ? 'Supervisor' : 'Crew');

/**
 * The server's reason for the part of a change that was not done, when the
 * part before it was saved: its "Nothing was saved" is left out, so the page
 * never says that beside what was.
 */
export function halfWhy(text: string): string {
  return text
    .replace(/^Nothing was saved: (.)/, (_all, first: string) => first.toUpperCase())
    .replace(/\s*Nothing was saved\.\s*/g, ' ')
    .trim();
}

// ---- Who is who ----------------------------------------------------------------------------------------

/** What the page knows of the two rosters. */
export interface Rosters {
  /** The people in the app's roster, as the records hold them, taken off or not. */
  people: readonly Employee[];
  /** People a page names only from the sign-in row of the account that sent their hours. */
  named: readonly Employee[];
  /** The sign-in roster, rows taken off included. */
  rows: readonly RosterRow[];
}

/** The people in the app's roster, as the records hold them: not the ones a page names only for their hours. */
export function appPeople(employees: readonly Employee[], placeholders: ReadonlySet<string>): Employee[] {
  return employees.filter((e) => !placeholders.has(e.id));
}

const NONE: RowMatch = { kind: 'none' };

/** Who in the app a row is for, one person to a row (`matchRows`). */
export function matchOf(rosters: Pick<Rosters, 'people' | 'rows'>, rowId: string): RowMatch {
  return matchRows(rosters.rows, rosters.people).get(rowId) ?? NONE;
}

/** The active sign-in rows nobody in the app is for: they can join, and no phone has them. */
export function notInApp(rows: readonly RosterRow[], people: readonly Employee[]): RosterRow[] {
  const match = matchRows(rows, people);
  return rows.filter((row) => row.active && match.get(row.id)?.kind === 'none');
}

/** Someone taken off the app's roster whom a name fits: exactly, or the one it fits as a typed name does. */
function takenOffFit(people: readonly Employee[], name: PersonName): Employee | undefined {
  const off = people.filter((e) => !e.active);
  const exact = off.find((e) => sameName(e, name.firstName, name.lastName));
  if (exact) return exact;
  const hit = findOnRoster(off, name.firstName, name.lastName);
  return hit && 'person' in hit ? hit.person : undefined;
}

/** Where a row and its person disagree on the role, what the row says beside it, and the button that makes both the row's. */
export function roleMismatch(row: Pick<RosterRow, 'role'>, person: Employee | undefined): { line: string; label: string } | null {
  if (!person || person.role === row.role) return null;
  return { line: `Sign-in roster: ${roleWord(row.role)}. In the app: ${roleWord(person.role)}.`, label: `Make both ${roleWord(row.role).toLowerCase()}` };
}

/**
 * The start of a shift a person is on the clock for, as far as their phone has
 * sent: their newest shift, when it has no clock-out and began less than the
 * company's rules give a shift before its clock-out counts as missing (16
 * hours). A shift left open longer is a clock-out never sent, not someone at
 * work. A clock-in after the page last read the time counts: a phone's clock
 * can run a little ahead. A company that keeps no time has nobody on the clock.
 */
export function onTheClock(employeeId: string, shifts: readonly Shift[], now: number, company: Company): number | null {
  if (!keepsTime(company)) return null;
  let newest: Shift | undefined;
  for (const s of shifts) if (s.employeeId === employeeId && (!newest || s.clockIn.at > newest.clockIn.at)) newest = s;
  if (!newest || newest.clockOut) return null;
  const since = newest.clockIn.at;
  return now - since < rulesFor(company.state).missingOutAfterMs ? since : null;
}

// ---- Adding ----------------------------------------------------------------------------------------------

/** What adding a name does to the app's roster, worked out before anything is written. */
export type AddPlan =
  /** A new person; under `id` when a page already names someone of this name for their hours. */
  | { kind: 'new'; id?: string }
  /** Someone in the app already: only the sign-in row is written. */
  | { kind: 'in_app'; person: Employee }
  /** Someone taken off the roster has the name: bring them back, or add a new person (under `id`, as for `new`). */
  | { kind: 'ask'; person: Employee; id?: string }
  | { kind: 'refused'; text: string };

/** The answer to `takenOffQuestion`. */
export type Answer = 'back' | 'new';

/** The id a typed name's row is matched under while it is not on the sign-in roster yet. */
const NEW_ROW = '\u0000new row';

const newRow = (name: PersonName): RosterRow => ({
  id: NEW_ROW,
  company_id: '',
  first_name: name.firstName,
  last_name: name.lastName,
  title: null,
  role: 'employee',
  active: true,
  user_id: null,
  claimed_at: null,
  created_at: '',
});

/**
 * What adding this name would do. Without `rowId` it is a name typed in, for
 * a new row: a name the sign-in roster has already is turned down. With it, it
 * is the name of a row already there. The person the row would be for is the
 * one `matchRows` gives it, beside every other row; a page that names someone
 * of this name only for their hours adds them under the id their hours carry.
 */
export function planAdd(rosters: Rosters, name: PersonName, rowId?: string): AddPlan {
  if (rowId === undefined) {
    const same = rosters.rows.filter((r) => sameName(rowPerson(r), name.firstName, name.lastName));
    const on = same.find((r) => r.active);
    if (on) return { kind: 'refused', text: onRosterWords(rowName(on)) };
    if (same.length) return { kind: 'refused', text: offRosterWords(rowName(same[0])) };
  }
  const match = rowId === undefined ? matchOf({ people: rosters.people, rows: [...rosters.rows, newRow(name)] }, NEW_ROW) : matchOf(rosters, rowId);
  if (match.kind === 'two') return { kind: 'refused', text: twoPeopleWords(match.name) };
  if (match.kind === 'person') return { kind: 'in_app', person: match.person };
  const named = rosters.named.find((p) => sameName(p, name.firstName, name.lastName));
  const off = takenOffFit(rosters.people, name);
  if (off) return { kind: 'ask', person: off, ...(named ? { id: named.id } : null) };
  return named ? { kind: 'new', id: named.id } : { kind: 'new' };
}

/** A new person's id, made the way the app makes one. */
export const newPersonId = () => uid('emp_');

/**
 * The id a new person of a name is saved under. It is kept until a save of
 * them is confirmed, so a second press, or a try again after an answer was
 * lost, writes the same person and never a second one of the name.
 */
export interface Ids {
  idFor: (name: PersonName) => string;
  saved: (name: PersonName) => void;
}

const nameKey = (p: PersonName) => `${p.lastName.trim().toLowerCase()}|${p.firstName.trim().toLowerCase()}`;

export function keptIds(make: () => string = newPersonId): Ids {
  const ids = new Map<string, string>();
  return {
    idFor: (name) => {
      const key = nameKey(name);
      const had = ids.get(key);
      if (had) return had;
      const id = make();
      ids.set(key, id);
      return id;
    },
    saved: (name) => {
      ids.delete(nameKey(name));
    },
  };
}

/**
 * One run at a time: a press while the last is still under way does nothing
 * and gives back undefined. The pages' buttons that write people use one, so
 * a double click never writes twice.
 */
export function oneAtATime() {
  let running = false;
  return async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    if (running) return undefined;
    running = true;
    try {
      return await work();
    } finally {
      running = false;
    }
  };
}

export interface Typed extends PersonName {
  title?: string;
  role: Role;
}

export interface Adding extends Typed {
  plan: AddPlan;
  answer?: Answer;
}

/** A person, with this job title or with none: an empty title is no title at all. */
function withTitle(person: Employee, title: string | null | undefined): Employee {
  const { title: _old, ...rest } = person;
  return title ? { ...rest, title } : rest;
}

/** The person to write for an addition, or what stops it. */
function personFor(rosters: Rosters, add: Adding, ids: Ids): { ok: true; person: Employee | null } | { ok: false; text: string } {
  const { plan } = add;
  if (plan.kind === 'refused') return { ok: false, text: plan.text };
  if (plan.kind === 'in_app') return { ok: true, person: null };
  if (plan.kind === 'ask' && !add.answer) {
    return { ok: false, text: `Answer the question about ${personName(plan.person)} first: bring them back, or add a new person.` };
  }
  if (plan.kind === 'ask' && add.answer === 'back') {
    // Brought back with the row's role and title, none included: their id, payroll ID and records stay theirs.
    const back = addedPerson([plan.person], plan.person.firstName, plan.person.lastName, add.role, add.title, plan.person.id);
    return back.ok ? { ok: true, person: withTitle(back.employee, add.title) } : { ok: false, text: back.error };
  }
  const made = addedPerson(rosters.people.filter((e) => e.active), add.firstName, add.lastName, add.role, add.title, plan.id ?? ids.idFor(add));
  return made.ok ? { ok: true, person: made.employee } : { ok: false, text: made.error };
}

/** The writes the Roster page makes. The person goes through `saveRecord` (`useSaver`), with `revOf` and the version the page loaded as `base`. */
export interface PeopleWrites {
  savePerson: (person: Employee, what: string) => Promise<PersonSaved>;
  addRows: (rows: NewRosterRow[]) => Promise<unknown>;
  updateRow: (rowId: string, patch: RowPatch) => Promise<unknown>;
  deleteRow: (rowId: string) => Promise<unknown>;
}

/** What saving a person came back with (`SaveResult`): `changed` when a newer version stopped it, and the server's row then. */
export type PersonSaved = { ok: true } | { ok: false; changed: boolean; words: string; row?: unknown };

export type RowPatch = Partial<Pick<RosterRow, 'title' | 'role' | 'active'>>;

/** A name whose addition is to be finished, with the answer given for it. */
export interface Answered extends PersonName {
  answer?: Answer;
}

/** What the page says once it is done: `why` is what the server said about the part that is not, `finish` the button that finishes it. */
export interface Told {
  tone: 'ok' | 'warn' | 'bo';
  text: string;
  why?: string;
  finish?: { label: string; adds: Answered[] };
}

/** Why a person was not saved: someone else's newer version, or the server's own reason. */
function notSaved(result: Extract<PersonSaved, { ok: false }>, name: string): Told {
  // A newer version stopped it and the page now holds that one. Without a row, the server shows the person to this account no more: its own words say why.
  if (result.changed && result.row !== undefined) return { tone: 'warn', text: personRefusedWords(name) };
  return { tone: 'bo', text: result.words };
}

const answered = (adds: readonly Adding[]): Answered[] => adds.map((a) => ({ firstName: a.firstName, lastName: a.lastName, ...(a.answer ? { answer: a.answer } : null) }));

/** Said when rows went in and some people did not: who, why, and the button that adds them. */
function halfAdded(missed: readonly Adding[], why: string | undefined): Told {
  return { tone: 'warn', text: notInAppWords(missed.map(personName)), why, finish: { label: ADD_TO_APP, adds: answered(missed) } };
}

/**
 * Add people: one, or a pasted list. The sign-in rows go first, in one write;
 * then each person in the app, one at a time, the new ones under ids of their
 * own (`ids`) with no payroll ID. Someone the app has already gets only their
 * row. Nothing is written while a name is turned down, a question is
 * unanswered, or the sign-in roster has the name already.
 */
export async function addPeople(io: PeopleWrites, rosters: Rosters, adding: readonly Adding[], ids: Ids): Promise<Told> {
  const toWrite: { add: Adding; person: Employee }[] = [];
  for (const add of adding) {
    const there = rosters.rows.find((r) => sameName(rowPerson(r), add.firstName, add.lastName));
    if (there) return { tone: 'bo', text: there.active ? onRosterWords(rowName(there)) : offRosterWords(rowName(there)) };
    const made = personFor(rosters, add, ids);
    if (!made.ok) return { tone: 'bo', text: made.text };
    if (made.person) toWrite.push({ add, person: made.person });
  }
  try {
    await io.addRows(adding.map((a) => ({ firstName: a.firstName, lastName: a.lastName, title: a.title, role: a.role })));
  } catch (e) {
    return { tone: 'bo', text: messageOf(e) };
  }
  const missed: Adding[] = [];
  let why: string | undefined;
  for (const { add, person } of toWrite) {
    const name = personName(person);
    const result = await io.savePerson(person, name);
    if (result.ok) ids.saved(add);
    else {
      missed.push(add);
      why ??= halfWhy(notSaved(result, name).text);
    }
  }
  if (missed.length) return halfAdded(missed, why);
  const one = adding.length === 1 ? adding[0] : undefined;
  const who = one ? `${personName(one)} is` : `${adding.length} people are`;
  const inApp = one?.plan.kind === 'in_app' ? ` ${inAppWords(one, one.plan.person)}` : '';
  return { tone: 'ok', text: `${who} on the roster.${inApp}${toWrite.length ? ` ${PEOPLE_SAVED}` : ''}` };
}

/** Add the person a sign-in row is for to the app's roster: the row is there already, so only the person is written. */
export async function addToApp(io: PeopleWrites, rosters: Rosters, row: RosterRow, plan: AddPlan, answer: Answer | undefined, ids: Ids): Promise<Told> {
  const add: Adding = { ...rowPerson(row), role: row.role, title: row.title ?? undefined, plan, answer };
  const made = personFor(rosters, add, ids);
  if (!made.ok) return { tone: 'bo', text: made.text };
  const name = rowName(row);
  if (!made.person) return { tone: 'ok', text: `${name} is on the app’s roster. ${plan.kind === 'in_app' ? inAppWords(add, plan.person) : ''}`.trim() };
  const result = await io.savePerson(made.person, personName(made.person));
  if (!result.ok) return notSaved(result, personName(made.person));
  ids.saved(add);
  return { tone: 'ok', text: `${name} is on the app’s roster. ${PEOPLE_SAVED}` };
}

/**
 * Finish additions left half done: each name's row is on the sign-in roster
 * now, and its person is worked out again from the app's roster as it is,
 * with the answer given before. What is still not done is said again.
 */
export async function finishAdding(io: PeopleWrites, rosters: Rosters, adds: readonly Answered[], ids: Ids): Promise<Told> {
  const missed: Adding[] = [];
  let why: string | undefined;
  let saved = 0;
  for (const name of adds) {
    const row = rosters.rows.find((r) => r.active && sameName(rowPerson(r), name.firstName, name.lastName));
    if (!row) continue;
    const plan = planAdd(rosters, rowPerson(row), row.id);
    const told = await addToApp(io, rosters, row, plan, name.answer, ids);
    if (told.tone === 'ok') saved += 1;
    else {
      missed.push({ ...rowPerson(row), role: row.role, plan, answer: name.answer });
      why ??= halfWhy(told.text);
    }
  }
  if (missed.length) return halfAdded(missed, why);
  const who = adds.length === 1 ? `${personName(adds[0])} is` : `${adds.length} people are`;
  return { tone: 'ok', text: saved ? `${who} on the app’s roster. ${PEOPLE_SAVED}` : `${who} on the app’s roster.` };
}

/**
 * Someone let in on a new row of the sign-in roster, from their request: the
 * server wrote the row, and the person in the app is written after it, as for
 * any addition. Someone taken off with the name, or two people of it, is left
 * for the page's question, under On the sign-in roster, not in the app.
 */
export async function letInOnNewRow(io: PeopleWrites, rosters: Rosters | null, row: RosterRow, ids: Ids): Promise<Told> {
  const name = rowName(row);
  const letIn = `${name} is let in.`;
  const there = 'use Add to the app’s roster under On the sign-in roster, not in the app.';
  if (!rosters) return { tone: 'warn', text: `${letIn} ${notInAppWords([name])}`, why: `The app’s roster is not loaded: load new records, then ${there}` };
  const plan = planAdd(rosters, rowPerson(row), row.id);
  if (plan.kind === 'in_app') return { tone: 'ok', text: `${letIn} ${inAppWords(rowPerson(row), plan.person)}` };
  if (plan.kind === 'refused') return { tone: 'warn', text: `${letIn} ${notInAppWords([name])}`, why: plan.text };
  if (plan.kind === 'ask') {
    return { tone: 'warn', text: `${letIn} ${notInAppWords([name])}`, why: `${personName(plan.person)}, who was taken off the roster, has this name, so the page asks first: ${there}` };
  }
  const told = await addToApp(io, rosters, row, plan, undefined, ids);
  if (told.tone === 'ok') return { tone: 'ok', text: `${name} is let in, and on the app’s roster. ${PEOPLE_SAVED}` };
  return { ...halfAdded([{ ...rowPerson(row), role: row.role, plan }], halfWhy(told.text)), text: `${letIn} ${notInAppWords([name])}` };
}

// ---- Changing a row --------------------------------------------------------------------------------------

const same = (a: object, b: object) => stableJson(a) === stableJson(b);

/** Write the sign-in row alone, and say `text` when it is written. */
async function rowAlone(io: PeopleWrites, row: RosterRow, patch: RowPatch, text: string): Promise<Told> {
  try {
    await io.updateRow(row.id, patch);
  } catch (e) {
    return { tone: 'bo', text: messageOf(e) };
  }
  return { tone: 'warn', text };
}

/**
 * Change a row's role, job title, or put it back on the sign-in roster. The
 * person first, from the version the page loaded, then the row. A row put back
 * brings back the person taken off whom it fits, with the row's role and title.
 * `done` is what to say when it is done.
 *
 * With `rosters` null, the app's roster is not loaded, and only making a
 * supervisor crew goes ahead, on the sign-in roster alone: it takes away what
 * the sign-in can see, which must not wait. A row two people in the app are
 * called by is the same: crew on the sign-in roster, nothing else changed.
 */
export async function changeRow(io: PeopleWrites, rosters: Rosters | null, row: RosterRow, patch: RowPatch, done: string): Promise<Told> {
  const name = rowName(row);
  const makingCrew = patch.role === 'employee' && patch.title === undefined && patch.active === undefined;
  if (!rosters) return makingCrew ? rowAlone(io, row, patch, `${done} ${notLoadedCrewWords(name)}`) : PEOPLE_NOT_LOADED;

  let next: Employee | undefined;
  if (patch.active === true) {
    const match = matchOf({ people: rosters.people, rows: rosters.rows.map((r) => (r.id === row.id ? { ...r, active: true } : r)) }, row.id);
    if (match.kind === 'two') return { tone: 'bo', text: twoPeopleWords(match.name) };
    const off = match.kind === 'none' ? takenOffFit(rosters.people, rowPerson(row)) : undefined;
    if (off) {
      const role = patch.role ?? row.role;
      const title = patch.title !== undefined ? patch.title : row.title;
      const back = addedPerson([off], off.firstName, off.lastName, role, title ?? undefined, off.id);
      if (back.ok) next = withTitle(back.employee, title);
    }
  } else {
    const match = matchOf(rosters, row.id);
    if (match.kind === 'two') return makingCrew ? rowAlone(io, row, patch, `${done} ${twoNotChangedWords(match.name)}`) : { tone: 'bo', text: twoPeopleWords(match.name) };
    if (match.kind === 'person') {
      const person = match.person;
      let changed = person;
      if (patch.role) changed = { ...changed, role: patch.role };
      if (patch.title !== undefined) changed = withTitle(changed, patch.title);
      if (!same(changed, person)) next = changed;
    }
  }

  if (next) {
    const result = await io.savePerson(next, personName(next));
    if (!result.ok) return notSaved(result, personName(next));
  }
  try {
    await io.updateRow(row.id, patch);
  } catch (e) {
    if (!next) return { tone: 'bo', text: messageOf(e) };
    const half = patch.active === true ? rowNotBackWords(name) : rowNotChangedWords(name, patch.role ? 'role' : 'title');
    return { tone: 'warn', text: half, why: messageOf(e) };
  }
  return { tone: 'ok', text: next ? `${done} ${PEOPLE_SAVED}` : done };
}

/**
 * Take someone off the roster: the person off the app's roster first (never
 * deleted: their records stay theirs), then the row, removed, or switched off
 * when an account joined on it. A person another active row is for too stays
 * on the app's roster.
 *
 * With `rosters` null, the app's roster is not loaded: the row goes on its own,
 * since what a sign-in can see must not wait, and the page says the person is
 * still in the app. A row two people in the app are called by goes on its own
 * as well.
 */
export async function takeOff(io: PeopleWrites, rosters: Rosters | null, row: RosterRow, done: string): Promise<Told> {
  const name = rowName(row);
  const match = rosters ? matchOf(rosters, row.id) : NONE;
  const person = match.kind === 'person' && !match.shared ? match.person : undefined;
  if (person) {
    const result = await io.savePerson({ ...person, active: false }, personName(person));
    if (!result.ok) return notSaved(result, personName(person));
  }
  try {
    if (row.user_id) await io.updateRow(row.id, { active: false });
    else await io.deleteRow(row.id);
  } catch (e) {
    if (!person) return { tone: 'bo', text: messageOf(e) };
    return { tone: 'warn', text: rowStillOnWords(name), why: messageOf(e) };
  }
  if (!rosters) return { tone: 'warn', text: `${done} ${notLoadedOffWords(name)}` };
  if (match.kind === 'two') return { tone: 'warn', text: `${done} ${twoNotChangedWords(match.name)}` };
  if (match.kind === 'person' && match.shared) return { tone: 'ok', text: `${done} ${sharedRowWords(name)}` };
  return { tone: 'ok', text: person ? `${done} ${PEOPLE_SAVED}` : done };
}

/** Take someone off the app's roster alone: a person no active row is for. Never deleted: their records stay theirs. */
export async function takeOffApp(io: PeopleWrites, person: Employee): Promise<Told> {
  const name = personName(person);
  const result = await io.savePerson({ ...person, active: false }, name);
  if (!result.ok) return notSaved(result, name);
  return { tone: 'ok', text: `${name} is off the app’s roster. ${PEOPLE_SAVED}` };
}

/** Make the person's role the sign-in row's: the row already says it, so only the person is written. */
export async function makeBoth(io: PeopleWrites, person: Employee, role: Role): Promise<Told> {
  const name = personName(person);
  const result = await io.savePerson({ ...person, role }, name);
  if (!result.ok) return notSaved(result, name);
  return { tone: 'ok', text: `${name} is ${role === 'supervisor' ? 'a supervisor' : 'crew'} in the app now. ${PEOPLE_SAVED}` };
}

// ---- Payroll IDs -----------------------------------------------------------------------------------------

/** Save a person's payroll ID, checked by the app's own rule against everyone in the app. Empty takes it off. */
export async function savePayrollId(io: PeopleWrites, people: readonly Employee[], person: Employee, typed: string): Promise<Told> {
  const id = typed.trim();
  const problem = payrollIdProblem(people, person.id, id);
  if (problem) return { tone: 'bo', text: problem };
  const { payrollId: _old, ...rest } = person;
  const next: Employee = id ? { ...rest, payrollId: id } : rest;
  const name = personName(person);
  const result = await io.savePerson(next, name);
  if (!result.ok) return notSaved(result, name);
  return { tone: 'ok', text: id ? `Payroll ID ${id} is saved for ${name}. ${PAYROLL_REACH}` : `${name} has no payroll ID now. ${PAYROLL_REACH}` };
}
