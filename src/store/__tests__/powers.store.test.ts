// Who may change what on a phone connected to its company. People are changed on the dashboard
// only; the fleet, the sheets and the settings only from a supervisor's company sign-in once the
// company's records have come; a supervisor's powers need the record, a supervisor's sign-in and
// the sign-in to be theirs; a clock-in is refused to someone off the roster or on a phone whose
// sign-in is no longer on it; and an account is made only for the person a crew sign-in is for.
// A phone never connected keeps every rule it had. The sample crew is made up.
import { toGeoStamp } from '../../domain/geofence';
import { SAMPLE_SITE } from '../../domain/site';
import type { Role } from '../../domain/types';
import { useStore } from '../useStore';

const s = () => useStore.getState();
const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m, 0).getTime();
const onSite = toGeoStamp(SAMPLE_SITE, { ...SAMPLE_SITE.center, accuracyM: 5 }, 'gps');
const COMPANY = 'c-test-a';
const casey = { firstName: 'Casey', lastName: 'Morgan' }; // the sample supervisor
const jordan = { firstName: 'Jordan', lastName: 'Rivera' }; // the sample loader operator

/** This phone joined Test Pit A with a sign-in in this role, held by this person, and has caught up once. */
function joined(role: Role | 'none', name = casey, caughtUp = true) {
  useStore.setState({
    connectedCompany: { id: COMPANY, name: 'Test Pit A', role: role === 'none' ? 'employee' : role, userId: 'u1', email: 'sign-in@example.test' },
    syncedWith: COMPANY,
    receiving: null,
  });
  s().ensureReceiving();
  useStore.setState({ receiving: { ...s().receiving!, role, name, caughtUpAt: caughtUp ? at(6) : null } });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(at(6, 15));
  s().resetDemo();
});
afterEach(() => jest.useRealTimers());

const DASHBOARD =
  'On a phone joined to a company, people are added, taken off and given a role or a payroll ID on the dashboard’s Roster page, which changes the sign-in roster too. This phone gets the change the next time it has signal.';
const CREW_SIGN_IN =
  'This phone is joined with a crew sign-in, so the company’s server would not take this. Change it on the office dashboard, or join this phone with a supervisor’s sign-in on Company account.';
const NOT_YET = 'This phone has not got the company’s roster, fleet and sheets yet. Try again once it has had signal.';

describe('a supervisor’s powers on a connected phone', () => {
  it('need the record, a supervisor’s sign-in, and the sign-in to be theirs', () => {
    s().signInDemo('supervisor');
    const leave = { employeeId: 'emp_demo', day: at(6), type: 'pto' as const, hours: 800 };
    expect(s().addLeave(leave)).toEqual({ ok: true });
    joined('employee', casey);
    expect(s().addLeave(leave)).toEqual({ ok: false, error: 'Only a supervisor can record paid leave.' });
    joined('supervisor', jordan);
    expect(s().addLeave(leave)).toEqual({ ok: false, error: 'Only a supervisor can record paid leave.' });
    joined('supervisor', casey);
    expect(s().addLeave(leave)).toEqual({ ok: true });
    const entry = s().leave[s().leave.length - 1];
    joined('employee', casey);
    expect(s().removeLeave(entry.id)).toEqual({ ok: false, error: 'Only a supervisor can take off paid leave.' });
    expect(s().leave.some((l) => l.id === entry.id)).toBe(true);
    joined('supervisor', casey);
    expect(s().removeLeave(entry.id)).toEqual({ ok: true });
  });
});

describe('people on a connected phone', () => {
  it('are changed on the dashboard only, whoever is signed in', () => {
    s().signInDemo('supervisor');
    joined('supervisor', casey);
    const before = s().employees;
    expect(s().addEmployee('Dana', 'Fry')).toEqual({ ok: false, error: DASHBOARD });
    expect(s().addEmployeesBulk('Dana Fry\nLee Park')).toEqual({ added: 0, skipped: 2, error: DASHBOARD });
    expect(s().setEmployeeActive('emp_demo', false)).toEqual({ ok: false, error: DASHBOARD });
    expect(s().setEmployeeRole('emp_demo', 'supervisor')).toEqual({ ok: false, error: DASHBOARD });
    expect(s().setPayrollId('emp_demo', '004417')).toEqual({ ok: false, error: DASHBOARD });
    expect(s().employees).toBe(before);
  });

  it('are still changed on a phone never connected', () => {
    s().signInDemo('supervisor');
    expect(s().addEmployee('Dana', 'Fry')).toEqual({ ok: true });
    expect(s().setEmployeeRole('emp_demo', 'supervisor')).toEqual({ ok: true });
    expect(s().setEmployeeActive('emp_demo', false)).toEqual({ ok: true });
  });
});

describe('the fleet, the sheets and the settings on a connected phone', () => {
  const unit = { unit: 'T-99', category: 'haul_truck' as const, make: 'Made-up', model: 'HX 40', meter: 10, meterUnit: 'hrs' as const };
  const tries = () => [
    s().addEquipment(unit),
    s().removeEquipment(s().equipment[0].id),
    s().addAreaSheet('Test bench', 'Walkways\nGuards'),
    s().updateAreaSheet(s().areaSheets[0].id, 'Renamed', 'Walkways'),
    s().setAreaSheetActive(s().areaSheets[0].id, false),
    s().setCompany({ ...s().settings.company, place: 'Somewhere' }),
    s().setSitePin({ lat: 39.5, lng: -118.25 }),
    s().setRadius(900),
    s().setAllowSectionAllOk(true),
  ];

  it('are refused from a crew sign-in, and before the company’s records have come', () => {
    s().signInDemo('supervisor');
    joined('employee', casey);
    const before = { equipment: s().equipment, areaSheets: s().areaSheets, settings: s().settings };
    for (const answer of tries()) expect(answer).toEqual({ ok: false, error: CREW_SIGN_IN });
    joined('supervisor', casey, false);
    for (const answer of tries()) expect(answer).toEqual({ ok: false, error: NOT_YET });
    expect({ equipment: s().equipment, areaSheets: s().areaSheets, settings: s().settings }).toEqual(before);
  });

  it('are changed from a supervisor’s sign-in that is theirs, once the records have come, and on a phone never connected', () => {
    s().signInDemo('supervisor');
    joined('supervisor', casey);
    for (const answer of tries()) expect(answer.ok).toBe(true);
    s().resetDemo();
    s().signInDemo('supervisor');
    for (const answer of tries()) expect(answer.ok).toBe(true);
  });
});

describe('clocking in on a connected phone', () => {
  it('is refused to a person taken off the active roster, and clocking out never is', () => {
    s().signInDemo('employee');
    expect(s().clockIn(onSite).ok).toBe(true);
    useStore.setState({ employees: s().employees.map((e) => (e.id === 'emp_demo' ? { ...e, active: false } : e)) });
    expect(s().startLunch().ok).toBe(true);
    jest.setSystemTime(at(7));
    expect(s().clockOut().ok).toBe(true);
    expect(s().clockIn(onSite)).toEqual({ ok: false, error: 'You are no longer on the active roster. See your supervisor.' });
  });

  it('is refused to anyone on a phone whose sign-in is not on the company’s roster', () => {
    s().signInDemo('employee');
    joined('none', jordan);
    expect(s().clockIn(onSite)).toEqual({
      ok: false,
      error: 'This phone is not joined to Test Pit A any more, so a clock-in here would never reach payroll. See your supervisor.',
    });
  });
});

describe('making an account on a connected phone', () => {
  const input = (person: { firstName: string; lastName: string }, email: string) => ({ ...person, email, password: 'haulroad88' });

  it('on a phone joined with a crew sign-in, is only for that sign-in’s person', () => {
    joined('employee', jordan);
    expect(s().signUp(input(casey, 'casey@example.test'))).toEqual({
      ok: false,
      error: 'This phone is joined with Jordan Rivera’s company sign-in, so the account made here is theirs. Make yours on your own phone, or on a phone joined with a supervisor’s sign-in.',
    });
    expect(s().signUp(input(jordan, 'jordan@example.test'))).toEqual({ ok: true });
  });

  it('for a supervisor, needs the phone’s own supervisor sign-in and its password checked', () => {
    joined('supervisor', casey);
    expect(s().signUp(input(casey, 'casey@example.test'))).toMatchObject({ ok: false, error: expect.stringMatching(/^Enter the password of this phone’s company sign-in, sign-in@example.test\./) });
    expect(s().signUp({ ...input(casey, 'casey@example.test'), companyPasswordChecked: true })).toEqual({ ok: true });
  });

  it('makes the account of a supervisor whose sign-in is crew, and says it works as crew', () => {
    joined('employee', casey);
    expect(s().signUp(input(casey, 'casey@example.test'))).toEqual({
      ok: true,
      note: 'Casey Morgan is a supervisor in the app but crew on the company’s sign-in roster, so this account works as crew here. Ask the office to set the role on the dashboard’s Roster page.',
    });
    expect(s().addLeave({ employeeId: 'emp_demo', day: at(6), type: 'pto', hours: 800 })).toMatchObject({ ok: false });
  });

  it('is as it was on a phone never connected', () => {
    expect(s().signUp(input(casey, 'casey@example.test'))).toEqual({ ok: true });
  });
});
