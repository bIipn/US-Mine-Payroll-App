import type { Employee } from './types';

/**
 * Names on the roster. Only people on the roster can create an account, so the
 * way a name is read and matched lives here, in one place.
 */

export interface PersonName {
  firstName: string;
  lastName: string;
}

/** Trim, and close up any run of spaces. */
export const cleanText = (text: string) => text.trim().replace(/\s+/g, ' ');

/** Capitals for a name typed in lower case: "o'neil-smith" becomes "O'Neil-Smith". Capitals already there are kept. */
export const titleCase = (text: string) =>
  cleanText(text).replace(/(^|[\s'-])([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());

export const sameName = (person: PersonName, firstName: string, lastName: string) =>
  person.firstName.toLowerCase() === cleanText(firstName).toLowerCase() &&
  person.lastName.toLowerCase() === cleanText(lastName).toLowerCase();

/**
 * Read a name written as "First Last" or "Last, First". Everything after the
 * first word is the last name. Returns null unless there is both a first and a
 * last name.
 */
export function parsePersonName(text: string | null | undefined): PersonName | null {
  let line = cleanText(text ?? '');
  if (line.includes(',')) {
    const [last = '', first = ''] = line.split(',').map(cleanText);
    if (!first || !last) return null;
    line = `${first} ${last}`;
  }
  const parts = line.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: titleCase(parts[0]), lastName: titleCase(parts.slice(1).join(' ')) };
}

/**
 * The roster with the build's owner on it.
 *
 * The owner is the person a build of the app is made for, named in a private
 * build setting rather than in the code. They are always on the roster as a
 * supervisor, so there is someone who can sign in and add everyone else. They
 * come with no hours or records of their own.
 *
 * Nothing changes when they are already on the roster, including when a
 * supervisor has removed them: the same list is handed back.
 */
export function withOwner(employees: Employee[], owner: PersonName | null): Employee[] {
  if (!owner) return employees;
  if (employees.some((e) => sameName(e, owner.firstName, owner.lastName))) return employees;
  const slug = `${owner.firstName} ${owner.lastName}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return [
    ...employees,
    { id: `own_${slug}`, firstName: owner.firstName, lastName: owner.lastName, role: 'supervisor', active: true },
  ];
}
