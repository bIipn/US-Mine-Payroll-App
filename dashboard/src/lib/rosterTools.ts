import { cleanText, findOnRoster, parsePersonName, sameName, type PersonName } from '@app/domain/roster';
import type { Employee, Role } from '@app/domain/types';

import type { JoinReason, JoinRequestRow, RosterRow } from './server';

/**
 * The sign-in roster on the server (who may join the company) beside the
 * app's own employee list, which the phones send as employee records. The two
 * are separate lists for now; these work out where they differ.
 */

const asPerson = (row: RosterRow): PersonName & { row: RosterRow } => ({ firstName: row.first_name, lastName: row.last_name, row });

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
 * The people the phones have sent as employee records who are not on the
 * sign-in roster yet, so they could not join the company with their own name.
 * Someone the name only loosely fits, or fits several rows, counts as on it:
 * the roster has a row they could be.
 */
export function phonesNotOnRoster(employees: Employee[], roster: RosterRow[], placeholders: Set<string> = new Set()): Employee[] {
  const on = roster.map(asPerson);
  return employees
    .filter((e) => e.active && !placeholders.has(e.id))
    .filter((e) => findOnRoster(on, e.firstName, e.lastName) === null)
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
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
