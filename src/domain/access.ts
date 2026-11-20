import { findOnRoster, type PersonName } from './roster';
import type { Employee, Role } from './types';

/**
 * Who has a supervisor's powers on a phone, who may make an account on it,
 * and who sees what of its company account. Pure, for the store, the screens
 * and their tests.
 *
 * On a phone never connected to a company, the person's record decides, as it
 * always has. On a phone connected to one, the server goes by the phone's
 * company sign-in, so the phone does too: a person has a supervisor's powers
 * there only when their record says supervisor, the sign-in is a
 * supervisor's, and the sign-in is theirs.
 */

/** Who the phone's company sign-in is to the company, as the round's standing read last found. */
export interface SignInStanding {
  role: Role | 'none' | null;
  name: PersonName | null;
}

const fits = (person: PersonName, name: PersonName | null): boolean => {
  if (!name) return false;
  const hit = findOnRoster([person], name.firstName, name.lastName);
  return !!hit && 'person' in hit;
};
const full = (p: PersonName) => `${p.firstName} ${p.lastName}`;

/** Whether the phone's company sign-in is this person's own, by the name the company has for it. */
export function signInIsTheirs(person: PersonName, standing: SignInStanding | null): boolean {
  return fits(person, standing?.name ?? null);
}

/** Whether the person signed in to the app has a supervisor's powers on this phone. */
export function supervisorHere(state: {
  session: { employeeId: string } | null;
  employees: readonly Employee[];
  /** Connected to a company now. */
  connected: boolean;
  receiving: SignInStanding | null;
}): boolean {
  const me = state.employees.find((e) => e.id === state.session?.employeeId);
  if (me?.role !== 'supervisor') return false;
  if (!state.connected) return true;
  const r = state.receiving;
  return r?.role === 'supervisor' && fits(me, r.name);
}

/**
 * Whether this person may make their account on this phone, and anything to
 * tell them about it. `receiving` is null on a phone never connected, where
 * anyone on the roster may. On a phone joined with a crew sign-in, only that
 * sign-in's person. On one joined with a supervisor's sign-in (a shared phone)
 * any crew member, and a supervisor only as the sign-in's own person, with its
 * password checked by the server (`passwordChecked`).
 */
export function accountHere(
  person: Employee,
  receiving: SignInStanding | null,
  passwordChecked: boolean,
  email: string | null,
): { ok: true; note?: string } | { ok: false; error: string; needsPassword?: true } {
  if (!receiving) return { ok: true };
  if (receiving.role === null || !receiving.name) return { ok: false, error: 'This phone has not heard from the company yet. Try again once it has had signal.' };
  if (receiving.role === 'none') return { ok: false, error: 'This phone’s company sign-in is not on the company’s roster any more. See your supervisor.' };
  const theirs = fits(person, receiving.name);
  const asCrew = (appRole: string, signInRole: string) =>
    `${full(person)} is ${appRole} in the app but ${signInRole} on the company’s sign-in roster, so this account works as crew here. Ask the office to set the role on the dashboard’s Roster page.`;
  if (receiving.role === 'employee') {
    if (!theirs) {
      return {
        ok: false,
        error: `This phone is joined with ${full(receiving.name)}’s company sign-in, so the account made here is theirs. Make yours on your own phone, or on a phone joined with a supervisor’s sign-in.`,
      };
    }
    return person.role === 'supervisor' ? { ok: true, note: asCrew('a supervisor', 'crew') } : { ok: true };
  }
  // A phone joined with a supervisor's sign-in.
  if (person.role !== 'supervisor') return theirs ? { ok: true, note: asCrew('crew', 'a supervisor') } : { ok: true };
  if (!theirs) return { ok: false, error: `${full(person)} makes their account on a phone joined with their own company sign-in.` };
  if (!passwordChecked) {
    return {
      ok: false,
      needsPassword: true,
      error: `Enter the password of this phone’s company sign-in${email ? `, ${email}` : ''}. It is checked once with the company’s server to show this is you, and not kept on this phone.`,
    };
  }
  return { ok: true };
}

/**
 * How much of the company account screen a person sees. `connect`: only the
 * way to connect a phone not connected. `read_only`: the company and its
 * records, and nothing that changes the phone's sign-in. `full`: everything.
 * The sign-in belongs to the phone's person: someone else changes it only when
 * it is signed out of the server or no longer on the company's roster, so a
 * shared phone whose person has left is not stuck.
 */
export function companyAccountView(state: {
  connected: boolean;
  me: PersonName | null;
  receiving: SignInStanding | null;
  serverSignedIn: boolean;
}): { view: 'connect' | 'read_only' | 'full'; words?: string } {
  if (!state.connected) return { view: state.me ? 'full' : 'connect' };
  const r = state.receiving;
  if (!state.me || !r?.name) return { view: 'read_only' };
  if (fits(state.me, r.name)) return { view: 'full' };
  if (!state.serverSignedIn || r.role === 'none') return { view: 'full' };
  return { view: 'read_only', words: `This phone is joined with ${full(r.name)}’s company sign-in. Only they change it here.` };
}

/**
 * What a person signed in to the app sees. `out`: the sign-in screen. `full`:
 * the app. `clock_only`: the Clock screen alone, and End use from it, so a
 * person taken off the roster while on the clock (or the person a phone's
 * sign-in is for, once that sign-in is off the company's roster) can clock out
 * and check a unit back in. Nobody on the clock is signed out.
 */
export function signedInView(state: {
  person: Employee | undefined;
  /** The person has a shift open now. */
  onTheClock: boolean;
  connected: boolean;
  receiving: SignInStanding | null;
}): 'out' | 'clock_only' | 'full' {
  const { person, onTheClock, connected, receiving } = state;
  if (!person) return 'out';
  const held = !person.active || (connected && receiving?.role === 'none' && fits(person, receiving.name));
  if (!held) return 'full';
  return onTheClock ? 'clock_only' : 'out';
}
