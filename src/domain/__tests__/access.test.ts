// Who has a supervisor's powers on a phone, who may make an account on it, and who sees what of its
// company account (src/domain/access.ts). On a phone never connected the person's record decides, as
// it always has. On a phone connected to its company, the phone's company sign-in decides too: its
// role, and whose it is. One person per phone: the one its company sign-in is for.
import { accountHere, companyAccountView, ownPersonHere, signedInView, supervisorHere } from '../access';
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
    expect(accountHere(dana, employees, null)).toEqual({ ok: true });
    expect(accountHere(lee, employees, null)).toEqual({ ok: true });
  });

  it('on a connected phone only the sign-in’s own person has an account', () => {
    const theirs = (name: string) => ({
      ok: false,
      error: `This phone is joined with ${name}’s company sign-in, so the account made here is theirs. Make yours on your own phone.`,
    });
    // Lee's phone, joined with Lee's crew sign-in.
    const crew = { role: 'employee' as const, name: leeName };
    expect(accountHere(lee, employees, crew)).toEqual({ ok: true });
    expect(accountHere(ana, employees, crew)).toEqual(theirs('Lee Park'));
    // Dana's phone, joined with Dana's supervisor sign-in: it holds nobody else's account either, crew or
    // supervisor, and Dana's own needs no second password (the sign-in was the proof).
    const supervisor = { role: 'supervisor' as const, name: danaName };
    expect(accountHere(dana, employees, supervisor)).toEqual({ ok: true });
    expect(accountHere(lee, employees, supervisor)).toEqual(theirs('Dana Fry'));
    expect(accountHere(ana, employees, supervisor)).toEqual(theirs('Dana Fry'));
  });

  it('is one person’s: on a phone joined with Sam Ortiz’s sign-in, Sam Ortiz Jr has no account', () => {
    const sam: Employee = { id: 'emp_sam', firstName: 'Sam', lastName: 'Ortiz', role: 'employee', active: true };
    const samJr: Employee = { id: 'emp_sam_jr', firstName: 'Sam', lastName: 'Ortiz Jr', role: 'employee', active: true };
    const samsPhone = { role: 'employee' as const, name: { firstName: 'Sam', lastName: 'Ortiz' } };
    expect(accountHere(sam, [sam, samJr], samsPhone)).toEqual({ ok: true });
    expect(accountHere(samJr, [sam, samJr], samsPhone)).toEqual({
      ok: false,
      error: 'This phone is joined with Sam Ortiz’s company sign-in, so the account made here is theirs. Make yours on your own phone.',
    });
  });

  it('makes the account of a supervisor in the app whose sign-in is crew, and says it works as crew', () => {
    expect(accountHere(dana, employees, { role: 'employee', name: danaName })).toEqual({
      ok: true,
      note: 'Dana Fry is a supervisor in the app but crew on the company’s sign-in roster, so this account works as crew here. Ask the office to set the role on the dashboard’s Roster page.',
    });
    expect(accountHere(lee, employees, { role: 'supervisor', name: leeName })).toEqual({
      ok: true,
      note: 'Lee Park is crew in the app but a supervisor on the company’s sign-in roster, so this account works as crew here. Ask the office to set the role on the dashboard’s Roster page.',
    });
  });

  it('waits for the company before an account is made, and refuses one on a sign-in taken off the roster', () => {
    expect(accountHere(lee, employees, { role: null, name: null })).toEqual({ ok: false, error: 'This phone has not heard from the company yet. Try again once it has had signal.' });
    expect(accountHere(lee, employees, { role: 'none', name: leeName })).toEqual({
      ok: false,
      error: 'This phone’s company sign-in is not on the company’s roster any more. See your supervisor.',
    });
  });
});

describe('ownPersonHere', () => {
  const read = (role: 'employee' | 'supervisor' | 'none' | null, name: { firstName: string; lastName: string } | null, caughtUpAt: number | null = 1) => ({ role, name, caughtUpAt });

  it('is the one person the sign-in’s name is, once the phone has read the company’s records to the end', () => {
    expect(ownPersonHere(employees, read('employee', leeName))).toEqual({ ok: true, person: lee });
    expect(ownPersonHere(employees, read('supervisor', danaName))).toEqual({ ok: true, person: dana });
    // Matched the way every name is: a middle initial left off, any capitals.
    const rileyJ: Employee = { id: 'emp_r', firstName: 'Riley J', lastName: 'Quinn', role: 'employee', active: true };
    expect(ownPersonHere([rileyJ], read('employee', { firstName: 'riley', lastName: 'QUINN' }))).toEqual({ ok: true, person: rileyJ });
    // The company's rows come in the order they were written, so only the end of the read says the settings are in.
    expect(ownPersonHere(employees, read('employee', leeName, null))).toEqual({
      ok: false,
      error: 'This phone has not got the company’s roster yet. Your account opens by itself once it has.',
    });
  });

  it('is nobody when the name fits nobody, fits more than one person, or is someone off the active roster', () => {
    expect(ownPersonHere(employees, read('employee', { firstName: 'Sam', lastName: 'Ortiz' }))).toEqual({
      ok: false,
      error: 'Sam Ortiz is not on the company’s roster on this phone. See your supervisor.',
    });
    const twoRileys: Employee[] = [
      { id: 'emp_rj', firstName: 'Riley J', lastName: 'Quinn', role: 'employee', active: true },
      { id: 'emp_rk', firstName: 'Riley K', lastName: 'Quinn', role: 'employee', active: true },
    ];
    expect(ownPersonHere(twoRileys, read('employee', { firstName: 'Riley', lastName: 'Quinn' }))).toEqual({
      ok: false,
      error: 'More than one person on the company’s roster goes by Riley Quinn. Ask the office to tell them apart on the dashboard’s Roster page.',
    });
    // The sign-in's own person is off the roster: never someone else whose name it only loosely fits.
    const ortizes: Employee[] = [
      { id: 'emp_sam', firstName: 'Sam', lastName: 'Ortiz', role: 'employee', active: false },
      { id: 'emp_sam_jr', firstName: 'Sam', lastName: 'Ortiz Jr', role: 'employee', active: true },
    ];
    expect(ownPersonHere(ortizes, read('employee', { firstName: 'Sam', lastName: 'Ortiz' }))).toEqual({
      ok: false,
      error: 'Sam Ortiz is no longer on the company’s active roster. See your supervisor.',
    });
  });

  it('is nobody before the company has said who the sign-in is, or once it is off the company’s roster', () => {
    expect(ownPersonHere(employees, null)).toEqual({ ok: false, error: 'This phone has not heard from the company yet. Try again once it has had signal.' });
    expect(ownPersonHere(employees, read(null, null))).toEqual({ ok: false, error: 'This phone has not heard from the company yet. Try again once it has had signal.' });
    expect(ownPersonHere(employees, read('none', leeName))).toEqual({
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

describe('the screens', () => {
  // This project has no Node types, so the file system is asked for by name with the calls used here.
  type Entry = { name: string; isDirectory(): boolean };
  type Files = { readdirSync(dir: string, o: { withFileTypes: true }): Entry[]; readFileSync(file: string, encoding: 'utf8'): string };
  const fs = jest.requireActual<Files>('fs');
  const here = expect.getState().testPath ?? '';
  const src = here.slice(0, here.search(/[\\/]domain[\\/]/));
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : files(`${dir}/${e.name}`)) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []));

  it('read a supervisor’s power through useSupervisorHere, never from the signed-in person’s role', () => {
    const found: string[] = [];
    for (const file of [...files(`${src}/screens`), ...files(`${src}/navigation`)]) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Showing who someone is (a "Supervisor" tag) is not a power.
          if (/\bme\??\.role\s*[!=]==/.test(line) && !line.includes('<Tag')) found.push(`${file.slice(src.length + 1)}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
  });
});

describe('signedInView', () => {
  const off = { ...lee, active: false };
  it('signs out a person taken off the roster, unless they are on the clock: then the Clock screen alone', () => {
    expect(signedInView({ person: off, onTheClock: false, connected: false, receiving: null })).toBe('out');
    expect(signedInView({ person: off, onTheClock: true, connected: false, receiving: null })).toBe('clock_only');
    expect(signedInView({ person: undefined, onTheClock: false, connected: false, receiving: null })).toBe('out');
  });

  it('holds the person a sign-in taken off the company’s roster is for the same way, and nobody else', () => {
    const gone = { role: 'none' as const, name: leeName };
    expect(signedInView({ person: lee, onTheClock: true, connected: true, receiving: gone })).toBe('clock_only');
    expect(signedInView({ person: lee, onTheClock: false, connected: true, receiving: gone })).toBe('out');
    expect(signedInView({ person: dana, onTheClock: false, connected: true, receiving: gone })).toBe('full');
  });

  it('leaves everyone else as they were', () => {
    expect(signedInView({ person: lee, onTheClock: false, connected: true, receiving: { role: 'employee', name: leeName } })).toBe('full');
    expect(signedInView({ person: lee, onTheClock: false, connected: false, receiving: null })).toBe('full');
  });
});
