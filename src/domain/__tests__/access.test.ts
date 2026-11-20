// Who has a supervisor's powers on a phone, who may make an account on it, and who sees what of its
// company account (src/domain/access.ts). On a phone never connected the person's record decides, as
// it always has. On a phone connected to its company, the phone's company sign-in decides too: its
// role, and whose it is.
import { accountHere, companyAccountView, supervisorHere } from '../access';
import type { Employee } from '../types';

const dana: Employee = { id: 'emp_dana', firstName: 'Dana', lastName: 'Fry', role: 'supervisor', active: true };
const lee: Employee = { id: 'emp_lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true };
const ana: Employee = { id: 'emp_ana', firstName: 'Ana', lastName: 'Diaz', role: 'supervisor', active: true };
const employees = [dana, lee, ana];
const danaName = { firstName: 'Dana', lastName: 'Fry' };
const leeName = { firstName: 'Lee', lastName: 'Park' };

describe('supervisorHere', () => {
  const as = (person: Employee | null) => ({ session: person ? { employeeId: person.id } : null, employees });

  it('on a phone never connected, goes by the person’s record', () => {
    expect(supervisorHere({ ...as(dana), connected: false, receiving: null })).toBe(true);
    expect(supervisorHere({ ...as(lee), connected: false, receiving: null })).toBe(false);
    expect(supervisorHere({ ...as(null), connected: false, receiving: null })).toBe(false);
  });

  it('on a connected phone, needs the record, a supervisor’s sign-in, and the sign-in to be theirs', () => {
    expect(supervisorHere({ ...as(dana), connected: true, receiving: { role: 'supervisor', name: danaName } })).toBe(true);
    expect(supervisorHere({ ...as(lee), connected: true, receiving: { role: 'supervisor', name: leeName } })).toBe(false);
    expect(supervisorHere({ ...as(dana), connected: true, receiving: { role: 'employee', name: danaName } })).toBe(false);
    expect(supervisorHere({ ...as(dana), connected: true, receiving: { role: 'none', name: danaName } })).toBe(false);
    expect(supervisorHere({ ...as(ana), connected: true, receiving: { role: 'supervisor', name: danaName } })).toBe(false);
    expect(supervisorHere({ ...as(dana), connected: true, receiving: { role: 'supervisor', name: null } })).toBe(false);
    expect(supervisorHere({ ...as(dana), connected: true, receiving: null })).toBe(false);
  });

  it('matches the sign-in’s name the way every typed name is matched', () => {
    const rileyJ: Employee = { id: 'emp_r', firstName: 'Riley J', lastName: 'Quinn', role: 'supervisor', active: true };
    const state = { session: { employeeId: rileyJ.id }, employees: [rileyJ], connected: true };
    expect(supervisorHere({ ...state, receiving: { role: 'supervisor', name: { firstName: 'riley', lastName: 'QUINN' } } })).toBe(true);
  });
});

describe('accountHere', () => {
  it('takes anyone on a phone never connected', () => {
    expect(accountHere(dana, null, false, null)).toEqual({ ok: true });
  });

  it('on a phone joined with a crew sign-in, takes only that sign-in’s person', () => {
    const crew = { role: 'employee' as const, name: leeName };
    expect(accountHere(lee, crew, false, 'lee@example.test')).toEqual({ ok: true });
    expect(accountHere(ana, crew, false, 'lee@example.test')).toEqual({
      ok: false,
      error: 'This phone is joined with Lee Park’s company sign-in, so the account made here is theirs. Make yours on your own phone, or on a phone joined with a supervisor’s sign-in.',
    });
  });

  it('makes the account of a supervisor in the app whose sign-in is crew, and says it works as crew', () => {
    expect(accountHere(dana, { role: 'employee', name: danaName }, false, null)).toEqual({
      ok: true,
      note: 'Dana Fry is a supervisor in the app but crew on the company’s sign-in roster, so this account works as crew here. Ask the office to set the role on the dashboard’s Roster page.',
    });
    expect(accountHere(lee, { role: 'supervisor', name: leeName }, false, null)).toEqual({
      ok: true,
      note: 'Lee Park is crew in the app but a supervisor on the company’s sign-in roster, so this account works as crew here. Ask the office to set the role on the dashboard’s Roster page.',
    });
  });

  it('on a phone joined with a supervisor’s sign-in, takes crew, and a supervisor only as that sign-in’s person with its password checked', () => {
    const shared = { role: 'supervisor' as const, name: danaName };
    expect(accountHere(lee, shared, false, 'dana@example.test')).toEqual({ ok: true });
    expect(accountHere(ana, shared, true, 'dana@example.test')).toEqual({ ok: false, error: 'Ana Diaz makes their account on a phone joined with their own company sign-in.' });
    expect(accountHere(dana, shared, false, 'dana@example.test')).toEqual({
      ok: false,
      needsPassword: true,
      error: 'Enter the password of this phone’s company sign-in, dana@example.test. It is checked once with the company’s server to show this is you, and not kept on this phone.',
    });
    expect(accountHere(dana, shared, true, 'dana@example.test')).toEqual({ ok: true });
  });

  it('waits for the company before an account is made, and refuses one on a sign-in taken off the roster', () => {
    expect(accountHere(lee, { role: null, name: null }, false, null)).toEqual({ ok: false, error: 'This phone has not heard from the company yet. Try again once it has had signal.' });
    expect(accountHere(lee, { role: 'none', name: leeName }, false, null)).toEqual({
      ok: false,
      error: 'This phone’s company sign-in is not on the company’s roster any more. See your supervisor.',
    });
  });
});

describe('companyAccountView', () => {
  const joined = { role: 'supervisor' as const, name: danaName };
  it('offers only the way to connect on a phone not connected with nobody signed in, and everything to someone signed in', () => {
    expect(companyAccountView({ connected: false, me: null, receiving: null, serverSignedIn: false })).toEqual({ view: 'connect' });
    expect(companyAccountView({ connected: false, me: lee, receiving: null, serverSignedIn: false })).toEqual({ view: 'full' });
  });

  it('shows a connected phone’s company account read-only to someone signed out, or before the company answered', () => {
    expect(companyAccountView({ connected: true, me: null, receiving: joined, serverSignedIn: true })).toEqual({ view: 'read_only' });
    expect(companyAccountView({ connected: true, me: dana, receiving: { role: null, name: null }, serverSignedIn: true })).toEqual({ view: 'read_only' });
  });

  it('lets the sign-in’s own person change it, and someone else only when the sign-in is signed out or off the roster', () => {
    expect(companyAccountView({ connected: true, me: dana, receiving: joined, serverSignedIn: true })).toEqual({ view: 'full' });
    expect(companyAccountView({ connected: true, me: lee, receiving: joined, serverSignedIn: true })).toEqual({
      view: 'read_only',
      words: 'This phone is joined with Dana Fry’s company sign-in. Only they change it here.',
    });
    expect(companyAccountView({ connected: true, me: lee, receiving: joined, serverSignedIn: false })).toEqual({ view: 'full' });
    expect(companyAccountView({ connected: true, me: lee, receiving: { role: 'none', name: danaName }, serverSignedIn: true })).toEqual({ view: 'full' });
  });
});
