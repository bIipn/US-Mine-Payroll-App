import { cleanText, findOnRoster, parsePersonName, personForRow, sameName, type PersonName } from '@app/domain/roster';
import type { Employee, Role } from '@app/domain/types';

import type { JoinReason, JoinRequestRow, RosterRow } from './server';

/**
 * The sign-in roster on the server (who may join the company) beside the
 * app's roster, the employee records every phone receives. The Roster page
 * writes both; these work out which person each row is for, and where the two
 * differ.
 */

const asPerson = (row: RosterRow): PersonName & { row: RosterRow } => ({ firstName: row.first_name, lastName: row.last_name, row });

const byName = (a: Employee, b: Employee) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);

// ---- Which person each row is for ----------------------------------------------------------------

/** Who in the app an active sign-in row is for. */
export type RowMatch =
  /** `exact`: the row has their name exactly. `shared`: another active row is theirs too, written exactly alike. */
  | { kind: 'person'; person: Employee; exact: boolean; shared: boolean }
  /** Two people in the app, or more, have the row's name exactly: it is not one person's. */
  | { kind: 'two'; name: string; people: Employee[] }
  | { kind: 'none' };

const NONE: RowMatch = { kind: 'none' };

/**
 * Which person in the app each active sign-in row is for, one person to a row.
 * A row has the person the app's rule gives it (`personForRow`: their name
 * exactly, else the one person it fits), except that a row that only fits
 * someone may not have a person another row names exactly, or fits as well:
 * "Sam Ortiz" is not "Sam Ortiz Jr" while the son has a row of his own. A
 * person still free whose name, typed, fits one free row is that row's (a row
 * "Riley J Quinn" for a person "Riley Quinn"). Rows written exactly alike are
 * all the one person's. Only people on the app's roster are matched, never one
 * taken off.
 */
export function matchRows(rows: readonly RosterRow[], people: readonly Employee[]): Map<string, RowMatch> {
  const active = people.filter((e) => e.active);
  const live = rows.filter((r) => r.active);
  const out = new Map<string, RowMatch>();
  // The rows that have each person exactly, and the people two of a name are.
  const exactly = new Map<string, number>();
  const twins = new Set<string>();
  const loose: { row: RosterRow; person: Employee }[] = [];
  for (const row of live) {
    const same = active.filter((e) => sameName(e, row.first_name, row.last_name));
    if (same.length > 1) {
      out.set(row.id, { kind: 'two', name: `${same[0].firstName} ${same[0].lastName}`, people: same });
      for (const e of same) twins.add(e.id);
    } else if (same.length === 1) {
      out.set(row.id, { kind: 'person', person: same[0], exact: true, shared: false });
      exactly.set(same[0].id, (exactly.get(same[0].id) ?? 0) + 1);
    } else {
      const person = personForRow(active, { firstName: row.first_name, lastName: row.last_name });
      if (person) loose.push({ row, person });
    }
  }
  for (const [id, m] of out) if (m.kind === 'person' && (exactly.get(m.person.id) ?? 0) > 1) out.set(id, { ...m, shared: true });
  const free = (person: Employee) => !exactly.has(person.id) && !twins.has(person.id);
  for (const { row, person } of loose) {
    const alone = free(person) && !loose.some((l) => l.row.id !== row.id && l.person.id === person.id);
    out.set(row.id, alone ? { kind: 'person', person, exact: false, shared: false } : NONE);
  }
  for (const row of live) if (!out.has(row.id)) out.set(row.id, NONE);

  // The other way round: a person nobody has yet whose name fits one row nobody has.
  const had = new Set([...out.values()].flatMap((m) => (m.kind === 'person' ? [m.person.id] : [])));
  const on = live.map(asPerson);
  const back: { row: RosterRow; person: Employee }[] = [];
  for (const person of active) {
    if (had.has(person.id) || twins.has(person.id)) continue;
    const hit = findOnRoster(on, person.firstName, person.lastName);
    if (hit && 'person' in hit && out.get(hit.person.row.id)?.kind === 'none') back.push({ row: hit.person.row, person });
  }
  for (const { row, person } of back) {
    if (back.some((b) => b.row.id === row.id && b.person.id !== person.id)) continue;
    out.set(row.id, { kind: 'person', person, exact: false, shared: false });
  }
  return out;
}

/** Everyone in the app an active row is for, the people two of a name are included. */
function heldByRows(rows: readonly RosterRow[], people: readonly Employee[]): Set<string> {
  const held = new Set<string>();
  for (const m of matchRows(rows, people).values()) {
    if (m.kind === 'person') held.add(m.person.id);
    else if (m.kind === 'two') for (const e of m.people) held.add(e.id);
  }
  return held;
}

export interface PastedPerson extends PersonName {
  title?: string;
  role: Role;
}

export interface PastedList {
  add: PastedPerson[];
  /** Lines that were passed over, and why. */
  skipped: { line: string; why: string }[];
}

/**
 * A pasted list, one person to a line: the name ("Last, First" or "First
 * Last"), then the job title, then "supervisor" for a supervisor, with a bar
 * between them, the same as a build's roster setting:
 *
 *     Ortiz, Sam | Crusher
 *     Quinn, Riley J | Maintenance | supervisor
 *
 * A person already on the roster, or named twice, is passed over and listed.
 */
export function readPastedRoster(text: string, roster: RosterRow[]): PastedList {
  const add: PastedPerson[] = [];
  const skipped: PastedList['skipped'] = [];
  const on = roster.map(asPerson);
  for (const raw of text.replace(/\\n/g, '\n').split(/\r?\n/)) {
    const line = cleanText(raw);
    if (!line) continue;
    const [name = '', title = '', role = ''] = line.split('|').map(cleanText);
    const person = parsePersonName(name);
    if (!person) {
      skipped.push({ line, why: 'Not a first and last name' });
      continue;
    }
    if (on.some((p) => sameName(p, person.firstName, person.lastName))) {
      skipped.push({ line, why: 'Already on the roster' });
      continue;
    }
    if (add.some((p) => sameName(p, person.firstName, person.lastName))) {
      skipped.push({ line, why: 'Named twice in the list' });
      continue;
    }
    if (role && role.toLowerCase() !== 'supervisor') {
      skipped.push({ line, why: `“${role}” is not a role. Write supervisor, or leave it off for crew` });
      continue;
    }
    add.push({ ...person, ...(title ? { title } : null), role: role ? 'supervisor' : 'employee' });
  }
  return { add, skipped };
}

/**
 * The people on the app's roster with no row on the sign-in roster, so they
 * could not join the company with their own name. A person a row is for
 * (`matchRows`) is on it. So is one a row could be: a name that only loosely
 * fits a row, or fits several, or fits one taken off (those are listed by
 * `offRosterInApp`).
 */
export function phonesNotOnRoster(employees: readonly Employee[], roster: readonly RosterRow[], placeholders: ReadonlySet<string> = new Set()): Employee[] {
  const people = employees.filter((e) => !placeholders.has(e.id));
  const held = heldByRows(roster, people);
  const on = roster.map(asPerson);
  return people
    .filter((e) => e.active && !held.has(e.id))
    .filter((e) => findOnRoster(on, e.firstName, e.lastName) === null)
    .sort(byName);
}

/**
 * The people still on the app's roster, and on every phone, whose row was
 * taken off the sign-in roster and who have no active row: taken off before
 * the Roster page wrote both rosters, or taken off while the app's roster was
 * not loaded.
 */
export function offRosterInApp(employees: readonly Employee[], roster: readonly RosterRow[], placeholders: ReadonlySet<string> = new Set()): Employee[] {
  const people = employees.filter((e) => !placeholders.has(e.id));
  const held = heldByRows(roster, people);
  const on = roster.filter((r) => r.active).map(asPerson);
  const off = roster.filter((r) => !r.active).map(asPerson);
  return people
    .filter((e) => e.active && !held.has(e.id))
    .filter((e) => findOnRoster(on, e.firstName, e.lastName) === null && findOnRoster(off, e.firstName, e.lastName) !== null)
    .sort(byName);
}

/** Why a request did not join by itself, for the supervisor deciding it. */
export const REASON_TEXT: Record<JoinReason, string> = {
  not_on_roster: 'No one on the roster has this name.',
  already_claimed: 'This name is on the roster, but another account has already joined on it.',
  supervisor_row: 'This is a supervisor’s name. A supervisor row is never given out by a typed name, so a supervisor decides.',
  removed: 'This account was taken off the roster. Someone taken off waits for a supervisor to let them back in.',
  released: 'A supervisor let go of this account’s earlier place on the roster, so a supervisor decides.',
  ambiguous: 'More than one person on the roster is written exactly this way, so no typing can single one out.',
};

/** The roster rows a request's typed name fits: what a supervisor checks it against. */
export function rowsLike(request: Pick<JoinRequestRow, 'first_name' | 'last_name'>, roster: RosterRow[]): RosterRow[] {
  const hit = findOnRoster(roster.filter((r) => r.active).map(asPerson), request.first_name, request.last_name);
  if (!hit) return [];
  return 'person' in hit ? [hit.person.row] : hit.several.map((p) => p.row);
}

/** "Quinn, Riley J" */
export const rowName = (row: Pick<RosterRow, 'first_name' | 'last_name'>) => `${row.last_name}, ${row.first_name}`;
