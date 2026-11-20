// Deleting an account on the phone: the account, its session, its own hourly rate, and nothing else of
// anyone's. The person's employee record and every record stay, and so do what the server was told
// (`synced`, `syncedWith`), unless the phone is cleared, which it is only when nothing on it would be
// lost: no other account on it, and everything it holds has reached the company. Nobody on the clock,
// and no made-up sample person, is deleted. A person taken off the roster deletes their account from the
// sign-in screen with its password. Everyone here is made up.
import { changesToSend } from '../../domain/sync';
import { SAMPLE_CREW_IDS } from '../seed';
import { useStore } from '../useStore';

const s = () => useStore.getState();
const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m, 0).getTime();
const NOT_SAMPLE = { email: 'dana@example.com', password: 'haulroad88' };

/** Two made-up people who are not in the sample crew, each with an account and a rate; Dana signed in. */
function twoAccounts() {
  s().signInDemo('supervisor');
  expect(s().addEmployee('Dana', 'Fry')).toEqual({ ok: true });
  expect(s().addEmployee('Lee', 'Park')).toEqual({ ok: true });
  s().signOut();
  expect(s().signUp({ firstName: 'Lee', lastName: 'Park', email: 'lee@example.com', password: 'crusher77' })).toMatchObject({ ok: true });
  expect(s().setMyRate(2650)).toEqual({ ok: true });
  s().signOut();
  expect(s().signUp({ firstName: 'Dana', lastName: 'Fry', ...NOT_SAMPLE })).toMatchObject({ ok: true });
  expect(s().setMyRate(2400)).toEqual({ ok: true });
  const dana = s().employees.find((e) => e.lastName === 'Fry')!;
  const lee = s().employees.find((e) => e.lastName === 'Park')!;
  return { dana, lee };
}

const shiftOf = (employeeId: string, clockIn: number, clockOut?: number) => ({
  id: `sh-${employeeId}-${clockIn}`,
  employeeId,
  clockIn: { at: clockIn },
  ...(clockOut ? { clockOut: { at: clockOut } } : null),
  lunches: [],
  breaks: [],
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(at(15));
  s().resetDemo();
});
afterEach(() => jest.useRealTimers());

describe('deleting the account signed in on this phone', () => {
  it('takes the account, its session and its own rate off the phone, and nothing of anyone else’s', () => {
    const { dana, lee } = twoAccounts();
    const shift = shiftOf(dana.id, at(6), at(14));
    useStore.setState({ shifts: [...s().shifts, shift], synced: { [`shift:${shift.id}`]: 'abc' }, syncedWith: 'c-test-a' });
    const before = { employees: s().employees, shifts: s().shifts, inspections: s().inspections, exams: s().exams, mrfs: s().mrfs, leave: s().leave };
    const others = s().accounts.filter((a) => a.email !== NOT_SAMPLE.email);

    expect(s().deleteMyAccount({ clearPhone: false })).toEqual({ ok: true, cleared: false });

    expect(s().session).toBeNull();
    expect(s().accounts).toEqual(others);
    expect(s().accounts.some((a) => a.employeeId === dana.id)).toBe(false);
    expect(s().payRates[dana.id]).toBeUndefined();
    expect(s().payRates[lee.id]).toBe(2650);
    // The person stays on the roster, and every record stays where it was.
    expect({ employees: s().employees, shifts: s().shifts, inspections: s().inspections, exams: s().exams, mrfs: s().mrfs, leave: s().leave }).toEqual(before);
    expect(s().synced).toEqual({ [`shift:${shift.id}`]: 'abc' });
    expect(s().syncedWith).toBe('c-test-a');
    // Lee still signs in; Dana's email and password no longer do, and Dana can make a new account.
    expect(s().signIn('lee@example.com', 'crusher77')).toEqual({ ok: true });
    s().signOut();
    expect(s().signIn(NOT_SAMPLE.email, NOT_SAMPLE.password)).toMatchObject({ ok: false });
    expect(s().signUp({ firstName: 'Dana', lastName: 'Fry', ...NOT_SAMPLE })).toMatchObject({ ok: true });
  });

  it('is refused on the clock and at lunch, and changes nothing', () => {
    twoAccounts();
    const geo = { lat: 1, lng: 1, accuracyM: 6, distanceM: 10, inside: true, source: 'gps' as const };
    expect(s().clockIn(geo).ok).toBe(true);
    const before = s().accounts;
    expect(s().deleteMyAccount({ clearPhone: false })).toEqual({ ok: false, error: 'You are on the clock. Clock out, then delete your account.' });
    jest.setSystemTime(at(15, 30));
    expect(s().startLunch(geo).ok).toBe(true);
    expect(s().deleteMyAccount({ clearPhone: false })).toEqual({ ok: false, error: 'You are at lunch until 4:00 PM. Clock out after that, then delete your account.' });
    expect(s().accounts).toBe(before);
    expect(s().session).not.toBeNull();
    jest.setSystemTime(at(16, 5));
    expect(s().clockOut(geo).ok).toBe(true);
    expect(s().deleteMyAccount({ clearPhone: false })).toEqual({ ok: true, cleared: false });
  });

  it('deletes no made-up sample person’s account', () => {
    s().signInDemo('employee');
    const me = s().session!.employeeId;
    expect(SAMPLE_CREW_IDS.has(me)).toBe(true);
    const before = s().accounts;
    expect(s().deleteMyAccount({ clearPhone: true })).toEqual({ ok: false, error: 'Sample accounts are not deleted. To start over, reset the sample data on More.' });
    expect(s().accounts).toBe(before);
    expect(s().session?.employeeId).toBe(me);
  });

  it('needs someone signed in', () => {
    expect(s().deleteMyAccount({ clearPhone: false })).toEqual({ ok: false, error: 'You are signed out.' });
  });
});

describe('an account taken off the roster, deleted from the sign-in screen', () => {
  it('needs the account’s password, and keeps the person and their records', () => {
    const { dana, lee } = twoAccounts();
    s().signOut();
    s().signInDemo('supervisor');
    expect(s().setEmployeeActive(dana.id, false)).toEqual({ ok: true });
    s().signOut();
    // The sign-in screen: the password is right, but the person is off the roster.
    expect(s().signIn(NOT_SAMPLE.email, NOT_SAMPLE.password)).toEqual({ ok: false, error: 'This account is no longer on the active roster. See your supervisor.', offRoster: true });
    expect(s().signIn(NOT_SAMPLE.email, 'wrong-password')).toEqual({ ok: false, error: 'That email and password do not match an account.' });

    expect(s().deleteAccountWithPassword(NOT_SAMPLE.email, 'wrong-password')).toEqual({ ok: false, error: 'That email and password do not match an account.' });
    expect(s().accounts.some((a) => a.employeeId === dana.id)).toBe(true);
    const employees = s().employees;
    expect(s().deleteAccountWithPassword(' Dana@Example.com ', NOT_SAMPLE.password)).toEqual({ ok: true });
    expect(s().accounts.some((a) => a.employeeId === dana.id)).toBe(false);
    expect(s().payRates[dana.id]).toBeUndefined();
    expect(s().payRates[lee.id]).toBe(2650);
    expect(s().employees).toBe(employees);
  });

  it('is for a person off the roster: anyone else signs in and deletes it on More', () => {
    twoAccounts();
    s().signOut();
    expect(s().deleteAccountWithPassword('lee@example.com', 'crusher77')).toEqual({ ok: false, error: 'Sign in, then delete your account on More.' });
    expect(s().accounts.some((a) => a.email === 'lee@example.com')).toBe(true);
  });

  it('waits for a shift still open on this phone to be ended', () => {
    const { dana } = twoAccounts();
    const geo = { lat: 1, lng: 1, accuracyM: 6, distanceM: 10, inside: true, source: 'gps' as const };
    expect(s().clockIn(geo).ok).toBe(true);
    s().signOut();
    s().signInDemo('supervisor');
    expect(s().setEmployeeActive(dana.id, false)).toEqual({ ok: true });
    s().signOut();
    expect(s().deleteAccountWithPassword(NOT_SAMPLE.email, NOT_SAMPLE.password)).toEqual({
      ok: false,
      error: 'You are still on the clock on this phone. Ask a supervisor to set the end of your shift, then delete this account.',
    });
  });
});

// ---- Clearing the phone, in a build that keeps real records -----------------------------------------

type Store = typeof import('../useStore');
/** The store as a build that keeps real records starts it: its own roster, no preview, no sample crew. */
function realBuild(): Store['useStore'] {
  const saved = { ...process.env };
  for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_SAMPLE_CREW', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
  Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_ROSTER: 'Fry, Dana | Loader Operator\nPark, Lee | Crusher' });
  let store: Store['useStore'] | undefined;
  jest.isolateModules(() => {
    store = (require('../useStore') as Store).useStore;
  });
  process.env = saved;
  return store!;
}

describe('clearing the phone with the account', () => {
  /** Dana's own phone: Dana's account alone, joined to Test Pit A with Dana's sign-in, one shift made. */
  function ownPhone(useStore: Store['useStore']) {
    const g = () => useStore.getState();
    g().ensureSeeded();
    expect(g().signUp({ firstName: 'Dana', lastName: 'Fry', ...NOT_SAMPLE })).toMatchObject({ ok: true });
    expect(g().setMyRate(2400)).toEqual({ ok: true });
    const dana = g().employees.find((e) => e.lastName === 'Fry')!;
    useStore.setState({
      shifts: [shiftOf(dana.id, at(6), at(14))],
      connectedCompany: { id: 'c-test-a', name: 'Test Pit A', role: 'employee', userId: 'u-dana', email: NOT_SAMPLE.email },
      syncedWith: 'c-test-a',
    });
    const receiving = g().ensureReceiving()!;
    useStore.setState({ receiving: { ...receiving, role: 'employee', name: { firstName: 'Dana', lastName: 'Fry' }, caughtUpAt: at(7) } });
    return { g, dana };
  }
  /** The company has every version this phone holds. */
  function allSent(useStore: Store['useStore']) {
    const g = useStore.getState();
    const r = g.receiving!;
    const waiting = changesToSend(g, g.synced, SAMPLE_CREW_IDS, { connected: true, role: r.role, caughtUp: true, unreadable: r.unreadable, held: r.held });
    g.markSynced(waiting.map(({ key, rev }) => ({ key, rev })), 'c-test-a');
  }

  it('clears it when nothing on it would be lost, and it starts as the build does', () => {
    const useStore = realBuild();
    const { g } = ownPhone(useStore);
    allSent(useStore);
    expect(Object.keys(g().synced).length).toBeGreaterThan(0);
    g().disconnectCompany();
    expect(g().deleteMyAccount({ clearPhone: true })).toEqual({ ok: true, cleared: true });
    expect(g().accounts).toEqual([]);
    expect(g().session).toBeNull();
    expect(g().shifts).toEqual([]);
    expect(g().payRates).toEqual({});
    expect(g().synced).toEqual({});
    expect(g().syncedWith).toBeNull();
    expect(g().receiving).toBeNull();
    expect(g().employees.map((e) => e.lastName).sort()).toEqual(['Fry', 'Park']);
  });

  it('keeps everything but the account when something has not reached the company', () => {
    const useStore = realBuild();
    const { g, dana } = ownPhone(useStore);
    allSent(useStore);
    // A shift made after the last send.
    useStore.setState({ shifts: [...g().shifts, shiftOf(dana.id, at(15), at(16))] });
    g().disconnectCompany();
    const { shifts, synced, syncedWith } = g();
    expect(g().deleteMyAccount({ clearPhone: true })).toEqual({ ok: true, cleared: false });
    expect(g().accounts).toEqual([]);
    expect(g().shifts).toBe(shifts);
    expect(g().synced).toBe(synced);
    expect(g().syncedWith).toBe(syncedWith);
  });

  it('keeps everything but the account when someone else has an account on the phone', () => {
    const useStore = realBuild();
    const { g } = ownPhone(useStore);
    allSent(useStore);
    // Lee made an account on this phone before it was joined.
    useStore.setState({ accounts: [...g().accounts, { id: 'acct-lee', employeeId: g().employees.find((e) => e.lastName === 'Park')!.id, email: 'lee@example.com', provider: 'password', createdAt: at(5) }] });
    g().disconnectCompany();
    expect(g().deleteMyAccount({ clearPhone: true })).toEqual({ ok: true, cleared: false });
    expect(g().accounts.map((a) => a.email)).toEqual(['lee@example.com']);
    expect(g().shifts).toHaveLength(1);
  });

  it('never clears a phone that never joined a company', () => {
    const useStore = realBuild();
    const g = () => useStore.getState();
    g().ensureSeeded();
    expect(g().signUp({ firstName: 'Dana', lastName: 'Fry', ...NOT_SAMPLE })).toMatchObject({ ok: true });
    useStore.setState({ shifts: [shiftOf(g().session!.employeeId, at(6), at(14))] });
    expect(g().deleteMyAccount({ clearPhone: true })).toEqual({ ok: true, cleared: false });
    expect(g().shifts).toHaveLength(1);
  });
});
