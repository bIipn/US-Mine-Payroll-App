// Coming back to the app hands the phone the reminders for a shift again, on whatever screen is in front, not only
// on the Clock tab. A person may start lunch with notifications off, so the phone is handed nothing, then open
// My hours, turn notifications on in the phone's settings and come back to the app, which opens again on My hours:
// the notice that lunch is over must still come. The same goes for Alarms & reminders, without which Android may
// hold the notice back. Coming back never asks the phone for anything, and takes nothing off it: a notice the phone
// is holding back past its time still comes. Played here as the real App, its real navigator and the real Clock
// screen; every other screen is a stand-in, and the phone's notifications are played by a stand-in that holds what
// it is handed while notifications are allowed. Everyone and everything here is made up.
import type { LocalReminder } from '../../services/notifications';

// The app's own navigation container, with a handle on it to move about the app as a person would.
let mockNav: import('@react-navigation/native').NavigationContainerRefWithCurrent<ReactNavigation.RootParamList> | null = null;
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  const R = require('react');
  return {
    ...actual,
    NavigationContainer: (props: Record<string, unknown>) => {
      const ref = R.useMemo(() => actual.createNavigationContainerRef(), []);
      mockNav = ref;
      return R.createElement(actual.NavigationContainer, { ...props, ref });
    },
  };
});
const mockText = (words: string) => () => require('react').createElement(require('react-native').Text, null, words);
jest.mock('../../screens/auth/AuthScreen', () => ({ AuthScreen: mockText('Auth') }));
jest.mock('../../screens/auth/CompanySignInScreen', () => ({ CompanySignInScreen: mockText('CompanySignIn') }));
jest.mock('../../screens/equipment/ChecklistCardScreen', () => ({ ChecklistCardScreen: mockText('ChecklistCard') }));
jest.mock('../../screens/equipment/EndUseScreen', () => ({ EndUseScreen: mockText('EndUse') }));
jest.mock('../../screens/equipment/EquipmentScreen', () => ({ EquipmentScreen: mockText('Checklists') }));
jest.mock('../../screens/equipment/InspectionDetailScreen', () => ({ InspectionDetailScreen: mockText('InspectionDetail') }));
jest.mock('../../screens/equipment/InspectionResultScreen', () => ({ InspectionResultScreen: mockText('InspectionResult') }));
jest.mock('../../screens/equipment/InspectionScreen', () => ({ InspectionScreen: mockText('Inspection') }));
jest.mock('../../screens/equipment/MrfDetailScreen', () => ({ MrfDetailScreen: mockText('MrfDetail') }));
jest.mock('../../screens/equipment/MrfFormScreen', () => ({ MrfFormScreen: mockText('MrfForm') }));
jest.mock('../../screens/exam/AreaExamDetailScreen', () => ({ AreaExamDetailScreen: mockText('AreaExamDetail') }));
jest.mock('../../screens/exam/AreaExamScreen', () => ({ AreaExamScreen: mockText('AreaExam') }));
jest.mock('../../screens/hours/HoursScreen', () => ({ HoursScreen: mockText('My hours') }));
jest.mock('../../screens/hours/ShiftDetailScreen', () => ({ ShiftDetailScreen: mockText('ShiftDetail') }));
jest.mock('../../screens/more/MoreScreen', () => ({ MoreScreen: mockText('More') }));
jest.mock('../../screens/more/CompanyScreen', () => ({ CompanyScreen: mockText('Company') }));
jest.mock('../../screens/more/DeleteAccountScreen', () => ({ DeleteAccountScreen: mockText('DeleteAccount') }));
jest.mock('../../screens/more/MyRecordsScreen', () => ({ MyRecordsScreen: mockText('MyRecords') }));
jest.mock('../../screens/more/SiteScreen', () => ({ SiteScreen: mockText('Site') }));
jest.mock('../../screens/more/StandardsScreen', () => ({ StandardsScreen: mockText('Standards') }));
jest.mock('../../screens/supervisor/AreaSheetsScreen', () => ({ AreaSheetsScreen: mockText('AreaSheets') }));
jest.mock('../../screens/supervisor/CrewScreen', () => ({ CrewScreen: mockText('Crew') }));
jest.mock('../../screens/supervisor/FleetScreen', () => ({ FleetScreen: mockText('Fleet') }));
jest.mock('../../screens/supervisor/MrfQueueScreen', () => ({ MrfQueueScreen: mockText('MrfQueue') }));
jest.mock('../../screens/supervisor/OnSiteScreen', () => ({ OnSiteScreen: mockText('OnSite') }));
jest.mock('../../screens/supervisor/PayrollEmployeeScreen', () => ({ PayrollEmployeeScreen: mockText('PayrollEmployee') }));
jest.mock('../../screens/supervisor/PayrollScreen', () => ({ PayrollScreen: mockText('Payroll') }));
jest.mock('../../screens/supervisor/RosterScreen', () => ({ RosterScreen: mockText('Roster') }));
jest.mock('../../screens/supervisor/SafetyLogScreen', () => ({ SafetyLogScreen: mockText('SafetyLog') }));
jest.mock('../../screens/supervisor/TimeLogsScreen', () => ({ TimeLogsScreen: mockText('TimeLogs') }));
// What the app starts once the records are read: no company server, and signal.
jest.mock('../../services/connection', () => ({ CAN_CONNECT: false, watchConnection: () => () => undefined }));
jest.mock('../../services/sync', () => {
  const { create } = require('zustand');
  return { startSync: () => () => undefined, useSyncStatus: create(() => ({ online: true, server: false, waiting: 0 })) };
});
// The phone gives no position, so every punch goes through with none (a clock-in marked for review).
jest.mock('../../services/location', () => ({ locate: async () => ({ ok: false, reason: 'off' }) }));
/**
 * The phone's notifications: whether they are allowed for the app, whether Alarms & reminders is on, and the
 * reminders it holds by id, each with whether it was handed over to come at the minute. Like the phone, it holds
 * nothing it is handed while notifications are off.
 */
const mockPhone = { allowed: false, onTime: true, holds: new Map<string, { at: number; onTime: boolean }>() };
jest.mock('../../services/notifications', () => {
  const takeOff = (ids: string[]) => ids.forEach((id) => mockPhone.holds.delete(id));
  return {
    requestNotificationPermission: jest.fn(async () => mockPhone.allowed),
    lunchNoticeState: jest.fn(async () => (mockPhone.allowed ? 'on' : 'off')),
    onTimeNotices: jest.fn(async () => mockPhone.onTime),
    allowOnTimeNotices: jest.fn(async () => mockPhone.onTime),
    cancelLocal: jest.fn(async (ids: string[]) => takeOff(ids)),
    scheduleLocal: jest.fn(async (reminders: LocalReminder[]) => {
      takeOff(reminders.map((r) => r.id));
      if (!mockPhone.allowed) return;
      for (const r of reminders) if (r.at > Date.now()) mockPhone.holds.set(r.id, { at: r.at, onTime: mockPhone.onTime });
    }),
  };
});
jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));
jest.mock('@expo-google-fonts/barlow/500Medium', () => ({}));
jest.mock('@expo-google-fonts/barlow/600SemiBold', () => ({}));
jest.mock('@expo-google-fonts/barlow/700Bold', () => ({}));
jest.mock('@expo-google-fonts/barlow-condensed/600SemiBold', () => ({}));
jest.mock('@expo-google-fonts/barlow-condensed/700Bold', () => ({}));
// lucide's files are not transformed under Jest; any icon draws nothing here.
jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, HAS_LOGO_ART: false }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// A store build: it holds nobody made up and names nobody. Set before anything below is required.
const savedEnv = { ...process.env };
afterAll(() => {
  process.env = savedEnv;
});
for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });

type Fiber = { return: Fiber | null; memoizedProps?: Record<string, unknown> } | null;
type Node = { props: Record<string, unknown>; unstable_fiber: unknown };
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[] } };
const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const { AppState } = require('react-native') as { AppState: { addEventListener: jest.Mock } };
const App = (require('../../../App') as { default: React.ComponentType }).default;
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const notices = require('../../services/notifications') as Record<string, jest.Mock>;
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Whoever is listening for the app going to the back and coming to the front, as the phone would tell them. */
const listening = new Set<(state: string) => void>();
AppState.addEventListener.mockImplementation((event: string, heard: (state: string) => void) => {
  if (event !== 'change') return { remove: () => undefined };
  listening.add(heard);
  return { remove: () => listening.delete(heard) };
});
async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => undefined);
}
/** Out of the app (to the phone's settings, say) and back into it. */
async function awayAndBack() {
  await act(async () => [...listening].forEach((heard) => heard('background')));
  await act(async () => [...listening].forEach((heard) => heard('active')));
  await settle();
}

let root: Root | null = null;
beforeAll(async () => {
  // The store reads what is saved (nothing, here) before each test sets what it found.
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
});
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

/**
 * Lee's own phone, Lee signed in on the Clock tab, at a made-up pit with a boundary set, with `shifts` (none: off
 * the clock). Then the phone as each test has it: nothing handed to it yet, and nothing asked of it.
 */
async function opened(phone: { allowed: boolean; onTime: boolean }, shifts: import('../../domain/types').Shift[] = []) {
  useStore.setState({ hydrated: false, recordsUnreadable: false });
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(App)));
  await act(async () => {
    useStore.setState({ hydrated: true });
  });
  await act(async () => {
    useStore.getState().ensureSeeded();
    const { settings } = useStore.getState();
    useStore.setState({
      employees: [{ id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true }],
      accounts: [{ id: 'acct-lee', employeeId: 'emp-lee', email: '', provider: 'company', createdAt: 1 }],
      session: { accountId: 'acct-lee', employeeId: 'emp-lee' },
      shifts,
      toast: null,
      settings: {
        ...settings,
        lunchReminders: true,
        company: { ...settings.company, name: 'Test Pit A', state: 'NV', pay: null, timeClock: undefined },
        site: { name: 'Test Pit A', center: { lat: 10, lng: 10 }, radiusM: 500 },
      },
    });
  });
  await settle();
  Object.assign(mockPhone, phone);
  mockPhone.holds.clear();
  for (const fn of Object.values(notices)) fn.mockClear();
  return r;
}

const byId = (r: Root, id: string) => r.container.queryAll((n) => n.props.testID === id);
/** What a tap on a view does: the onPress of the nearest component around it that has one. */
function pressOf(n: Node): () => void {
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('Nothing to press here.');
  return fiber.memoizedProps!.onPress as () => void;
}
async function tap(r: Root, id: string) {
  const [node] = byId(r, id);
  if (!node) throw new Error(`No ${id} on the screen.`);
  await act(async () => {
    pressOf(node)();
  });
  await settle();
}
async function to(name: string) {
  await act(async () => (mockNav?.navigate as unknown as (name: string) => void)(name));
  await settle();
}

/** Clocked in and at lunch from the Clock tab, as Lee would. */
async function atLunch(r: Root) {
  await tap(r, 'clock-in');
  await tap(r, 'start-lunch');
  expect(byId(r, 'status-lunch')).not.toHaveLength(0);
}
const lunchEnds = () => useStore.getState().shifts[0].lunches[0].end!.at;
/** How many times the lunch-over notice was handed to the phone. */
const handedOver = () => notices.scheduleLocal.mock.calls.filter(([reminders]) => (reminders as LocalReminder[]).some((x) => x.id === 'lunch-end')).length;
/** Nothing here asks the phone anything but the clock-in's one question: it only reads. */
function askedOnlyAtClockIn() {
  expect(notices.requestNotificationPermission).toHaveBeenCalledTimes(1);
  expect(notices.allowOnTimeNotices).not.toHaveBeenCalled();
}

describe('back in the app with My hours in front', () => {
  it('hands the phone the lunch-over notice once notifications were turned on meanwhile, and asks nothing', async () => {
    const r = await opened({ allowed: false, onTime: true });
    await atLunch(r);
    // Lunch started with notifications off: the phone holds nothing.
    expect(mockPhone.holds.has('lunch-end')).toBe(false);
    notices.scheduleLocal.mockClear();

    await to('Hours');
    mockPhone.allowed = true;
    await awayAndBack();
    expect(mockPhone.holds.get('lunch-end')).toEqual({ at: lunchEnds(), onTime: true });
    expect(handedOver()).toBe(1);
    askedOnlyAtClockIn();

    // Opening the Clock tab afterwards shows the notice will come, and does not hand it over a second time.
    await to('Clock');
    expect(byId(r, 'lunch-no-notice')).toHaveLength(0);
    expect(handedOver()).toBe(1);
    askedOnlyAtClockIn();
  });

  it('hands the lunch-over notice over again to come at the minute once Alarms & reminders was turned on meanwhile', async () => {
    const r = await opened({ allowed: true, onTime: false });
    await atLunch(r);
    expect(mockPhone.holds.get('lunch-end')).toEqual({ at: lunchEnds(), onTime: false });

    await to('Hours');
    mockPhone.onTime = true;
    await awayAndBack();
    expect(mockPhone.holds.get('lunch-end')).toEqual({ at: lunchEnds(), onTime: true });
    askedOnlyAtClockIn();
  });
});

describe('back in the app with the Clock tab in front', () => {
  it('hands the lunch-over notice over once, not once for the app and again for the screen', async () => {
    const r = await opened({ allowed: false, onTime: true });
    await atLunch(r);
    notices.scheduleLocal.mockClear();

    mockPhone.allowed = true;
    await awayAndBack();
    expect(mockPhone.holds.get('lunch-end')).toEqual({ at: lunchEnds(), onTime: true });
    expect(handedOver()).toBe(1);
    expect(byId(r, 'lunch-no-notice')).toHaveLength(0);
    askedOnlyAtClockIn();
  });
});

describe('back in the app with nothing waiting', () => {
  it('after lunch is over, takes nothing off the phone, so a notice it is holding back still comes', async () => {
    const now = Date.now();
    const lunch = { start: { at: now - 31 * 60_000, noLocation: 'off' as const }, end: { at: now - 60_000, auto: true as const } };
    await opened({ allowed: true, onTime: false }, [{ id: 'sh-lee', employeeId: 'emp-lee', clockIn: { at: now - 4 * 3_600_000, noLocation: 'off' }, lunches: [lunch], breaks: [] }]);
    // The phone has held the notice back past its time, to save battery.
    mockPhone.holds.set('lunch-end', { at: lunch.end.at, onTime: false });

    await to('Hours');
    await awayAndBack();
    expect(mockPhone.holds.has('lunch-end')).toBe(true);
    expect(notices.scheduleLocal).not.toHaveBeenCalled();
    expect(notices.cancelLocal).not.toHaveBeenCalled();
    expect(notices.requestNotificationPermission).not.toHaveBeenCalled();
  });

  it('off the clock, hands nothing over and reads nothing', async () => {
    await opened({ allowed: true, onTime: true });
    await to('Hours');
    await awayAndBack();
    expect(notices.scheduleLocal).not.toHaveBeenCalled();
    expect(notices.cancelLocal).not.toHaveBeenCalled();
    expect(notices.lunchNoticeState).not.toHaveBeenCalled();
    expect(notices.requestNotificationPermission).not.toHaveBeenCalled();
  });
});
