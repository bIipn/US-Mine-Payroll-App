// Company account, signing out of a phone and deleting an account, in a build that names a company server.
// One person per phone: a crew member signs in with the company code, a name and a passcode and has no
// email, a supervisor with email; signing out empties the phone, so it waits until everything on it has
// reached the company. The real screens run with the real connection, store and sync; only the company
// server's calls are stand-ins (src/services/server.ts itself), so no request leaves the test. Screens
// these do not look at are stand-ins showing their names. Everyone and every company here is made up.
import type { CrewAnswer } from '../../domain/serverAnswers';
import type { ReceivedRow } from '../../domain/sync';
import type { Equipment, OperatingLog, Shift } from '../../domain/types';

/** Who is signed in to the company server, as the server module tells connection.ts. */
type MockHeard = (signedIn: unknown) => void;
const mockScreen = (name: string) => {
  const R = require('react');
  const { Text } = require('react-native');
  return () => R.createElement(Text, null, name);
};
jest.mock('../auth/AuthScreen', () => ({ AuthScreen: mockScreen('Auth') }));
jest.mock('../clock/ClockScreen', () => ({ ClockScreen: mockScreen('Clock') }));
jest.mock('../equipment/ChecklistCardScreen', () => ({ ChecklistCardScreen: mockScreen('ChecklistCard') }));
jest.mock('../equipment/EndUseScreen', () => ({ EndUseScreen: mockScreen('EndUse') }));
jest.mock('../equipment/EquipmentScreen', () => ({ EquipmentScreen: mockScreen('Equipment') }));
jest.mock('../equipment/InspectionDetailScreen', () => ({ InspectionDetailScreen: mockScreen('InspectionDetail') }));
jest.mock('../equipment/InspectionResultScreen', () => ({ InspectionResultScreen: mockScreen('InspectionResult') }));
jest.mock('../equipment/InspectionScreen', () => ({ InspectionScreen: mockScreen('Inspection') }));
jest.mock('../equipment/MrfDetailScreen', () => ({ MrfDetailScreen: mockScreen('MrfDetail') }));
jest.mock('../equipment/MrfFormScreen', () => ({ MrfFormScreen: mockScreen('MrfForm') }));
jest.mock('../exam/AreaExamDetailScreen', () => ({ AreaExamDetailScreen: mockScreen('AreaExamDetail') }));
jest.mock('../exam/AreaExamScreen', () => ({ AreaExamScreen: mockScreen('AreaExam') }));
jest.mock('../hours/HoursScreen', () => ({ HoursScreen: mockScreen('Hours') }));
jest.mock('../hours/ShiftDetailScreen', () => ({ ShiftDetailScreen: mockScreen('ShiftDetail') }));
jest.mock('../more/CompanyScreen', () => ({ CompanyScreen: mockScreen('Company') }));
jest.mock('../more/MyRecordsScreen', () => ({ MyRecordsScreen: mockScreen('MyRecords') }));
jest.mock('../more/SiteScreen', () => ({ SiteScreen: mockScreen('Site') }));
jest.mock('../more/StandardsScreen', () => ({ StandardsScreen: mockScreen('Standards') }));
jest.mock('../supervisor/AreaSheetsScreen', () => ({ AreaSheetsScreen: mockScreen('AreaSheets') }));
jest.mock('../supervisor/CrewScreen', () => ({ CrewScreen: mockScreen('Crew') }));
jest.mock('../supervisor/FleetScreen', () => ({ FleetScreen: mockScreen('Fleet') }));
jest.mock('../supervisor/MrfQueueScreen', () => ({ MrfQueueScreen: mockScreen('MrfQueue') }));
jest.mock('../supervisor/OnSiteScreen', () => ({ OnSiteScreen: mockScreen('OnSite') }));
jest.mock('../supervisor/PayrollEmployeeScreen', () => ({ PayrollEmployeeScreen: mockScreen('PayrollEmployee') }));
jest.mock('../supervisor/PayrollScreen', () => ({ PayrollScreen: mockScreen('Payroll') }));
jest.mock('../supervisor/RosterScreen', () => ({ RosterScreen: mockScreen('Roster') }));
jest.mock('../supervisor/SafetyLogScreen', () => ({ SafetyLogScreen: mockScreen('SafetyLog') }));
jest.mock('../supervisor/TimeLogsScreen', () => ({ TimeLogsScreen: mockScreen('TimeLogs') }));
// lucide's files are not transformed under Jest; any icon draws nothing here. So do the logos.
jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, HAS_LOGO_ART: false }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('../../services/notifications', () => ({ requestNotificationPermission: async () => true, cancelLocal: async () => undefined, scheduleLocal: async () => undefined }));
jest.mock('expo-network', () => ({ getNetworkStateAsync: async () => ({ isConnected: true }), addNetworkStateListener: () => ({ remove() {} }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
// The company server, as src/services/server.ts hands it to connection.ts: who is signed in to it on this
// phone, which `mockTell` changes as supabase-js would tell it, and each call a stub the tests answer.
jest.mock('../../services/server', () => {
  const listeners = new Set<MockHeard>();
  const now: { signedIn: unknown } = { signedIn: null };
  const mockTell = (signedIn: unknown) => {
    now.signedIn = signedIn;
    for (const heard of [...listeners]) heard(signedIn);
  };
  return {
    configured: true,
    mockTell,
    onAccountChange: (heard: MockHeard) => {
      listeners.add(heard);
      void Promise.resolve().then(() => heard(now.signedIn));
      return () => listeners.delete(heard);
    },
    signOut: jest.fn(async () => mockTell(null)),
    signIn: jest.fn(),
    resetPassword: jest.fn(),
    crewAuth: jest.fn(),
    startCrewSession: jest.fn(),
    signOutOtherSessions: jest.fn(async () => ({ ok: true })),
    myCompanies: jest.fn(),
    myJoinRequests: jest.fn(async () => ({ ok: true, requests: [] })),
    deletionCheck: jest.fn(),
    deleteAccount: jest.fn(),
    deleteAccountWithPasscode: jest.fn(),
    // Rounds do not run here (nothing starts sync.ts), so the transport is never asked anything.
    companyTransport: (company: string) => ({ company, push: async () => ({ took: [], stale: [], floored: [], held: [] }) }),
  };
});

// A store build: it connects (EXPO_PUBLIC_DEMO=0, a server named), holds nobody made up and names nobody.
// Set before anything below is required, so config.ts, useStore.ts and RootNavigator.tsx read it.
const savedEnv = { ...process.env };
for (const key of ['EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
Object.assign(process.env, {
  EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_test',
  EXPO_PUBLIC_DEMO: '0',
  EXPO_PUBLIC_SAMPLE_CREW: '0',
});
afterAll(() => {
  process.env = savedEnv;
});

type Fiber = { return: Fiber | null; memoizedProps?: Record<string, unknown> } | null;
type Node = { props: Record<string, unknown>; unstable_fiber: unknown };
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[]; toJSON(): unknown } };
/** The app's navigator, as the tests move about it: any screen of the stack, or a tab. */
type Ref = import('@react-navigation/native').NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>;
const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const nav = require('@react-navigation/native') as typeof import('@react-navigation/native');
const { RootNavigator } = require('../../navigation/RootNavigator') as typeof import('../../navigation/RootNavigator');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const { changesToSend, revOf } = require('../../domain/sync') as typeof import('../../domain/sync');
const { SAMPLE_CREW_IDS } = require('../../store/seed') as typeof import('../../store/seed');
const { useSyncStatus } = require('../../services/sync') as typeof import('../../services/sync');
const connection = require('../../services/connection') as typeof import('../../services/connection');
const server = require('../../services/server') as Record<string, jest.Mock> & { mockTell: (account: unknown) => void };
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PIT_A = { id: 'c-test-a', name: 'Test Pit A' };
/** Blake's passcode sign-in as the phone has it: a passcode account's hidden address never reaches the app. */
const BLAKE = { id: 'u-blake', email: '', kind: 'passcode' as const };
/** The hidden address Supabase Auth keeps for Blake's sign-in. A phone joined on an earlier build kept it. */
const HIDDEN = 'crew-7c1d2e3f@crew.example.test';
const AVERY = { id: 'u-avery', email: 'avery@example.test', kind: 'email' as const };
const T99: Equipment = { id: 'eq-t99', unit: 'T-99', category: 'haul_truck', make: 'Made-up', model: 'HX 40', status: 'ready', meter: 100, meterUnit: 'hrs' };

let seq = 0;
/** A row of the company's records as read_shared_records hands it over. */
function row(kind: ReceivedRow['kind'], id: string, data: object): ReceivedRow {
  seq += 1;
  return { kind, id, rev: revOf(data), seq, deleted: false, data };
}
const person = (id: string, firstName: string, lastName: string, role: 'employee' | 'supervisor' = 'employee') => row('employee', id, { id, firstName, lastName, role, active: true });
const SETTINGS = () => row('settings', 'company', { company: { name: 'Test Pit A', state: 'NV', pay: null }, site: null, workweekStartsOn: 0, allowSectionAllOk: true });

let root: Root | null = null;
let stopLink: (() => void) | null = null;
beforeEach(() => {
  seq = 0;
  for (const call of Object.values(server)) if (typeof call === 'function' && 'mockReset' in call) (call as jest.Mock).mockReset();
  server.signOut.mockImplementation(async () => server.mockTell(null));
  server.signOutOtherSessions.mockResolvedValue({ ok: true });
  server.myJoinRequests.mockResolvedValue({ ok: true, requests: [] });
  server.myCompanies.mockResolvedValue({ ok: true, companies: [{ ...PIT_A, role: 'employee' }] });
  server.deletionCheck.mockResolvedValue({ ok: true, companies: [{ id: PIT_A.id, name: PIT_A.name, role: 'employee', lastSupervisor: false, successors: [], canClose: false, closeFrom: null, running: null }] });
  server.mockTell(null);
  useSyncStatus.setState({ online: true, trouble: null, sending: false });
});
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  stopLink?.();
  stopLink = null;
  connection.useServerAccount.setState({ known: false, account: null, notOnLinked: false, checking: false, unchecked: false, joinCode: null, signingOut: false });
});

/** Let the stand-ins answer and the screens take what they said. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
const shown = () => JSON.stringify(root!.container.toJSON());
/** What the screen with this test ID shows, and nothing of the screens under it on the stack. */
const shownOn = (id: string) => {
  const screen = byId(id)[0] as (Node & { toJSON(): unknown }) | undefined;
  if (!screen) throw new Error(`No ${id} here.`);
  return JSON.stringify(screen.toJSON());
};
const byId = (id: string) => root!.container.queryAll((n) => n.props.testID === id);
function input(id: string): Node {
  const found = root!.container.queryAll((n) => n.props.testID === id && typeof n.props.onChangeText === 'function')[0];
  if (!found) throw new Error(`No text box ${id} here.`);
  return found;
}
async function type(id: string, text: string) {
  await act(async () => (input(id).props.onChangeText as (t: string) => void)(text));
  await settle();
}
/** A tap, as a finger makes it: the onPress of the nearest component that has one, unless it is turned off. */
async function press(id: string) {
  const found = byId(id)[0];
  if (!found) throw new Error(`No ${id} here.`);
  let fiber = found.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error(`Nothing to press at ${id}.`);
  const props = fiber.memoizedProps!;
  if (props.disabled === true || (props.accessibilityState as { disabled?: boolean } | undefined)?.disabled) throw new Error(`${id} cannot be pressed now.`);
  await act(async () => (props.onPress as () => void)());
  await settle();
}

/**
 * A phone joined to Test Pit A with this sign-in, after a round read the company's records: the sign-in's
 * own person's account is open, unless the company found no roster row for the sign-in. `held` is the
 * address an earlier build kept with the company the phone sends to. Then the app, as it starts.
 */
async function joinedPhone({
  signIn = BLAKE as typeof BLAKE | typeof AVERY,
  name = { firstName: 'Blake', lastName: 'Rook' },
  role = 'employee' as 'employee' | 'supervisor' | 'none',
  held = '',
  signedIn = true,
  records = (_me: string) => ({}) as Partial<{ shifts: Shift[]; opLogs: OperatingLog[] }>,
} = {}): Promise<Ref> {
  const g = useStore.getState;
  g().resetDemo();
  g().ensureSeeded();
  expect(g().connectCompany({ ...PIT_A, role: role === 'none' ? 'employee' : role }, { id: signIn.id, email: held || signIn.email })).toEqual({ ok: true });
  g().ensureReceiving();
  const ctx = () => ({ company: PIT_A.id, account: signIn.id, epoch: g().receiving!.epoch });
  g().applyStanding(ctx(), { role: role === 'none' ? 'employee' : role, name });
  g().applyReceived(ctx(), [SETTINGS(), person('emp-blake', 'Blake', 'Rook'), person('emp-avery', 'Avery', 'Quill', 'supervisor'), row('equipment', T99.id, T99)]);
  g().applyReceived(ctx(), []);
  // Off the roster: the next round's standing read found no row, and stopped there (sync.ts).
  if (role === 'none') g().applyStanding(ctx(), null);
  const me = g().session?.employeeId ?? 'emp-blake';
  useStore.setState(records(me));
  server.mockTell(signedIn ? signIn : null);
  const ref = nav.createNavigationContainerRef<ReactNavigation.RootParamList>();
  root = createRoot();
  const r = root;
  await act(async () => {
    stopLink = connection.watchConnection();
    r.render(React.createElement(nav.NavigationContainer, { ref } as never, React.createElement(RootNavigator)));
  });
  await settle();
  // The round that started with the connection says why nothing more goes: the sign-in is off the roster.
  if (role === 'none') await act(async () => useSyncStatus.setState({ trouble: 'not_member' }));
  return ref;
}
/** Go to a screen, as a tap on its row or tab would. */
const go = async (ref: Ref, name: 'CompanyAccount' | 'DeleteAccount' | 'Main', params?: object) => {
  await act(async () => (ref.navigate as (screen: string, with_?: object) => void)(name, params));
  await settle();
};
/** Records on the phone a round would send now. */
const waiting = () => {
  const s = useStore.getState();
  const r = s.receiving!;
  return changesToSend(s, s.synced, SAMPLE_CREW_IDS, { connected: true, role: r.role, caughtUp: r.caughtUpAt != null, unreadable: r.unreadable, held: r.held });
};
const doneShift = (id: string, employeeId: string): Shift => ({ id, employeeId, clockIn: { at: Date.now() - 9 * 3_600_000 }, clockOut: { at: Date.now() - 8 * 3_600_000 }, lunches: [], breaks: [] });

describe('Company account', () => {
  it('no longer shows an email sign-in or a join form', async () => {
    const ref = await joinedPhone();
    expect(useStore.getState().session?.employeeId).toBe('emp-blake');
    await go(ref, 'CompanyAccount');
    expect(byId('company-account-screen')).not.toHaveLength(0);
    for (const gone of ['server-email', 'server-password', 'server-mode', 'server-code', 'server-join', 'server-disconnect']) expect({ gone, here: byId(gone).length }).toEqual({ gone, here: 0 });
    expect(shown()).not.toMatch(/Join your company|Create account|Disconnect this phone/);
    // The connected view: who is signed in, by name, and signing out and deleting.
    expect(shown()).toContain('Signed in as Blake Rook');
    expect(shown()).toContain('With the company code and a passcode');
    expect(byId('server-sign-out-phone')).not.toHaveLength(0);
    expect(byId('server-delete-sign-in')).not.toHaveLength(0);

    // An account kept on a phone joined to no company (an older phone, say): no form to join it from here.
    await act(async () => useStore.getState().disconnectCompany());
    await settle();
    expect(byId('company-not-connected')).not.toHaveLength(0);
    for (const gone of ['server-email', 'server-code', 'server-join', 'crew-code']) expect({ gone, here: byId(gone).length }).toEqual({ gone, here: 0 });
  });

  it('signs a signed-out crew sign-in in again with the company code, the name and the passcode', async () => {
    const ref = await joinedPhone({ signedIn: false });
    await go(ref, 'CompanyAccount');
    expect(shown()).toContain('Signed out of the company server');
    expect(byId('company-sign-in-again')).not.toHaveLength(0);
    expect(byId('server-email')).toHaveLength(0);

    server.crewAuth.mockImplementation(async (action: string): Promise<CrewAnswer> =>
      action === 'lookup'
        ? { kind: 'company', name: PIT_A.name, state: 'NV' }
        : { kind: 'signed_in', session: { accessToken: 'a-1', refreshToken: 'r-1', expiresAt: 1_900_000_000, userId: BLAKE.id }, company: PIT_A, waiting: false, join: null, othersSignedOut: true },
    );
    server.startCrewSession.mockImplementation(async () => {
      server.mockTell(BLAKE);
      return { ok: true, account: BLAKE };
    });
    await type('crew-code', 'abcd2345');
    // It opens on Sign in: no second passcode box, as for signing up.
    expect(byId('crew-passcode-again')).toHaveLength(0);
    await type('crew-first', 'Blake');
    await type('crew-last', 'Rook');
    await type('crew-passcode', '582039');
    await press('crew-submit');
    expect(server.crewAuth.mock.calls.filter(([a]) => a === 'sign_in').map(([, body]) => body)).toEqual([{ code: 'ABCD2345', first_name: 'Blake', last_name: 'Rook', passcode: '582039' }]);
    expect(server.startCrewSession).toHaveBeenCalledTimes(1);
    expect(shown()).toContain('Signed in as Blake Rook');

    // Signed up with an email before passcodes: email is there too, and no address is filled in for a crew sign-in.
    await act(async () => server.mockTell(null));
    await settle();
    await press('company-again-with-email');
    expect(input('server-email').props.value).toBe('');
  });

  it('signs a signed-out supervisor in again with email, the address filled in', async () => {
    const ref = await joinedPhone({ signIn: AVERY, name: { firstName: 'Avery', lastName: 'Quill' }, role: 'supervisor', signedIn: false });
    await go(ref, 'CompanyAccount');
    expect(byId('crew-code')).toHaveLength(0);
    expect(input('server-email').props.value).toBe('avery@example.test');
    server.signIn.mockImplementation(async () => {
      server.mockTell(AVERY);
      return { ok: true, account: AVERY };
    });
    await type('server-password', 'haulroad88');
    await press('server-submit');
    expect(server.signIn).toHaveBeenCalledWith('avery@example.test', 'haulroad88');
    expect(shown()).toContain('Signed in as Avery Quill');
  });
});

describe('a crew member’s hidden address', () => {
  it('is shown nowhere: Company account, More and Delete my account show the person’s name', async () => {
    // Joined on an earlier build, which kept the hidden address with the company the phone sends to.
    const ref = await joinedPhone({ held: HIDDEN });
    expect(useStore.getState().connectedCompany?.email).toBe('');
    const nowhere = () => {
      expect(shown()).not.toContain(HIDDEN);
      expect(shown()).not.toContain('@');
    };
    await go(ref, 'Main', { screen: 'More' });
    expect(byId('more-screen')).not.toHaveLength(0);
    expect(shown()).toContain('Blake Rook');
    expect(shown()).toContain('Your sign-in, passcode and hourly rate. Your work records stay with Test Pit A.');
    nowhere();
    await go(ref, 'CompanyAccount');
    expect(shown()).toContain('Signed in as Blake Rook');
    nowhere();
    await go(ref, 'DeleteAccount');
    expect(byId('delete-passcode')).not.toHaveLength(0);
    nowhere();
    // Its words say nothing of a password: a passcode is what is checked.
    expect(shownOn('delete-account-screen')).not.toMatch(/password|e-?mail/i);
  });
});

describe('signing out of this phone', () => {
  it('is refused while anything is unsent, says signing back in needs signal, and gives every blocker its button', async () => {
    const ref = await joinedPhone({
      records: (me) => ({
        // On the clock, a unit checked out, and a shift done earlier: none of it on the company's server yet.
        shifts: [doneShift('sh-done', me), { id: 'sh-open', employeeId: me, clockIn: { at: Date.now() - 3_600_000 }, lunches: [], breaks: [] }],
        opLogs: [{ id: 'op-t99', equipmentId: T99.id, employeeId: me, inspectionId: 'insp-t99', startAt: Date.now() - 3_600_000, startMeter: 100 }],
      }),
    });
    await go(ref, 'Main', { screen: 'More' });
    await press('sign-out');
    expect(byId('sign-out-sheet')).not.toHaveLength(0);
    expect(shown()).toContain('Sign out of this phone?');
    expect(shown()).toContain('Once everything on this phone has reached Test Pit A, the phone is emptied');
    expect(shown()).toContain('Signing back in needs signal.');

    await press('sign-out-confirm');
    expect(shown()).toContain('Not signed out yet');
    expect(shown()).toContain('Nothing has been taken off this phone.');
    for (const kind of ['on_clock', 'unit_out', 'waiting']) expect({ kind, here: byId(`sign-out-blocker-${kind}`).length > 0 }).toEqual({ kind, here: true });
    expect(byId('sign-out-clock')).not.toHaveLength(0);
    expect(byId('sign-out-send')).not.toHaveLength(0);
    // Nothing was signed out or taken off the phone.
    expect(useStore.getState()).toMatchObject({ session: { employeeId: 'emp-blake' }, connectedCompany: { id: PIT_A.id } });
    expect(useStore.getState().shifts).toHaveLength(2);
    expect(server.signOut).not.toHaveBeenCalled();

    // End use is on the Checklists screen's equipment list.
    await press('sign-out-checklists');
    expect(ref.getCurrentRoute()).toMatchObject({ name: 'Equipment', params: { tab: 'equipment' } });
  });

  it('says first what holds nothing up: an old shift never clocked out, which only a supervisor can end now', async () => {
    const stale: Shift = { id: 'sh-old', employeeId: 'emp-blake', clockIn: { at: Date.now() - 20 * 3_600_000 }, lunches: [], breaks: [] };
    const ref = await joinedPhone({ records: () => ({ shifts: [stale] }) });
    // The company has it already: nothing waits.
    await act(async () => useStore.getState().markSynced(waiting().map(({ key, rev }) => ({ key, rev })), PIT_A.id));
    expect(waiting()).toEqual([]);
    await go(ref, 'Main', { screen: 'More' });
    await press('sign-out');
    expect(shown()).toMatch(/Your shift of [^"]+ has no clock-out\. It counts no hours until a supervisor sets its end\./);
  });

  it('lists every record the company turned down that holds it up, those marked Done on More among them', async () => {
    const ref = await joinedPhone({ records: (me) => ({ shifts: [doneShift('sh-done', me)] }) });
    // The company turned the shift down (signed on another phone first), and Blake marked it Done on More.
    const change = waiting()[0];
    await act(async () => {
      useStore.getState().holdRefused([{ key: change.key, rev: change.rev, reason: 'signed' }], PIT_A.id);
      useStore.getState().dismissHeld([change]);
    });
    await go(ref, 'Main', { screen: 'More' });
    expect(byId(`not-taken-${change.key}`)).toHaveLength(0);
    await press('sign-out');
    await press('sign-out-confirm');
    expect(byId('sign-out-blocker-not_taken')).not.toHaveLength(0);
    expect(byId(`sign-out-record-${change.key}`)).not.toHaveLength(0);
    expect(shown()).toContain('Already signed: a signed record is not changed.');
  });

  it('once everything has reached the company, empties the phone, and the sign-in screen waits for the server’s sign-out', async () => {
    const ref = await joinedPhone();
    expect(waiting()).toEqual([]);
    let signedOut: () => void = () => undefined;
    server.signOut.mockImplementation(async () => {
      await new Promise<void>((resolve) => (signedOut = resolve));
      server.mockTell(null);
    });
    await go(ref, 'Main', { screen: 'More' });
    await press('sign-out');
    await press('sign-out-confirm');
    // Emptied, as a new phone starts; the account is still signed in to the server until its sign-out is over.
    expect(useStore.getState()).toMatchObject({ session: null, accounts: [], connectedCompany: null });
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
    expect(byId('company-signing-out')).not.toHaveLength(0);
    expect(server.myCompanies).not.toHaveBeenCalled();

    await act(async () => signedOut());
    await settle();
    expect(byId('crew-code')).not.toHaveLength(0);
    expect(server.myCompanies).not.toHaveBeenCalled();
    expect(useStore.getState().connectedCompany).toBeNull();
  });
});

describe('Delete my account', () => {
  it('a passcode account deletes with its passcode, and is told what stays with the company', async () => {
    const ref = await joinedPhone();
    await go(ref, 'DeleteAccount');
    await settle();
    expect(shown()).toContain('What stays with Test Pit A');
    expect(shown()).toContain('Your name on Test Pit A’s roster. A supervisor takes it off when you leave.');
    expect(shown()).toContain('Your company sign-in and its passcode, on MineMuster’s server. It stops working on every phone.');
    // The number pad, hidden as it is typed; and no password box.
    expect(input('delete-passcode').props).toMatchObject({ keyboardType: 'number-pad', secureTextEntry: true });
    expect(byId('delete-password')).toHaveLength(0);

    server.deleteAccountWithPasscode.mockResolvedValue({ ok: true, closed: [] });
    await type('delete-passcode', '582039');
    await press('delete-confirm');
    expect(server.deleteAccountWithPasscode).toHaveBeenCalledWith('582039');
    expect(server.deleteAccount).not.toHaveBeenCalled();
    expect(useStore.getState().toast?.message).toBe('Your account is deleted.');
    // Everything had reached the company, so the phone is cleared, and signed out of the server.
    expect(useStore.getState()).toMatchObject({ session: null, accounts: [], connectedCompany: null });
    expect(server.signOut).toHaveBeenCalled();
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
  });

  it('someone taken off the roster can still delete their account, from the company sign-in screen', async () => {
    // The company found no roster row for Blake's sign-in before his account opened here: nobody's account is open.
    const g = useStore.getState;
    const ref = await joinedPhone({ role: 'none', records: () => ({}) });
    await act(async () => g().signOut());
    await settle();
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
    expect(byId('company-off-roster')).not.toHaveLength(0);
    await press('company-delete-account');
    expect(ref.getCurrentRoute()?.name).toBe('DeleteAccount');
    await settle();
    expect(shown()).toContain('Delete my account');
    expect(shown()).toContain('What stays with Test Pit A');
    expect(byId('delete-password')).toHaveLength(0);

    server.deleteAccountWithPasscode.mockResolvedValue({ ok: true, closed: [] });
    await type('delete-passcode', '582039');
    await press('delete-confirm');
    expect(server.deleteAccountWithPasscode).toHaveBeenCalledWith('582039');
    expect(g().toast?.message).toBe('Your account is deleted.');
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
    expect(g().connectedCompany).toBeNull();
    expect(byId('crew-code')).not.toHaveLength(0);
  });

  it('someone taken off the roster with their account still open here deletes it too, and what cannot reach the company stays', async () => {
    const g = useStore.getState;
    const ref = await joinedPhone({ role: 'none', records: (me) => ({ shifts: [doneShift('sh-done', me)] }) });
    expect(g().session?.employeeId).toBe('emp-blake');
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
    await press('company-delete-account');
    await settle();
    expect(shown()).toContain('1 record cannot be sent to Test Pit A, so it stays on this phone.');
    server.deleteAccountWithPasscode.mockResolvedValue({ ok: true, closed: [] });
    await type('delete-passcode', '582039');
    await press('delete-confirm');
    expect(server.deleteAccountWithPasscode).toHaveBeenCalledWith('582039');
    expect(g().session).toBeNull();
    expect(g().accounts).toEqual([]);
    expect(g().shifts).toHaveLength(1);
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
  });

  it('deletes an email sign-in on no company’s roster with its password, from the company sign-in screen', async () => {
    const g = useStore.getState;
    g().resetDemo();
    g().ensureSeeded();
    server.myCompanies.mockResolvedValue({ ok: true, companies: [] });
    server.deletionCheck.mockResolvedValue({ ok: true, companies: [] });
    server.mockTell(AVERY);
    const ref = nav.createNavigationContainerRef<ReactNavigation.RootParamList>();
    root = createRoot();
    const r = root;
    await act(async () => {
      stopLink = connection.watchConnection();
      r.render(React.createElement(nav.NavigationContainer, { ref } as never, React.createElement(RootNavigator)));
    });
    await settle();
    await press('company-delete-sign-in');
    expect(ref.getCurrentRoute()).toMatchObject({ name: 'DeleteAccount', params: { signInOnly: true } });
    await settle();
    expect(shown()).toContain('Delete this company sign-in');
    expect(byId('delete-passcode')).toHaveLength(0);
    server.deleteAccount.mockResolvedValue({ ok: true, closed: [] });
    await type('delete-password', 'haulroad88');
    await press('delete-confirm');
    expect(server.deleteAccount).toHaveBeenCalledWith('avery@example.test', 'haulroad88');
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
  });
});
