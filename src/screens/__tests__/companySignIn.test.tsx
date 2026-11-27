// The company sign-in, the first screen of a build that names a company server. Crew type the company's
// code, which shows the company's name, then sign up with their name and a passcode typed twice, or sign
// in with their name and passcode; they never see an email. Supervisors sign in with email. Once signed
// in, the phone connects to the company, and the person's own account opens by itself once the phone has
// read the company's records (the store's part, run here as a round would run it). The real RootNavigator
// is drawn with the real screen; every other screen is a stand-in showing its own name, and the server's
// calls are stubbed, so no request leaves the test. Everyone and every company here is made up.
import type { Platform as PlatformType } from 'react-native';

import type { CrewAnswer, ServerCompany, WaitingRequest } from '../../domain/serverAnswers';
import type { ReceivedRow } from '../../domain/sync';
import type { ServerAccount } from '../../services/server';

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
jest.mock('../more/MoreScreen', () => ({ MoreScreen: mockScreen('More') }));
jest.mock('../more/CompanyScreen', () => ({ CompanyScreen: mockScreen('Company') }));
jest.mock('../more/DeleteAccountScreen', () => ({ DeleteAccountScreen: mockScreen('DeleteAccount') }));
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
jest.mock('expo-network', () => ({ getNetworkStateAsync: async () => ({ isConnected: true }), addNetworkStateListener: () => ({ remove() {} }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
// The company server, as connection.ts hands it to the screens: each call a stub the tests answer, and
// who is signed in to it on this phone, which a sign-in changes as supabase-js would tell it.
jest.mock('../../services/connection', () => {
  const { create } = require('zustand');
  const useServerAccount = create(() => ({ known: true, account: null, notOnLinked: false, checking: false, unchecked: false, joinCode: null, signingOut: false }));
  const fn = () => jest.fn();
  return {
    CAN_CONNECT: true,
    server: {
      crewAuth: fn(),
      startCrewSession: fn(),
      signOutOtherSessions: fn(),
      signIn: fn(),
      myCompanies: fn(),
      myJoinRequests: fn(),
      signOut: fn(),
    },
    useServerAccount,
    checkAccount: jest.fn(),
    disconnect: jest.fn(),
    signOutOfPhone: jest.fn(),
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
const React: typeof import('react') = require('react');
const { Platform } = require('react-native') as { Platform: typeof PlatformType };
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const nav = require('@react-navigation/native') as typeof import('@react-navigation/native');
const { RootNavigator } = require('../../navigation/RootNavigator') as typeof import('../../navigation/RootNavigator');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const { revOf } = require('../../domain/sync') as typeof import('../../domain/sync');
const { fmtDateTime, fmtTime } = require('../../util/format') as typeof import('../../util/format');
const { useSyncStatus } = require('../../services/sync') as typeof import('../../services/sync');
const connection = require('../../services/connection') as {
  server: Record<string, jest.Mock>;
  useServerAccount: typeof import('../../services/connection').useServerAccount;
  disconnect: jest.Mock;
  checkAccount: jest.Mock;
  signOutOfPhone: jest.Mock;
};
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { server, useServerAccount } = connection;
const PIT_A: ServerCompany = { id: 'c-test-a', name: 'Test Pit A', role: 'employee', state: 'NV' };
/** Sam's passcode sign-in, as server.ts hands it over: a passcode account's hidden address never reaches the app. */
const SAM: ServerAccount = { id: 'u-sam', email: '', kind: 'passcode' };
const AVERY: ServerAccount = { id: 'u-avery', email: 'avery@example.test', kind: 'email' };
const SESSION = { accessToken: 'a-1', refreshToken: 'r-1', expiresAt: 1_900_000_000, userId: SAM.id };
const signedIn = (more: Partial<Extract<CrewAnswer, { kind: 'signed_in' }>> = {}): CrewAnswer => ({
  kind: 'signed_in',
  session: SESSION,
  company: { id: PIT_A.id, name: PIT_A.name },
  waiting: false,
  join: null,
  othersSignedOut: true,
  ...more,
});
const request = (more: Partial<WaitingRequest> = {}): WaitingRequest => ({
  id: 'jr-1',
  companyId: PIT_A.id,
  firstName: 'Sam',
  lastName: 'Ortiz',
  reason: 'not_on_roster',
  at: Date.parse('2026-11-23T14:00:00Z'),
  ...more,
});

let root: Root | null = null;
beforeEach(() => {
  for (const call of Object.values(server)) call.mockReset();
  connection.disconnect.mockReset();
  connection.checkAccount.mockReset();
  connection.signOutOfPhone.mockReset();
  useSyncStatus.setState({ online: true, trouble: null });
  // A code is looked up as it is typed: Test Pit A's is ABCD 2345, and no company has any other.
  server.crewAuth.mockImplementation(async (action: string, body: { code: string }) =>
    action === 'lookup' ? (body.code === 'ABCD2345' ? { kind: 'company', name: PIT_A.name, state: 'NV' } : { kind: 'no_company' }) : { kind: 'server', message: 'not stubbed' },
  );
  // Keeping a session, as supabase-js does: the account it is comes back, and the phone hears it is signed in.
  server.startCrewSession.mockImplementation(async (session: { userId: string }) => {
    const account = { ...SAM, id: session.userId };
    useServerAccount.setState({ known: true, account });
    return { ok: true, account };
  });
  server.signOutOtherSessions.mockResolvedValue({ ok: true });
  server.signIn.mockImplementation(async (email: string) => {
    const account = { ...AVERY, email };
    useServerAccount.setState({ known: true, account });
    return { ok: true, account };
  });
  server.myCompanies.mockResolvedValue({ ok: true, companies: [] });
  server.myJoinRequests.mockResolvedValue({ ok: true, requests: [] });
  // Signing out of this phone (connection.ts): any account still open is closed, the phone stops sending to
  // the company, and it signs out of the server. What empties a phone, and when, is connection.test.ts's.
  connection.signOutOfPhone.mockImplementation(async () => {
    useStore.getState().signOut();
    useStore.getState().disconnectCompany();
    useServerAccount.setState({ account: null });
    return { ok: true };
  });
  useServerAccount.setState({ known: true, account: null, notOnLinked: false, checking: false, unchecked: false, joinCode: null, signingOut: false });
});
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

/** A fresh phone in a store build, on its first screen. */
async function freshPhone() {
  const ref = nav.createNavigationContainerRef();
  useStore.getState().resetDemo();
  useStore.getState().ensureSeeded();
  root = createRoot();
  const r = root;
  await act(async () => {
    r.render(React.createElement(nav.NavigationContainer, { ref } as never, React.createElement(RootNavigator)));
  });
  return ref;
}

/** Let the stubbed calls answer and the screen take what they said. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
const shown = () => JSON.stringify(root!.container.toJSON());
const byId = (id: string) => root!.container.queryAll((n) => n.props.testID === id);
/** The text box with this test ID. */
function input(id: string): Node {
  const found = root!.container.queryAll((n) => n.props.testID === id && typeof n.props.onChangeText === 'function')[0];
  if (!found) throw new Error(`No text box ${id} here.`);
  return found;
}
async function type(id: string, text: string) {
  await act(async () => (input(id).props.onChangeText as (t: string) => void)(text));
  await settle();
}
/**
 * What a tap on a view does: the onPress of the nearest component around it that has one, and whether
 * that component is turned off now, as a Button is while it is disabled or busy.
 */
function pressable(n: Node): { onPress: () => void; off: boolean } {
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('Nothing to press here.');
  const props = fiber.memoizedProps!;
  const state = props.accessibilityState as { disabled?: boolean } | undefined;
  return { onPress: props.onPress as () => void, off: props.disabled === true || state?.disabled === true };
}
/** A tap, as a finger makes it: on a button that is turned off it does nothing, and the test is told. */
async function press(id: string) {
  const found = byId(id)[0];
  if (!found) throw new Error(`No ${id} here.`);
  const target = pressable(found);
  if (target.off) throw new Error(`${id} cannot be pressed now.`);
  await act(async () => target.onPress());
  await settle();
}
/** The calls of one crew-auth action, by their bodies. */
const sent = (action: string) => server.crewAuth.mock.calls.filter(([a]) => a === action).map(([, body]) => body as Record<string, string>);

/** Test Pit A's code typed in, its name shown, and the form on Sign up or Sign in. */
async function atPitA(mode: 'sign_up' | 'sign_in') {
  await type('crew-code', 'abcd2345');
  if (mode === 'sign_in') await press('crew-mode-sign_in');
  await type('crew-first', 'Sam');
  await type('crew-last', 'Ortiz');
}

/** Sam signed in to Test Pit A with a passcode: the phone connected, and getting the company's records. */
async function signedInToPitA() {
  await atPitA('sign_in');
  await type('crew-passcode', '582039');
  server.crewAuth.mockResolvedValueOnce(signedIn());
  server.myCompanies.mockResolvedValueOnce({ ok: true, companies: [PIT_A] });
  await press('crew-submit');
  expect(useStore.getState().connectedCompany).toMatchObject({ id: PIT_A.id, userId: SAM.id });
}

let seq = 0;
/** A row of the company's records as read_shared_records hands it over: in the order the company wrote them. */
function row(kind: ReceivedRow['kind'], id: string, data: object): ReceivedRow {
  seq += 1;
  return { kind, id, rev: revOf(data), seq, deleted: false, data };
}
/**
 * A round's reads after connecting, as src/services/sync.ts hands them to the store: the sign-in's own
 * row of the roster, then the company's records a page at a time, to an empty page. Each read is for the
 * reading the phone is on then, which the standing read can move on.
 */
async function round(standing: { firstName: string; lastName: string }, ...pages: ReceivedRow[][]) {
  const g = useStore.getState;
  const linked = g().connectedCompany!;
  const ctx = () => ({ company: linked.id, account: linked.userId!, epoch: g().receiving!.epoch });
  await act(async () => {
    g().ensureReceiving();
    expect(g().applyStanding(ctx(), { role: linked.role, name: standing })).toBe(true);
    for (const page of [...pages, []]) expect(g().applyReceived(ctx(), page)).toBe(true);
  });
}

describe('the company code', () => {
  it('shows the company’s name once a good code is typed, and says no company for a wrong one', async () => {
    await freshPhone();
    expect(byId('company-sign-in')).not.toHaveLength(0);
    // Not a whole code yet: nothing is asked, and no name or passcode is asked for.
    await type('crew-code', 'abcd 234');
    expect(sent('lookup')).toEqual([]);
    expect(byId('crew-first')).toHaveLength(0);

    await type('crew-code', 'abcd2345');
    expect(sent('lookup')).toEqual([{ code: 'ABCD2345' }]);
    // The code as it reads best, and the company it is, with its state.
    expect(input('crew-code').props.value).toBe('ABCD 2345');
    expect(shown()).toContain('Test Pit A · Nevada');
    expect(byId('crew-first')).not.toHaveLength(0);

    await type('crew-code', 'WXYZ2345');
    expect(sent('lookup')).toEqual([{ code: 'ABCD2345' }, { code: 'WXYZ2345' }]);
    expect(shown()).toContain('No company has that code');
    expect(shown()).toContain('Check the code with your supervisor and type it again.');
    expect(shown()).not.toContain('Test Pit A');
    expect(byId('crew-first')).toHaveLength(0);

    // A code that cannot be anyone's is not sent at all, and says why, in the box's own word for it.
    await type('crew-code', 'ABCD2O45');
    expect(sent('lookup')).toHaveLength(2);
    expect(shown()).toContain('A company code has no O, 0, I or 1.');
    expect(shown()).not.toMatch(/join code/i);
  });
});

describe('signing up and signing in with a passcode', () => {
  it('sign up asks for the passcode twice and refuses an easy one before sending', async () => {
    await freshPhone();
    await atPitA('sign_up');
    // Both passcode boxes use the number pad and hide what is typed.
    for (const id of ['crew-passcode', 'crew-passcode-again']) expect(input(id).props).toMatchObject({ keyboardType: 'number-pad', secureTextEntry: true });

    await type('crew-passcode', '123456');
    await type('crew-passcode-again', '123456');
    await press('crew-submit');
    expect(shown()).toContain('Pick a harder passcode');
    expect(shown()).toContain('That passcode is too easy to guess.');

    await type('crew-passcode', '582039');
    await type('crew-passcode-again', '582093');
    await press('crew-submit');
    expect(shown()).toContain('The two passcodes are not the same');
    expect(sent('sign_up')).toEqual([]);

    server.crewAuth.mockResolvedValueOnce({ kind: 'busy' });
    await type('crew-passcode-again', '582039');
    await press('crew-submit');
    expect(sent('sign_up')).toEqual([{ code: 'ABCD2345', first_name: 'Sam', last_name: 'Ortiz', passcode: '582039' }]);
    expect(shown()).toContain('Too many tries right now');
  });

  it('a wrong passcode says how many tries are left; a locked account says until when', async () => {
    await freshPhone();
    await atPitA('sign_in');
    // Signing in asks for the passcode once, on the number pad, hidden.
    expect(byId('crew-passcode-again')).toHaveLength(0);
    expect(input('crew-passcode').props).toMatchObject({ keyboardType: 'number-pad', secureTextEntry: true });

    server.crewAuth.mockResolvedValueOnce({ kind: 'wrong', triesLeft: 3 });
    await type('crew-passcode', '582093');
    await press('crew-submit');
    expect(sent('sign_in')).toEqual([{ code: 'ABCD2345', first_name: 'Sam', last_name: 'Ortiz', passcode: '582093' }]);
    expect(shown()).toContain('That passcode is not right');
    expect(shown()).toContain('3 tries left. Check it and try again.');

    // A lock that ends later today gives the time alone, and one that ends on another day gives the day too.
    // Both times are set from today's date, not from now, so the test reads the same at any hour.
    const today = new Date();
    const laterToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59).getTime();
    server.crewAuth.mockResolvedValueOnce({ kind: 'locked', until: laterToday });
    await press('crew-submit');
    expect(shown()).toContain('Too many wrong passcodes');
    expect(shown()).toContain(`Try again at ${fmtTime(laterToday)}, or ask a supervisor for a reset code.`);

    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12, 0).getTime();
    server.crewAuth.mockResolvedValueOnce({ kind: 'locked', until: tomorrow });
    await press('crew-submit');
    expect(shown()).toContain(`Try again at ${fmtDateTime(tomorrow)}, or ask a supervisor for a reset code.`);

    server.crewAuth.mockResolvedValueOnce({ kind: 'locked', until: null });
    await press('crew-submit');
    expect(shown()).toContain('This sign-in is locked');
    expect(server.startCrewSession).not.toHaveBeenCalled();
  });

  it('a name with no sign-in yet is pointed to Sign up', async () => {
    await freshPhone();
    await atPitA('sign_in');
    await type('crew-passcode', '582039');
    server.crewAuth.mockResolvedValueOnce({ kind: 'no_account' });
    await press('crew-submit');
    expect(shown()).toContain('No sign-in for that name yet');
    expect(shown()).toContain('Check the spelling, or tap Sign up to make your sign-in.');
  });

  it('a sign-in on its way cannot be sent again', async () => {
    await freshPhone();
    await atPitA('sign_in');
    await type('crew-passcode', '582039');
    let answer: (said: CrewAnswer) => void = () => undefined;
    server.crewAuth.mockImplementationOnce(() => new Promise<CrewAnswer>((resolve) => (answer = resolve)));
    await press('crew-submit');
    // The button is busy until the answer comes: a second tap does nothing.
    await expect(press('crew-submit')).rejects.toThrow('crew-submit cannot be pressed now.');
    expect(sent('sign_in')).toHaveLength(1);
    await act(async () => answer({ kind: 'wrong', triesLeft: 4 }));
    await settle();
    expect(shown()).toContain('4 tries left');
  });

  it('a lost sign-up answer turns into a sign-in', async () => {
    await freshPhone();
    await atPitA('sign_up');
    await type('crew-passcode', '582039');
    await type('crew-passcode-again', '582039');
    // The first answer was lost and the person tapped again, or the first tap went twice: the name is signed up already.
    server.crewAuth.mockResolvedValueOnce({ kind: 'already_signed_up' });
    await press('crew-submit');
    expect(shown()).toContain('That name already has a sign-in');

    // Sign in is offered with the name and passcode the screen holds: one tap, nothing typed again.
    server.crewAuth.mockResolvedValueOnce(signedIn());
    server.myCompanies.mockResolvedValueOnce({ ok: true, companies: [PIT_A] });
    await press('crew-submit');
    expect(sent('sign_in')).toEqual([{ code: 'ABCD2345', first_name: 'Sam', last_name: 'Ortiz', passcode: '582039' }]);
    expect(server.startCrewSession).toHaveBeenCalledWith(SESSION);
    expect(useStore.getState().connectedCompany).toEqual({ id: PIT_A.id, name: PIT_A.name, role: 'employee', userId: SAM.id, email: SAM.email });
    // A sign-in that was not a reset signs no other phone out.
    expect(server.signOutOtherSessions).not.toHaveBeenCalled();
  });

  it('a request waiting for a supervisor shows the waiting card with Check again', async () => {
    await freshPhone();
    await atPitA('sign_up');
    await type('crew-passcode', '582039');
    await type('crew-passcode-again', '582039');
    server.crewAuth.mockResolvedValueOnce(signedIn({ waiting: true, join: { status: 'pending', companyName: PIT_A.name, reason: 'not_on_roster' } }));
    server.myJoinRequests.mockResolvedValue({ ok: true, requests: [request()] });
    await press('crew-submit');

    expect(byId('company-waiting')).not.toHaveLength(0);
    expect(shown()).toContain('Waiting for a supervisor');
    expect(shown()).toContain('Your name is not on Test Pit A’s roster yet.');
    expect(useStore.getState().connectedCompany).toBeNull();

    // Still waiting: the card stays.
    await press('company-check-again');
    expect(byId('company-waiting')).not.toHaveLength(0);
    expect(useStore.getState().connectedCompany).toBeNull();

    // A supervisor let Sam in: Check again finds the company and connects to it.
    server.myCompanies.mockResolvedValue({ ok: true, companies: [PIT_A] });
    await press('company-check-again');
    expect(server.myCompanies).toHaveBeenCalledTimes(3);
    expect(useStore.getState().connectedCompany).toMatchObject({ id: PIT_A.id, userId: SAM.id });
    expect(shown()).toContain('Getting Test Pit A’s roster, fleet and area sheets');
  });

  it('someone taken off the roster who signs in is told so, with Delete my account', async () => {
    const ref = await freshPhone();
    await atPitA('sign_in');
    await type('crew-passcode', '582039');
    // The passcode is right, but Sam's row is off the roster and nothing waits for a supervisor.
    server.crewAuth.mockResolvedValueOnce(signedIn());
    await press('crew-submit');

    expect(byId('company-off-roster')).not.toHaveLength(0);
    expect(shown()).toContain('You are no longer on Test Pit A’s roster');
    expect(useStore.getState().connectedCompany).toBeNull();
    expect(byId('company-sign-out')).not.toHaveLength(0);
    await press('company-delete-account');
    expect(ref.getCurrentRoute()?.name).toBe('DeleteAccount');
  });

  it('someone taken off the roster with their account still open here signs out of this phone, and the app does not open again', async () => {
    const ref = await freshPhone();
    // Sam's own phone: joined to Test Pit A with Sam's sign-in, and Sam's account opened by a round.
    await act(async () => {
      useServerAccount.setState({ known: true, account: SAM });
      expect(useStore.getState().connectCompany(PIT_A, SAM)).toEqual({ ok: true });
    });
    await round({ firstName: 'Sam', lastName: 'Ortiz' }, [row('employee', 'emp-sam', { id: 'emp-sam', firstName: 'Sam', lastName: 'Ortiz', role: 'employee', active: true })]);
    expect(ref.getCurrentRoute()?.name).toBe('Clock');
    // The company took Sam's sign-in off its roster: the round stops at the standing read, so Sam's record
    // here still says active, and the phone shows Sam the off-the-roster card.
    await act(async () => {
      const g = useStore.getState;
      expect(g().applyStanding({ company: PIT_A.id, account: SAM.id, epoch: g().receiving!.epoch }, null)).toBe(true);
    });
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
    expect(byId('company-off-roster')).not.toHaveLength(0);

    await press('company-sign-out');
    expect(connection.signOutOfPhone).toHaveBeenCalledTimes(1);
    expect({ session: useStore.getState().session, connected: useStore.getState().connectedCompany }).toEqual({ session: null, connected: null });
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
    expect(byId('crew-code')).not.toHaveLength(0);
  });

  it('tells a crew member made a supervisor, whose passcode sign-in the company let go of, to sign out and sign in with email', async () => {
    const ref = await freshPhone();
    // Sam's own phone, Sam's account open, and nothing waiting to be sent.
    await act(async () => {
      useServerAccount.setState({ known: true, account: SAM });
      expect(useStore.getState().connectCompany(PIT_A, SAM)).toEqual({ ok: true });
    });
    await round({ firstName: 'Sam', lastName: 'Ortiz' }, [row('employee', 'emp-sam', { id: 'emp-sam', firstName: 'Sam', lastName: 'Ortiz', role: 'employee', active: true })]);
    expect(ref.getCurrentRoute()?.name).toBe('Clock');
    // Sam accepted an invitation to supervise: the passcode sign-in is let go of, so the next standing read finds no row.
    await act(async () => {
      const g = useStore.getState;
      expect(g().applyStanding({ company: PIT_A.id, account: SAM.id, epoch: g().receiving!.epoch }, null)).toBe(true);
      useSyncStatus.setState({ waiting: 0, stuck: 0, notTaken: 0 });
    });
    expect(byId('company-off-roster')).not.toHaveLength(0);
    expect(byId('company-made-supervisor')).not.toHaveLength(0);
    expect(shown()).toContain('Made a supervisor?');
    expect(shown()).toContain('Sign out of this phone, then tap Supervisor? Sign in with email and use the address you were invited at.');
    expect(byId('company-sign-out')).not.toHaveLength(0);
  });

  it('promises a crew member made a supervisor no sign-out while records the passcode sign-in can no longer send are on the phone', async () => {
    await freshPhone();
    await act(async () => {
      useServerAccount.setState({ known: true, account: SAM });
      expect(useStore.getState().connectCompany(PIT_A, SAM)).toEqual({ ok: true });
    });
    await round({ firstName: 'Sam', lastName: 'Ortiz' }, [row('employee', 'emp-sam', { id: 'emp-sam', firstName: 'Sam', lastName: 'Ortiz', role: 'employee', active: true })]);
    await act(async () => {
      const g = useStore.getState;
      expect(g().applyStanding({ company: PIT_A.id, account: SAM.id, epoch: g().receiving!.epoch }, null)).toBe(true);
      // Two records were not sent before Sam accepted, and one the company turned down: none can go now.
      useSyncStatus.setState({ waiting: 2, stuck: 0, notTaken: 1, trouble: 'not_member' });
    });
    expect(byId('company-made-supervisor')).not.toHaveLength(0);
    expect(shown()).toContain(
      '3 records on this phone have not been taken by Test Pit A: they were not sent before you accepted, or the company turned them down. This passcode sign-in cannot send them now, so this phone cannot sign out without losing them. Keep them here and tell the supervisor who invited you.',
    );
    expect(shown()).not.toContain('Sign out of this phone, then tap');
  });

  it('says nothing of being made a supervisor to an email sign-in off the roster', async () => {
    await freshPhone();
    await act(async () => {
      useServerAccount.setState({ known: true, account: AVERY });
      expect(useStore.getState().connectCompany(PIT_A, AVERY)).toEqual({ ok: true });
    });
    await round({ firstName: 'Lee', lastName: 'Park' }, [row('employee', 'emp-lee', { id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true })]);
    await act(async () => {
      const g = useStore.getState;
      expect(g().applyStanding({ company: PIT_A.id, account: AVERY.id, epoch: g().receiving!.epoch }, null)).toBe(true);
    });
    expect(byId('company-off-roster')).not.toHaveLength(0);
    expect(byId('company-made-supervisor')).toHaveLength(0);
    expect(shown()).not.toContain('Made a supervisor?');
  });

  it('says what holds signing out of this phone up, with Delete my account for what cannot reach the company', async () => {
    const ref = await freshPhone();
    await atPitA('sign_in');
    await type('crew-passcode', '582039');
    server.crewAuth.mockResolvedValueOnce(signedIn());
    await press('crew-submit');
    expect(byId('company-off-roster')).not.toHaveLength(0);
    const offRoster = {
      kind: 'not_member',
      title: 'This phone’s company sign-in is off Test Pit A’s roster',
      body: '1 record on this phone cannot reach the company now, and signing out would lose it. Delete your account instead: it stays on this phone.',
      action: 'delete',
    };
    connection.signOutOfPhone.mockResolvedValueOnce({ ok: false, reason: 'unsent', error: `${offRoster.title}. ${offRoster.body}`, blockers: [offRoster], warnings: [] });
    await press('company-sign-out');
    expect(byId('sign-out-blocker-not_member')).not.toHaveLength(0);
    expect(shown()).toContain('Delete your account instead: it stays on this phone.');
    // Still signed in: nothing was signed out.
    expect(useServerAccount.getState().account).toEqual(SAM);
    await press('sign-out-delete');
    expect(ref.getCurrentRoute()?.name).toBe('DeleteAccount');
  });

  it('signs out of this phone from a card, back to the company code', async () => {
    await freshPhone();
    await atPitA('sign_in');
    await type('crew-passcode', '582039');
    server.crewAuth.mockResolvedValueOnce(signedIn());
    await press('crew-submit');
    await press('company-sign-out');
    expect(connection.signOutOfPhone).toHaveBeenCalledTimes(1);
    expect(byId('crew-code')).not.toHaveLength(0);
  });
});

describe('Forgot your passcode?', () => {
  it('takes the reset code and a new passcode', async () => {
    await freshPhone();
    await atPitA('sign_in');
    await press('crew-forgot');
    for (const id of ['crew-new-passcode', 'crew-new-passcode-again']) expect(input(id).props).toMatchObject({ keyboardType: 'number-pad', secureTextEntry: true });
    expect(input('crew-reset-code').props).toMatchObject({ keyboardType: 'number-pad' });

    // Checked before anything is sent: the code is 6 digits, and the new passcode is typed twice the same.
    await type('crew-reset-code', '4821');
    await type('crew-new-passcode', '582039');
    await type('crew-new-passcode-again', '582039');
    await press('crew-submit');
    expect(shown()).toContain('Enter the 6-digit reset code your supervisor gave you');
    expect(sent('reset')).toEqual([]);

    // The new passcode is set, but no session came back: Sign in is offered with it, one tap.
    server.crewAuth.mockResolvedValueOnce({ kind: 'passcode_changed' });
    await type('crew-reset-code', '482193');
    await press('crew-submit');
    expect(sent('reset')).toEqual([{ code: 'ABCD2345', first_name: 'Sam', last_name: 'Ortiz', reset_code: '482193', new_passcode: '582039' }]);
    expect(shown()).toContain('Your new passcode is set');

    server.crewAuth.mockResolvedValueOnce(signedIn());
    server.myCompanies.mockResolvedValueOnce({ ok: true, companies: [PIT_A] });
    await press('crew-submit');
    expect(sent('sign_in')).toEqual([{ code: 'ABCD2345', first_name: 'Sam', last_name: 'Ortiz', passcode: '582039' }]);
    // So a lost or old phone stops working: the account's other sessions are signed out from here.
    expect(server.signOutOtherSessions).toHaveBeenCalledTimes(1);
    expect(useStore.getState().connectedCompany).toMatchObject({ id: PIT_A.id, userId: SAM.id });
  });

  it('a reset that could not sign the other phones out has this phone do it', async () => {
    await freshPhone();
    await atPitA('sign_in');
    await press('crew-forgot');
    await type('crew-reset-code', '482193');
    await type('crew-new-passcode', '582039');
    await type('crew-new-passcode-again', '582039');
    server.crewAuth.mockResolvedValueOnce(signedIn({ othersSignedOut: false }));
    server.myCompanies.mockResolvedValueOnce({ ok: true, companies: [PIT_A] });
    await press('crew-submit');
    expect(server.startCrewSession).toHaveBeenCalledWith(SESSION);
    expect(server.signOutOtherSessions).toHaveBeenCalledTimes(1);
    expect(useStore.getState().connectedCompany).toMatchObject({ id: PIT_A.id });
  });
});

describe('Android’s back button on the sign-in', () => {
  // Android's handling of a back press, as React Native's BackHandler does it there: the listener added last
  // is asked first, until one says it dealt with the press. When none does, Android puts the app away.
  const { BackHandler } = require('react-native') as typeof import('react-native');
  type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
  const listeners: BackListener[] = [];
  let spy: jest.SpyInstance | null = null;
  // An Android phone: the screens listen for the back button only there.
  let android: jest.ReplaceProperty<string> | null = null;
  beforeEach(() => {
    android = jest.replaceProperty(Platform, 'OS', 'android');
    listeners.length = 0;
    spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_name, handler) => {
      if (!listeners.includes(handler)) listeners.push(handler);
      return {
        remove: () => {
          const at = listeners.indexOf(handler);
          if (at !== -1) listeners.splice(at, 1);
        },
      };
    });
  });
  afterEach(() => {
    spy?.mockRestore();
    android?.restore();
  });
  /** A press of the back button: false when nothing in the app dealt with it, and Android put the app away. */
  async function pressBack(): Promise<boolean> {
    let dealt = false;
    await act(async () => {
      for (let i = listeners.length - 1; i >= 0 && !dealt; i -= 1) dealt = listeners[i]({ type: 'hardwareBackPress', timeStamp: 0 }) === true;
    });
    await settle();
    return dealt;
  }

  it('closes Supervisor? Sign in with email, back to the crew sign-in, which then leaves the app as before', async () => {
    const ref = await freshPhone();
    await press('crew-use-email');
    expect(byId('server-email')).not.toHaveLength(0);
    expect(await pressBack()).toBe(true);
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
    expect(byId('server-email')).toHaveLength(0);
    expect(byId('crew-code')).not.toHaveLength(0);
    expect(byId('crew-use-email')).not.toHaveLength(0);
    // On the crew sign-in, back is Android's own again.
    expect(await pressBack()).toBe(false);
  });

  it('closes Forgot your passcode?, back to Sign in with the name kept, which then leaves the app as before', async () => {
    await freshPhone();
    await atPitA('sign_in');
    await press('crew-forgot');
    expect(byId('crew-reset-code')).not.toHaveLength(0);
    expect(await pressBack()).toBe(true);
    expect(byId('crew-reset-code')).toHaveLength(0);
    expect(byId('crew-passcode')).not.toHaveLength(0);
    expect(byId('crew-forgot')).not.toHaveLength(0);
    expect(input('crew-first').props.value).toBe('Sam');
    expect(await pressBack()).toBe(false);
  });

  it('goes back as ever from a screen opened over the sign-in, though the email sign-in was open under it', async () => {
    const ref = await freshPhone();
    await press('crew-use-email');
    await type('server-email', 'avery@example.test');
    await type('server-password', 'haulroad88');
    await press('server-submit');
    expect(byId('company-no-company')).not.toHaveLength(0);
    await press('company-delete-sign-in');
    expect(ref.getCurrentRoute()?.name).toBe('DeleteAccount');
    // Signed out of the server meanwhile: the email sign-in is open again under the screen in front.
    await act(async () => useServerAccount.setState({ account: null }));
    expect(await pressBack()).toBe(true);
    expect(ref.getCurrentRoute()?.name).toBe('CompanySignIn');
    expect(byId('server-email')).not.toHaveLength(0);
  });
});

describe('Supervisor? Sign in with email', () => {
  it('signs in, picks the company and connects', async () => {
    await freshPhone();
    await press('crew-use-email');
    // Forgot password? opens the office dashboard's own Set a new password in the phone's browser. The link in
    // the email it sends then comes back to the browser that asked for it, the only place the dashboard takes it.
    const { Linking } = require('react-native') as typeof import('react-native');
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(undefined);
    await press('server-forgot');
    expect(open).toHaveBeenCalledWith('https://app.minemuster.com/?start=reset');
    expect(shown()).toContain('The office dashboard opened in your browser. Type your email there and tap Email me a link. Open the link in that email on this phone, then come back here and sign in with your new password.');
    open.mockRejectedValueOnce(new Error('no browser'));
    await press('server-forgot');
    expect(shown()).toContain('This phone could not open the browser. On a computer, go to app.minemuster.com and tap Forgot your password?');
    open.mockRestore();
    await type('server-email', 'avery@example.test');

    // A supervisor of two companies: the phone asks which one it is for.
    const PIT_B: ServerCompany = { id: 'c-test-b', name: 'Test Pit B', role: 'supervisor', joinCode: 'WXYZ2345' };
    server.myCompanies.mockResolvedValue({ ok: true, companies: [{ ...PIT_A, role: 'supervisor' }, PIT_B] });
    await type('server-password', 'haulroad88');
    await press('server-submit');
    expect(server.signIn).toHaveBeenCalledWith('avery@example.test', 'haulroad88');
    expect(byId('server-company-c-test-a')).not.toHaveLength(0);
    await press('server-company-c-test-b');
    expect(useStore.getState().connectedCompany).toEqual({ id: 'c-test-b', name: 'Test Pit B', role: 'supervisor', userId: AVERY.id, email: AVERY.email });
    // No passcode call was made for a supervisor.
    expect(sent('sign_in')).toEqual([]);
  });

  it('an email account with no company is told to accept its invitation on the dashboard', async () => {
    await freshPhone();
    await press('crew-use-email');
    await type('server-email', 'avery@example.test');
    await type('server-password', 'haulroad88');
    await press('server-submit');
    expect(byId('company-no-company')).not.toHaveLength(0);
    expect(shown()).toContain('Accept your invitation first');
    expect(shown()).toContain('app.minemuster.com');

    // Accepted on the dashboard: Check again finds the company and connects.
    server.myCompanies.mockResolvedValue({ ok: true, companies: [{ ...PIT_A, role: 'supervisor' }] });
    await press('company-check-again');
    expect(useStore.getState().connectedCompany).toMatchObject({ id: PIT_A.id, role: 'supervisor', userId: AVERY.id });
  });
});

describe('an email account with no company', () => {
  it('can delete its sign-in from the phone', async () => {
    const ref = await freshPhone();
    await press('crew-use-email');
    await type('server-email', 'avery@example.test');
    await type('server-password', 'haulroad88');
    await press('server-submit');
    expect(byId('company-no-company')).not.toHaveLength(0);
    await press('company-delete-sign-in');
    expect(ref.getCurrentRoute()).toMatchObject({ name: 'DeleteAccount', params: { signInOnly: true } });
  });
});

describe('after signing in', () => {
  it('a company with the time clock off lands on the checklists after sign-in', async () => {
    const ref = await freshPhone();
    await atPitA('sign_in');
    await type('crew-passcode', '582039');
    server.crewAuth.mockResolvedValueOnce(signedIn());
    server.myCompanies.mockResolvedValueOnce({ ok: true, companies: [PIT_A] });
    await press('crew-submit');
    expect(shown()).toContain('Getting Test Pit A’s roster, fleet and area sheets');
    expect(useStore.getState().session).toBeNull();

    // The round: Sam's row, then a page later the company's settings with the time clock off, then an empty page.
    await round(
      { firstName: 'Sam', lastName: 'Ortiz' },
      [row('employee', 'emp-sam', { id: 'emp-sam', firstName: 'Sam', lastName: 'Ortiz', role: 'employee', active: true })],
      [row('settings', 'company', { company: { name: 'Test Pit A', state: 'NV', pay: null, timeClock: false }, site: null, workweekStartsOn: 0, allowSectionAllOk: true })],
    );
    expect(useStore.getState().session?.employeeId).toBe('emp-sam');
    // Sam's own account opened by itself: no second account, no password, and the first tab is the checklists.
    expect(useStore.getState().accounts).toEqual([expect.objectContaining({ employeeId: 'emp-sam', email: '', provider: 'company' })]);
    expect(ref.getCurrentRoute()?.name).toBe('Equipment');
  });
});

describe('signing out of this phone', () => {
  it('cannot connect the phone again while the server sign-out is under way', async () => {
    await freshPhone();
    await signedInToPitA();
    // The company is dropped at once, but the server's sign-out takes a moment: meanwhile the account is
    // still signed in, and the company it is on could be found again.
    let signedOut: () => void = () => undefined;
    connection.signOutOfPhone.mockImplementation(async () => {
      useStore.getState().disconnectCompany();
      await new Promise<void>((resolve) => (signedOut = resolve));
      useServerAccount.setState({ account: null });
      return { ok: true };
    });
    server.myCompanies.mockResolvedValue({ ok: true, companies: [PIT_A] });
    const looked = server.myCompanies.mock.calls.length;
    await press('company-sign-out');
    expect(shown()).toContain('Signing out of this phone');
    expect(byId('company-finding')).toHaveLength(0);
    expect(server.myCompanies).toHaveBeenCalledTimes(looked);
    expect(useStore.getState().connectedCompany).toBeNull();

    await act(async () => signedOut());
    await settle();
    expect(useStore.getState().connectedCompany).toBeNull();
    expect(server.myCompanies).toHaveBeenCalledTimes(looked);
    expect(byId('crew-code')).not.toHaveLength(0);
  });

  it('waits the same way while the phone signs out from anywhere else, such as More', async () => {
    await freshPhone();
    // More emptied the phone, and its server sign-out is under way: the account is still signed in meanwhile.
    await act(async () => useServerAccount.setState({ known: true, account: SAM, signingOut: true }));
    await settle();
    expect(byId('company-signing-out')).not.toHaveLength(0);
    expect(server.myCompanies).not.toHaveBeenCalled();
    await act(async () => useServerAccount.setState({ account: null, signingOut: false }));
    await settle();
    expect(byId('crew-code')).not.toHaveLength(0);
    expect(server.myCompanies).not.toHaveBeenCalled();
  });
});

describe('while the account opens', () => {
  it('says when MineMuster has stopped for the company, and when there is no signal', async () => {
    await freshPhone();
    await signedInToPitA();
    expect(byId('company-opening')).not.toHaveLength(0);
    await act(async () => useSyncStatus.setState({ online: false }));
    expect(shown()).toContain('No signal');
    expect(shown()).toContain('Your account opens by itself once this phone has signal and has got Test Pit A’s roster.');
    await act(async () => useSyncStatus.setState({ online: true, trouble: 'closed' }));
    expect(shown()).toContain('MineMuster has stopped for Test Pit A');
    expect(shown()).toContain('A supervisor can start it again on the dashboard’s Billing page.');
    expect(byId('company-sign-out')).not.toHaveLength(0);
  });

  it('checks another sign-in against the company’s roster before anything opens', async () => {
    await freshPhone();
    // Joined with Lee's sign-in, which went; Sam signs in on this phone.
    await act(async () => {
      expect(useStore.getState().connectCompany(PIT_A, { id: 'u-lee', email: 'lee@example.test' })).toEqual({ ok: true });
      useServerAccount.setState({ known: true, account: SAM, checking: true });
    });
    expect(shown()).toContain('Checking your sign-in with Test Pit A');
    await act(async () => useServerAccount.setState({ checking: false, unchecked: true }));
    expect(shown()).toContain('Could not check your sign-in with Test Pit A');
    await press('company-try-again');
    expect(connection.checkAccount).toHaveBeenCalledTimes(1);
    await act(async () => useServerAccount.setState({ unchecked: false, notOnLinked: true }));
    expect(shown()).toContain('This sign-in is not on Test Pit A’s roster');
    expect(byId('company-sign-out')).not.toHaveLength(0);
  });

  it('says why the account could not be opened once the company’s records are in', async () => {
    await freshPhone();
    await signedInToPitA();
    // Sam's sign-in, but the roster this phone got has nobody of that name.
    await round({ firstName: 'Sam', lastName: 'Ortiz' }, [row('employee', 'emp-lee', { id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true })]);
    expect(useStore.getState().session).toBeNull();
    expect(shown()).toContain('Your account could not be opened');
    expect(shown()).toContain('Sam Ortiz is not on the company’s roster on this phone. See your supervisor.');
    expect(byId('company-check-again')).not.toHaveLength(0);
  });
});

describe('a phone set up for another company', () => {
  it('asks before it sends there', async () => {
    await freshPhone();
    await act(async () => {
      useStore.setState((s) => ({ settings: { ...s.settings, company: { name: 'Test Pit B', state: 'NV', pay: null } } }));
    });
    await atPitA('sign_in');
    await type('crew-passcode', '582039');
    server.crewAuth.mockResolvedValueOnce(signedIn());
    server.myCompanies.mockResolvedValue({ ok: true, companies: [PIT_A] });
    await press('crew-submit');
    expect(useStore.getState().connectedCompany).toBeNull();
    expect(shown()).toContain('Send to Test Pit A?');
    expect(shown()).toContain('This phone is set up for Test Pit B.');

    await press('server-other-company-no');
    expect(shown()).not.toContain('Send to Test Pit A?');
    expect(useStore.getState().connectedCompany).toBeNull();
    // The company stays there to choose.
    await press('server-company-c-test-a');
    await press('server-other-company-yes');
    expect(useStore.getState().connectedCompany).toMatchObject({ id: PIT_A.id, userId: SAM.id });
  });
});

describe('with no signal', () => {
  it('keeps what it found while signal is gone, and looks again once it is back', async () => {
    await freshPhone();
    // With no signal the company server cannot be asked.
    server.myCompanies.mockImplementation(async () =>
      useSyncStatus.getState().online ? { ok: true, companies: [] } : { ok: false, error: 'The company server could not be reached. Check your signal and try again.' },
    );
    await atPitA('sign_in');
    await type('crew-passcode', '582039');
    server.crewAuth.mockResolvedValueOnce(signedIn());
    await press('crew-submit');
    expect(byId('company-off-roster')).not.toHaveLength(0);
    expect(server.myCompanies).toHaveBeenCalledTimes(1);

    await act(async () => useSyncStatus.setState({ online: false }));
    await settle();
    expect(byId('company-off-roster')).not.toHaveLength(0);
    expect(shown()).not.toContain('Could not find your company');
    expect(server.myCompanies).toHaveBeenCalledTimes(1);

    await act(async () => useSyncStatus.setState({ online: true }));
    await settle();
    expect(server.myCompanies).toHaveBeenCalledTimes(2);
    expect(byId('company-off-roster')).not.toHaveLength(0);
  });
});

describe('the top of the sign-in screens', () => {
  const companyIs = (company: { name: string; state: string; pay: null; timeClock?: false }) =>
    act(async () => {
      useStore.setState((s) => ({ settings: { ...s.settings, company } }));
    });

  it('says nothing of time or pay until the phone knows the company, then follows its time clock', async () => {
    await freshPhone();
    expect(shown()).toContain('Check your machine. Report what needs fixing.');
    expect(shown()).not.toMatch(/Clock in|Get paid/);
    // A phone that has the company's settings, as after signing out of it: one that uses the safety forms alone.
    await companyIs({ name: 'Test Pit A', state: 'NV', pay: null, timeClock: false });
    expect(shown()).toContain('Check your machine. Report what needs fixing.');
    expect(shown()).not.toMatch(/Clock in|Get paid/);
    // One that keeps time.
    await companyIs({ name: 'Test Pit A', state: 'NV', pay: null });
    expect(shown()).toContain('Clock in. Check your machine. Get paid right.');
  });

  it('the sign-in kept on the phone keeps its words wherever the time clock is on', async () => {
    const { AuthScreen } = jest.requireActual('../auth/AuthScreen') as typeof import('../auth/AuthScreen');
    useStore.getState().resetDemo();
    root = createRoot();
    const r = root;
    await act(async () => r.render(React.createElement(AuthScreen)));
    expect(shown()).toContain('Clock in. Check your machine. Get paid right.');
    expect(shown()).toContain('Time, checklists and maintenance requests for the crew.');
    await companyIs({ name: 'Test Pit A', state: 'NV', pay: null, timeClock: false });
    expect(shown()).toContain('Check your machine. Report what needs fixing.');
    expect(shown()).not.toMatch(/Clock in|Get paid/);
  });
});

describe('on the web', () => {
  it('offers the email sign-in, and tells crew to sign in on their phone', async () => {
    // The screen alone: the navigator takes its own web paths, which need a browser.
    const { CompanySignInScreen } = require('../auth/CompanySignInScreen') as typeof import('../auth/CompanySignInScreen');
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      useStore.getState().resetDemo();
      root = createRoot();
      const r = root;
      await act(async () => {
        r.render(React.createElement(CompanySignInScreen, { navigation: { navigate: jest.fn() }, route: { key: 'CompanySignIn', name: 'CompanySignIn' } } as never));
      });
      await settle();
      expect(byId('crew-code')).toHaveLength(0);
      expect(shown()).toContain('Crew sign in with the MineMuster app on their phone');
      expect(shown()).toContain('Supervisor? Sign in with email');
      expect(byId('server-email')).not.toHaveLength(0);
      expect(server.crewAuth).not.toHaveBeenCalled();
    } finally {
      os.restore();
    }
  });
});

describe('in a build with no server', () => {
  // This project has no Node types, so the file system is asked for by name with the calls used here.
  type Entry = { name: string; isDirectory(): boolean };
  const fs = jest.requireActual<{ readdirSync(dir: string, o: { withFileTypes: true }): Entry[]; readFileSync(file: string, encoding: 'utf8'): string }>('fs');
  const here = expect.getState().testPath ?? '';
  const src = `${here.slice(0, here.search(/[\\/]src[\\/]/))}/src`;
  const appFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : appFiles(`${dir}/${e.name}`)) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []));

  it('carries none of the company sign-in: only the screens loaded behind the server setting reach it', () => {
    // RootNavigator requires the screen behind the folded condition, as it does Company account, so the
    // public preview is made without any of it (and without the server code its files import).
    const reach = /from '[^']*auth\/(CompanySignInScreen|CrewSignIn|ServerSignIn)'|from '\.\/(CompanySignInScreen|CrewSignIn|ServerSignIn)'|require\('[^']*auth\/CompanySignInScreen'\)/;
    const importers = appFiles(src)
      .filter((file) => reach.test(fs.readFileSync(file, 'utf8')))
      .map((file) => file.slice(src.length + 1))
      .sort();
    expect(importers).toEqual(['navigation/RootNavigator.tsx', 'screens/auth/CompanySignInScreen.tsx', 'screens/more/CompanyAccountScreen.tsx']);
    const navigator = fs.readFileSync(`${src}/navigation/RootNavigator.tsx`, 'utf8');
    expect(navigator).toMatch(
      /process\.env\.EXPO_PUBLIC_SUPABASE_URL && process\.env\.EXPO_PUBLIC_SUPABASE_KEY && process\.env\.EXPO_PUBLIC_DEMO === '0'\n\s+\? require\('\.\.\/screens\/auth\/CompanySignInScreen'\)\.CompanySignInScreen/,
    );
  });
});
