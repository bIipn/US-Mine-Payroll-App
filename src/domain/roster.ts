import type { Employee, Role } from './types';

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
 * Read a name written as "First Last" or "Last, First". Without a comma,
 * everything after the first word is the last name. With one, the name is split
 * where the comma is, so a middle initial, a nickname or "III" stays where it
 * was put. Returns null unless there is both a first and a last name.
 */
export function parsePersonName(text: string | null | undefined): PersonName | null {
  const line = cleanText(text ?? '');
  const comma = line.indexOf(',');
  if (comma >= 0) {
    const last = cleanText(line.slice(0, comma));
    const first = cleanText(line.slice(comma + 1));
    return first && last ? { firstName: titleCase(first), lastName: titleCase(last) } : null;
  }
  const parts = line.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: titleCase(parts[0]), lastName: titleCase(parts.slice(1).join(' ')) };
}

// ---- Matching a typed name --------------------------------------------------------------------

/** The words of a name in lower case, without quote marks, full stops, commas or hyphens. */
const words = (text: string) => cleanText(text.toLowerCase().replace(/["“”'‘’.,-]/g, ' ')).split(' ').filter(Boolean);

const SUFFIXES = ['jr', 'sr', 'ii', 'iii', 'iv', 'v'];

/** A last name as its letters run together, and the "Jr" or "III" after it, if it has one. */
function lastNameOf(text: string): { core: string; suffix: string } {
  const all = words(text);
  const suffix = all.length > 1 && SUFFIXES.includes(all[all.length - 1]) ? all[all.length - 1] : '';
  return { core: (suffix ? all.slice(0, -1) : all).join(''), suffix };
}

/**
 * Whether a typed name is this person. The roster holds a name the way the mine
 * writes it, which can carry a middle initial, a nickname in quotes or "III".
 * People leave those off when they type their own name, or go by the nickname.
 * So the last names have to agree, give or take the "III", and every word of
 * the typed first name has to be one of the roster's. An initial alone is not a name.
 */
function fits(person: PersonName, firstName: string, lastName: string): boolean {
  const [theirs, typed] = [lastNameOf(person.lastName), lastNameOf(lastName)];
  if (!typed.core || typed.core !== theirs.core || (typed.suffix && typed.suffix !== theirs.suffix)) return false;
  const given = words(person.firstName);
  const typedFirst = words(firstName);
  return typedFirst.some((word) => word.length > 1) && typedFirst.every((word) => given.includes(word));
}

/**
 * Who on the roster a typed name is. A name typed exactly as it is on the roster
 * is that person. Otherwise it is the one person it fits, and when it fits more
 * than one, all of them come back so the person can be asked to type the whole name.
 */
export function findOnRoster<T extends PersonName>(people: T[], firstName: string, lastName: string): { person: T } | { several: T[] } | null {
  const exact = people.filter((p) => sameName(p, firstName, lastName));
  const hits = exact.length ? exact : people.filter((p) => fits(p, firstName, lastName));
  if (hits.length === 0) return null;
  return hits.length === 1 ? { person: hits[0] } : { several: hits };
}

// ---- The roster a build names -----------------------------------------------------------------

/** One person a build names for its roster. */
export interface RosterEntry extends PersonName {
  title?: string;
  role: Role;
}

/**
 * The roster a build names, from text with one person to a line: the name, then
 * the job title, then "supervisor" for a supervisor, with a bar between them.
 *
 *     Ortiz, Sam | Crusher
 *     Quinn, Riley J | Maintenance | supervisor
 *
 * A line that is not a full name is passed over, and so is a person named twice.
 * Line ends can be `\n` typed out, which is what a setting holds outside double quotes.
 */
export function parseRoster(text: string | null | undefined): RosterEntry[] {
  const people: RosterEntry[] = [];
  for (const line of (text ?? '').replace(/\\n/g, '\n').split(/\r?\n/)) {
    const [name = '', title = '', role = ''] = line.split('|').map(cleanText);
    const person = parsePersonName(name);
    if (!person || people.some((p) => sameName(p, person.firstName, person.lastName))) continue;
    people.push({ ...person, ...(title ? { title } : null), role: role.toLowerCase() === 'supervisor' ? 'supervisor' : 'employee' });
  }
  return people;
}

/**
 * The roster with everyone the build names on it, each with their job title.
 *
 * They come with no hours or records of their own: nothing is made up for a real
 * person. Anyone already on the roster is left as they are, including someone a
 * supervisor has removed. Returns the same list when there is nobody to add.
 */
export function withRoster(employees: Employee[], named: RosterEntry[]): Employee[] {
  const taken = new Set(employees.map((e) => e.id));
  const added: Employee[] = [];
  for (const person of named) {
    if ([...employees, ...added].some((e) => sameName(e, person.firstName, person.lastName))) continue;
    const base = `ros_${`${person.firstName} ${person.lastName}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    added.push({
      id,
      firstName: person.firstName,
      lastName: person.lastName,
      role: person.role,
      ...(person.title ? { title: person.title } : null),
      active: true,
    });
  }
  return added.length ? [...employees, ...added] : employees;
}

/**
 * Whether a preview starts with the made-up sample crew and the sample history
 * that belongs to them. A build that names its own people starts without them:
 * everyone on its roster is real, and nothing made up sits beside them. A build
 * that names nobody has them, so there is something to look at. The setting
 * decides it either way: "1" for the samples, "0" for none.
 */
export function startsWithSamples(setting: string | null | undefined, named: number): boolean {
  const said = (setting ?? '').trim();
  if (said === '1') return true;
  if (said === '0') return false;
  return named === 0;
}

/**
 * Last names for made-up people to fall back on. A build that names someone
 * with one of these passes it over, so none is ever shared with a real person.
 */
export const SPARE_LAST_NAMES = [
  'Abbott', 'Baxter', 'Calloway', 'Dunmore', 'Ellison', 'Norwood', 'Okafor', 'Prescott',
  'Quimby', 'Radcliffe', 'Sandoval', 'Thackeray', 'Underhill', 'Winslow', 'Yardley', 'Zeller',
];

/**
 * Made-up people kept apart from the people a build names: nobody made up keeps
 * a last name that someone real has, so the sample hours and records are never
 * taken for a real person's or their family's. Whoever has such a name takes the
 * next spare. The same list is handed back when there is nobody to rename.
 */
export function keptApart<T extends PersonName>(madeUp: T[], named: PersonName[]): T[] {
  const core = (lastName: string) => lastNameOf(lastName).core;
  const real = new Set(named.map((p) => core(p.lastName)));
  if (!madeUp.some((p) => real.has(core(p.lastName)))) return madeUp;
  const inUse = new Set(madeUp.map((p) => core(p.lastName)));
  const spares = SPARE_LAST_NAMES.filter((name) => !real.has(core(name)) && !inUse.has(core(name)));
  return madeUp.map((person) => {
    if (!real.has(core(person.lastName))) return person;
    const lastName = spares.shift();
    return lastName ? { ...person, lastName } : person;
  });
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

/**
 * Everyone a build puts on the roster: the people it names, and its owner. When
 * the roster names the owner too, they are on it once, as a supervisor, with
 * the job title the roster gives them.
 */
export function withBuildRoster(employees: Employee[], named: RosterEntry[], owner: PersonName | null): Employee[] {
  const people = owner
    ? named.map((p): RosterEntry => (sameName(p, owner.firstName, owner.lastName) ? { ...p, role: 'supervisor' } : p))
    : named;
  return withOwner(withRoster(employees, people), owner);
}

// ---- What the store and the dashboard's Roster page share ---------------------------------------------

/**
 * A person added to the roster, or a person taken off it brought back under
 * the same id (their payroll ID and records stay theirs), or what is wrong.
 * The store and the dashboard's Roster page add people through here.
 */
export function addedPerson(
  employees: readonly Employee[],
  firstName: string,
  lastName: string,
  role: Role,
  title: string | undefined,
  id: string,
): { ok: true; employee: Employee; returning: boolean } | { ok: false; error: string } {
  const first = titleCase(firstName);
  const last = titleCase(lastName);
  if (!first || !last) return { ok: false, error: 'Enter a first and last name.' };
  const existing = employees.find((e) => sameName(e, first, last));
  if (existing?.active) return { ok: false, error: `${first} ${last} is already on the roster.` };
  const typed = title && cleanText(title) ? cleanText(title) : undefined;
  if (existing) return { ok: true, returning: true, employee: { ...existing, active: true, role, ...(typed ? { title: typed } : null) } };
  return { ok: true, returning: false, employee: { id, firstName: first, lastName: last, role, title: typed, active: true } };
}

/** What is wrong with a payroll ID for this person, or undefined. An empty one takes the ID off. */
export function payrollIdProblem(employees: readonly Employee[], employeeId: string, payrollId: string): string | undefined {
  const id = payrollId.trim();
  if (!id) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,19}$/.test(id)) {
    return 'A payroll ID is up to 20 letters and numbers. A dash, dot, slash or space between them is fine.';
  }
  const taken = employees.find((e) => e.id !== employeeId && e.payrollId?.toLowerCase() === id.toLowerCase());
  return taken ? `${taken.firstName} ${taken.lastName} already has payroll ID ${id}.` : undefined;
}

/**
 * The person in the app a row of the sign-in roster is for: the active person
 * whose name is the row's exactly, else the one findOnRoster finds among the
 * active people, else nobody. Never a person taken off the roster.
 */
export function personForRow<T extends Employee>(employees: readonly T[], row: PersonName): T | undefined {
  const active = employees.filter((e) => e.active);
  const exact = active.find((e) => sameName(e, row.firstName, row.lastName));
  if (exact) return exact;
  const hit = findOnRoster(active, row.firstName, row.lastName);
  return hit && 'person' in hit ? hit.person : undefined;
}
