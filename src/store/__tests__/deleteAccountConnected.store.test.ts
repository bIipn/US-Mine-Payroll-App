// Deleting an account on a phone joined to its company, in a build that keeps real records: its own
// made-up roster, no preview, no sample crew. A person whose own sign-in the company took off its
// roster deletes their account from the sign-in screen; the phone is cleared only once it has read the
// company's records to the end; and once the phone's own sign-in is deleted, nothing on it goes by
// that sign-in's name. Everyone here is made up.
import { signedInView } from '../../domain/access';
import { changesToSend, sortedChanges } from '../../domain/sync';
import { SAMPLE_CREW_IDS } from '../seed';

type Store = typeof import('../useStore');

/** The store as a build that keeps real records starts it. */
function realBuild(roster = 'Fry, Dana | Loader Operator\nPark, Lee | Crusher'): Store['useStore'] {
  const saved = { ...process.env };
  for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_SAMPLE_CREW', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
  Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_ROSTER: roster });
  let store: Store['useStore'] | undefined;
  jest.isolateModules(() => {
    store = (require('../useStore') as Store).useStore;
  });
  process.env = saved;
  return store!;
}

const DANA = { email: 'dana@example.com', password: 'haulroad88' };

/** Dana's own phone, joined to Test Pit A with Dana's own crew sign-in, which the company has just taken off its roster. */
function takenOffWithOwnSignIn() {
  const useStore = realBuild();
  const g = () => useStore.getState();
  g().ensureSeeded();
  expect(g().signUp({ firstName: 'Dana', lastName: 'Fry', ...DANA })).toMatchObject({ ok: true });
  const dana = g().employees.find((e) => e.lastName === 'Fry')!;
  useStore.setState({ connectedCompany: { id: 'c-test-a', name: 'Test Pit A', role: 'employee', userId: 'u-dana', email: DANA.email }, syncedWith: 'c-test-a' });
  const r = g().ensureReceiving()!;
  const ctx = { company: 'c-test-a', account: 'u-dana', epoch: r.epoch };
  expect(g().applyStanding(ctx, { role: 'employee', name: { firstName: 'Dana', lastName: 'Fry' } })).toBe(true);
  // The next round's standing read finds no row, and the round ends there: the roster that took Dana off never comes.
  expect(g().applyStanding({ ...ctx, epoch: g().receiving!.epoch }, null)).toBe(true);
  expect(g().receiving!.role).toBe('none');
  expect(g().employees.find((e) => e.id === dana.id)!.active).toBe(true);
  return { useStore, g, dana };
}

describe('a person whose own sign-in the company took off its roster', () => {
  it('is turned back at the sign-in screen as off the roster, so the screen offers to delete the account', () => {
    const { g } = takenOffWithOwnSignIn();
    const view = () => signedInView({ person: g().employees.find((e) => e.id === g().session?.employeeId), onTheClock: false, connected: true, receiving: g().receiving });
    expect(view()).toBe('out');
    g().signOut();
    expect(g().signIn(DANA.email, DANA.password)).toEqual(expect.objectContaining({ ok: false, offRoster: true }));
    expect(g().session).toBeNull();
  });

  it('deletes the account from the sign-in screen with its password, and nothing else', () => {
    const { g, dana } = takenOffWithOwnSignIn();
    g().signOut();
    const before = { employees: g().employees, shifts: g().shifts };
    expect(g().deleteAccountWithPassword(DANA.email, DANA.password)).toEqual({ ok: true });
    expect(g().accounts.some((a) => a.email === DANA.email)).toBe(false);
    expect({ employees: g().employees, shifts: g().shifts }).toEqual(before);
    expect(g().employees.some((e) => e.id === dana.id)).toBe(true);
  });

  it('is still sent to More, signed in, while the company has them on its roster', () => {
    const useStore = realBuild();
    const g = () => useStore.getState();
    g().ensureSeeded();
    expect(g().signUp({ firstName: 'Dana', lastName: 'Fry', ...DANA })).toMatchObject({ ok: true });
    useStore.setState({ connectedCompany: { id: 'c-test-a', name: 'Test Pit A', role: 'employee', userId: 'u-dana', email: DANA.email }, syncedWith: 'c-test-a' });
    const r = g().ensureReceiving()!;
    g().applyStanding({ company: 'c-test-a', account: 'u-dana', epoch: r.epoch }, { role: 'employee', name: { firstName: 'Dana', lastName: 'Fry' } });
    g().signOut();
    expect(g().deleteAccountWithPassword(DANA.email, DANA.password)).toEqual({ ok: false, error: 'Sign in, then delete your account on More.' });
    expect(g().signIn(DANA.email, DANA.password)).toEqual({ ok: true });
  });
});

describe('clearing the phone after the deletion', () => {
  it('keeps a phone holding a unit the company never got, while it has not read the company’s records to the end', () => {
    const useStore = realBuild('Fry, Dana | Shift Supervisor | supervisor\nPark, Lee | Crusher');
    const g = () => useStore.getState();
    g().ensureSeeded();
    expect(g().signUp({ firstName: 'Dana', lastName: 'Fry', ...DANA })).toMatchObject({ ok: true });
    // Before the phone joined anything, Dana (a supervisor here) put a loader in the fleet.
    expect(g().addEquipment({ unit: 'L-77', category: 'loader', make: 'Made', model: 'Up', meter: 120 })).toEqual({ ok: true });
    g().connectCompany({ id: 'c-test-a', name: 'Test Pit A', role: 'supervisor' }, { id: 'u-dana', email: DANA.email });
    const r = g().ensureReceiving()!;
    g().applyStanding({ company: 'c-test-a', account: 'u-dana', epoch: r.epoch }, { role: 'supervisor', name: { firstName: 'Dana', lastName: 'Fry' } });
    const here = () => {
      const now = g().receiving!;
      return { connected: true, role: now.role, caughtUp: now.caughtUpAt != null, unreadable: now.unreadable, held: now.held };
    };
    const first = changesToSend(g(), g().synced, SAMPLE_CREW_IDS, here());
    g().markSynced(first.map(({ key, rev }) => ({ key, rev })), 'c-test-a');
    expect(g().receiving!.caughtUpAt).toBeNull();
    const unitKey = `equipment:${g().equipment.find((e) => e.unit === 'L-77')!.id}`;
    expect(g().synced[unitKey]).toBeUndefined();
    // Not caught up: the unit is in no list at all, so nothing says it waits.
    const sorted = sortedChanges(g(), g().synced, SAMPLE_CREW_IDS, here());
    expect([...sorted.now, ...sorted.afterReceive, ...sorted.notTaken].map((c) => c.key)).not.toContain(unitKey);

    g().disconnectCompany();
    expect(g().deleteMyAccount({ clearPhone: true })).toEqual({ ok: true, cleared: false });
    expect(g().equipment.map((e) => e.unit)).toEqual(['L-77']);
  });
});

describe('once the phone’s own sign-in is deleted', () => {
  it('forgets who that sign-in was to the company, and the payroll IDs it brought', () => {
    const useStore = realBuild();
    const g = () => useStore.getState();
    g().ensureSeeded();
    useStore.setState({ connectedCompany: { id: 'c-test-a', name: 'Test Pit A', role: 'supervisor', userId: 'u-dana', email: DANA.email }, syncedWith: 'c-test-a' });
    const r = g().ensureReceiving()!;
    g().applyStanding({ company: 'c-test-a', account: 'u-dana', epoch: r.epoch }, { role: 'supervisor', name: { firstName: 'Dana', lastName: 'Fry' } });
    useStore.setState({ employees: g().employees.map((e) => (e.lastName === 'Park' ? { ...e, payrollId: 'P-100' } : e)) });

    g().signInDeleted();
    g().disconnectCompany();

    expect(g().receiving).toMatchObject({ role: 'none', name: null, company: 'c-test-a' });
    expect(g().employees.some((e) => e.payrollId)).toBe(false);
    // On a phone with nothing about a sign-in, there is nothing to forget.
    const fresh = realBuild();
    fresh.getState().ensureSeeded();
    fresh.getState().signInDeleted();
    expect(fresh.getState().receiving).toBeNull();
  });
});
