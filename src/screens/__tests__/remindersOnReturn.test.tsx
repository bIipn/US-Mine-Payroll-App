// Coming back to the app hands the phone the reminders for a shift again, on whatever screen is in front, not only
// on the Clock tab. A person may start lunch with notifications off, so the phone is handed nothing, then open
// My hours, turn notifications on in the phone's settings and come back to the app, which opens again on My hours:
// the notice that lunch is over must still come. The same goes for Alarms & reminders, without which Android may
// hold the notice back. Coming back never asks the phone for anything, and takes nothing off it: a notice the phone
// is holding back past its time still comes. Played here as the real App, its real navigator and the real Clock
// screen; every other screen is a stand-in, and the phone's notifications are played by a stand-in that holds what
// it is handed while notifications are allowed. Everyone and everything here is made up.
//
// A hand-over and a punch's own are made one at a time, each from the records as they are when its turn comes. On
// Android a punch's location read can show a system dialog (the prompt to turn location on, or the one asking
// whether the app may read it), which sends the app to the back and to the front again while the punch is being
// made, so the hand-over on coming back is planned from the shift before the punch.
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
/**
 * The phone gives no position, so every punch goes through with none (a clock-in marked for review). With `dialog`
 * set, the read shows a system dialog first, and answers a tick after it is gone.
 */
const mockLocation: { dialog: (() => void) | null } = { dialog: null };
jest.mock('../../services/location', () => ({
  locate: async () => {
    if (mockLocation.dialog) {
      mockLocation.dialog();
      await new Promise((r) => setTimeout(r, 0));
    }
    return { ok: false, reason: 'off' };
  },
}));
/**
 * The phone's notifications: whether they are allowed for the app, whether Alarms & reminders is on, and the
 * reminders it holds by id, each with whether it was handed over to come at the minute. Like the phone, it holds
 * nothing it is handed while notifications are off, and a reminder handed over is taken off first, then whether
 * notifications are allowed is read, then each is scheduled. A `slow` phone answers each of those calls a
 * macrotask later, as a real one answers from another thread.
 */
const mockPhone = { allowed: false, onTime: true, slow: false, holds: new Map<string, { at: number; onTime: boolean }>() };
jest.mock('../../services/notifications', () => {
  const takeOff = (ids: string[]) => ids.forEach((id) => mockPhone.holds.delete(id));
  const answer = async () => {
    if (mockPhone.slow) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    requestNotificationPermission: jest.fn(async () => mockPhone.allowed),
    lunchNoticeState: jest.fn(async () => (mockPhone.allowed ? 'on' : 'off')),
    onTimeNotices: jest.fn(async () => mockPhone.onTime),
    allowOnTimeNotices: jest.fn(async () => mockPhone.onTime),
    cancelLocal: jest.fn(async (ids: string[]) => {
      await answer();
      takeOff(ids);
    }),
    scheduleLocal: jest.fn(async (reminders: LocalReminder[]) => {
      await answer();
      takeOff(reminders.map((r) => r.id));
      await answer();
      if (!mockPhone.allowed) return;
      for (const r of reminders) {
        await answer();
        if (r.at > Date.now()) mockPhone.holds.set(r.id, { at: r.at, onTime: mockPhone.onTime });
      }
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
/** Lets a slow phone answer everything it was asked. */
async function drain() {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
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
  mockPhone.slow = false;
  mockLocation.dialog = null;
});

type Phone = { allowed: boolean; onTime: boolean; slow?: boolean };
type Shift = import('../../domain/types').Shift;

/** Lee's own phone, Lee signed in, at a made-up pit in `state` with a boundary set, with `shifts` (none: off the clock). */
function leesRecords(shifts: Shift[], state: string) {
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
      company: { ...settings.company, name: 'Test Pit A', state, pay: null, timeClock: undefined },
      site: { name: 'Test Pit A', center: { lat: 10, lng: 10 }, radiusM: 500 },
    },
  });
}

/**
 * Lee's phone (`leesRecords`), opened on the Clock tab. Then the phone as each test has it: nothing handed to it
 * yet, and nothing asked of it.
 */
async function opened(phone: Phone, shifts: Shift[] = [], state = 'NV') {
  useStore.setState({ hydrated: false, recordsUnreadable: false });
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(App)));
  await act(async () => {
    useStore.setState({ hydrated: true });
  });
  await act(async () => leesRecords(shifts, state));
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

describe('back in the app before lunch', () => {
  it('past the first deadline reminder, leaves the one the phone is holding back and hands over only those ahead', async () => {
    const now = Date.now();
    // Clocked in 4 hours 10 minutes ago in California: the reminder an hour before the lunch deadline was due 10
    // minutes ago, and the phone has held it back to save battery.
    const clockIn = now - (4 * 60 + 10) * 60_000;
    await opened({ allowed: true, onTime: false }, [{ id: 'sh-lee', employeeId: 'emp-lee', clockIn: { at: clockIn, noLocation: 'off' }, lunches: [], breaks: [] }], 'CA');
    mockPhone.holds.set('lunch-60', { at: clockIn + 4 * 3_600_000, onTime: false });

    await to('Hours');
    await awayAndBack();
    expect(mockPhone.holds.has('lunch-60')).toBe(true);
    const handed = notices.scheduleLocal.mock.calls.flatMap(([reminders]) => (reminders as LocalReminder[]).map((x) => x.id));
    expect(handed).toEqual(['lunch-30', 'lunch-15', 'lunch-0']);
    expect(notices.cancelLocal).not.toHaveBeenCalled();
    expect(notices.requestNotificationPermission).not.toHaveBeenCalled();
  });
});

describe('a punch whose location read shows a system dialog', () => {
  const DEADLINE_IDS = ['lunch-0', 'lunch-15', 'lunch-30', 'lunch-60'];
  const onThePhone = () => [...mockPhone.holds.keys()].sort();
  /** The dialog sends the app to the back, and to the front again once it is answered (No thanks, say). */
  const dialog = () => {
    for (const heard of [...listening]) heard('background');
    for (const heard of [...listening]) heard('active');
  };

  /** Lee on a California shift, Lunch reminders on, with the phone answering slowly: the deadline reminders are on it. */
  async function onShift() {
    const r = await opened({ allowed: true, onTime: true, slow: true }, [], 'CA');
    await tap(r, 'clock-in');
    await drain();
    expect(byId(r, 'status-on')).not.toHaveLength(0);
    expect(onThePhone()).toEqual(DEADLINE_IDS);
    mockLocation.dialog = dialog;
    return r;
  }

  it('clocking out leaves no lunch deadline reminder on the phone', async () => {
    const r = await onShift();
    await tap(r, 'clock-out');
    await tap(r, 'confirm-clock-out');
    await drain();
    expect(byId(r, 'status-off')).not.toHaveLength(0);
    expect(onThePhone()).toEqual([]);
  });

  it('starting lunch leaves the lunch-over notice on the phone and no deadline reminder', async () => {
    const r = await onShift();
    await tap(r, 'start-lunch');
    await drain();
    expect(byId(r, 'status-lunch')).not.toHaveLength(0);
    expect(onThePhone()).toEqual(['lunch-end']);
    expect(mockPhone.holds.get('lunch-end')?.at).toBe(lunchEnds());
  });
});

describe('opening the app just after lunch ended', () => {
  it('leaves on the phone the lunch-over notice it is holding back, so it still comes', async () => {
    const now = Date.now();
    const lunch = { start: { at: now - 31 * 60_000, noLocation: 'off' as const }, end: { at: now - 60_000, auto: true as const } };
    // The app was closed during lunch. Android, without Alarms & reminders, has held the notice back past its time.
    useStore.setState({ hydrated: false, recordsUnreadable: false });
    leesRecords([{ id: 'sh-lee', employeeId: 'emp-lee', clockIn: { at: now - 4 * 3_600_000, noLocation: 'off' }, lunches: [lunch], breaks: [] }], 'NV');
    Object.assign(mockPhone, { allowed: true, onTime: false });
    mockPhone.holds.clear();
    mockPhone.holds.set('lunch-end', { at: lunch.end.at, onTime: false });
    for (const fn of Object.values(notices)) fn.mockClear();

    root = createRoot();
    const r = root;
    await act(async () => r.render(React.createElement(App)));
    await act(async () => {
      useStore.setState({ hydrated: true });
    });
    await settle();
    expect(byId(r, 'status-on')).not.toHaveLength(0);
    // The records were read, and the reminders brought in line with the shift: the deadline ones taken off.
    expect(notices.cancelLocal).toHaveBeenCalled();
    expect(notices.cancelLocal.mock.calls.flat(2)).not.toContain('lunch-end');
    expect(mockPhone.holds.has('lunch-end')).toBe(true);
  });
});
