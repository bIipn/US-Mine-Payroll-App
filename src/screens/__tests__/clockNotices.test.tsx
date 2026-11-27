// The Clock screen and the phone's notifications. The phone is asked whether the app may send them at clock-in
// only (and from the Lunch reminders setting on More): starting lunch, a rest break and clocking out never ask
// again, so a phone told no once is not asked again at every punch. Android 13 and later ask a second time after a
// first no and never after a second, and a person can turn the Lunch is over kind of notification off by itself in
// the phone's settings; at lunch the screen says which is off, and on Android opens the phone's settings for it.
// The phone's notifications are stand-ins here. Everyone and everything here is made up.
import type { Platform as PlatformType } from 'react-native';

import type { LunchNotice } from '../../services/notifications';

jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, HAS_LOGO_ART: false }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
// The phone gives no position, so every punch goes through with none (a clock-in marked for review).
jest.mock('../../services/location', () => ({ locate: async () => ({ ok: false, reason: 'off' }) }));
jest.mock('../../services/notifications', () => ({
  requestNotificationPermission: jest.fn(async () => false),
  lunchNoticeState: jest.fn(async () => 'off'),
  onTimeNotices: jest.fn(async () => true),
  allowOnTimeNotices: jest.fn(async () => true),
  scheduleLocal: jest.fn(async () => undefined),
  cancelLocal: jest.fn(async () => undefined),
}));
/** Whether the Clock tab is the one in front. */
let mockFocused = true;
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: jest.fn() }),
  useRoute: () => ({ params: undefined }),
  useIsFocused: () => mockFocused,
}));

// A store build: it holds nobody made up and names nobody. Set before anything below is required.
const savedEnv = { ...process.env };
afterAll(() => {
  process.env = savedEnv;
});
for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });

type Fiber = { return: Fiber | null; memoizedProps?: Record<string, unknown> } | null;
type Node = { props: Record<string, unknown>; unstable_fiber: unknown };
type Json = { children?: (Json | string)[] | null } | string | null;
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[]; toJSON(): Json | Json[] } };
const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const { AppState, Linking, Platform } = require('react-native') as {
  AppState: { addEventListener: jest.Mock };
  Linking: { openSettings: jest.Mock };
  Platform: typeof PlatformType;
};
const { ClockScreen } = require('../clock/ClockScreen') as typeof import('../clock/ClockScreen');
const { watchReminders } = require('../../services/reminders') as typeof import('../../services/reminders');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const notices = require('../../services/notifications') as Record<string, jest.Mock>;
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Lee's own phone, Lee signed in, off the clock, at a made-up pit with a boundary set. */
function leesPhone() {
  useStore.getState().ensureSeeded();
  const { settings } = useStore.getState();
  useStore.setState({
    employees: [{ id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true }],
    accounts: [{ id: 'acct-lee', employeeId: 'emp-lee', email: '', provider: 'company', createdAt: 1 }],
    session: { accountId: 'acct-lee', employeeId: 'emp-lee' },
    shifts: [],
    settings: {
      ...settings,
      company: { ...settings.company, name: 'Test Pit A', state: 'NV', pay: null },
      site: { name: 'Test Pit A', center: { lat: 10, lng: 10 }, radiusM: 500 },
    },
  });
}

const byId = (root: Root, id: string) => root.container.queryAll((n) => n.props.testID === id);
function text(json: Json | Json[]): string {
  if (json == null) return '';
  if (typeof json === 'string') return json;
  if (Array.isArray(json)) return json.map(text).join(' ');
  return (json.children ?? []).map(text).join(' ');
}
const shown = (root: Root) => text(root.container.toJSON());
/** What a tap on a view does: the onPress of the nearest component around it that has one. */
function pressOf(n: Node): () => void {
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('Nothing to press here.');
  return fiber.memoizedProps!.onPress as () => void;
}
async function tap(root: Root, id: string) {
  const [node] = byId(root, id);
  if (!node) throw new Error(`No ${id} on the screen.`);
  await act(async () => {
    pressOf(node)();
  });
  // Let the punch's notices settle: the phone's answers, then the reminders handed to it.
  for (let i = 0; i < 5; i += 1) await act(async () => undefined);
}
const noticeIs = (state: LunchNotice) => notices.lunchNoticeState.mockImplementation(async () => state);

let root: Root | null = null;
/** Stops the app's own hand-over of the reminders on coming back to the front, which App starts with the records read. */
let stopWatching: (() => void) | null = null;
beforeEach(() => {
  mockFocused = true;
  for (const fn of Object.values(notices)) fn.mockClear();
  notices.requestNotificationPermission.mockImplementation(async () => false);
  notices.onTimeNotices.mockImplementation(async () => true);
  noticeIs('off');
  AppState.addEventListener.mockClear();
  Linking.openSettings.mockClear();
  stopWatching = watchReminders();
});
afterEach(async () => {
  stopWatching?.();
  stopWatching = null;
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});
/** The ids of the reminders handed to the phone, once for each time each was handed over. */
const handedOver = () => notices.scheduleLocal.mock.calls.flatMap(([reminders]) => reminders as { id: string }[]).map((x) => x.id);

async function clockedInAndAtLunch() {
  leesPhone();
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(ClockScreen)));
  await tap(r, 'clock-in');
  await tap(r, 'start-lunch');
  return r;
}

it('asks for notifications at clock-in only, not again at lunch or a rest break', async () => {
  leesPhone();
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(ClockScreen)));
  await tap(r, 'clock-in');
  expect(byId(r, 'status-on')).not.toHaveLength(0);
  expect(notices.requestNotificationPermission).toHaveBeenCalledTimes(1);
  await tap(r, 'rest-break');
  await tap(r, 'rest-break');
  await tap(r, 'start-lunch');
  expect(byId(r, 'status-lunch')).not.toHaveLength(0);
  expect(notices.requestNotificationPermission).toHaveBeenCalledTimes(1);
  // What the phone allows is still read at every punch, without asking.
  expect(notices.lunchNoticeState.mock.calls.length).toBeGreaterThanOrEqual(4);
});

it('at lunch, says notifications are off for the app', async () => {
  noticeIs('off');
  const r = await clockedInAndAtLunch();
  expect(byId(r, 'lunch-no-notice')).not.toHaveLength(0);
  expect(shown(r)).toContain('Notifications are off for this app');
});

it('at lunch, says so when only the Lunch is over notifications are turned off', async () => {
  noticeIs('lunch_over_off');
  const r = await clockedInAndAtLunch();
  expect(byId(r, 'lunch-no-notice')).not.toHaveLength(0);
  expect(shown(r)).toContain('Lunch is over notifications are turned off');
  expect(shown(r)).toContain('turn on the one called Lunch is over');
  expect(shown(r)).not.toContain('Nothing to tap');
  // Alarms & reminders would not help a notice the phone will not show.
  expect(byId(r, 'on-time-notice')).toHaveLength(0);
});

it('at lunch with the notice on, says it will come', async () => {
  noticeIs('on');
  const r = await clockedInAndAtLunch();
  expect(byId(r, 'lunch-no-notice')).toHaveLength(0);
  expect(shown(r)).toContain('Nothing to tap');
});

it('on an iPhone, the warning has no settings button', async () => {
  noticeIs('off');
  const r = await clockedInAndAtLunch();
  expect(byId(r, 'open-notice-settings')).toHaveLength(0);
});

it('on Android, opens the phone settings, and once the notice is on there hands the phone the lunch-over notice', async () => {
  const os = jest.replaceProperty(Platform, 'OS', 'android');
  try {
    noticeIs('lunch_over_off');
    const r = await clockedInAndAtLunch();
    await tap(r, 'open-notice-settings');
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    expect(notices.requestNotificationPermission).toHaveBeenCalledTimes(1);

    // Back in the app with the notice turned on in the phone's settings.
    noticeIs('on');
    notices.scheduleLocal.mockClear();
    const listeners = AppState.addEventListener.mock.calls.filter(([event]) => event === 'change').map(([, heard]) => heard as (s: string) => void);
    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const heard of listeners) heard('active');
    });
    for (let i = 0; i < 5; i += 1) await act(async () => undefined);
    expect(byId(r, 'lunch-no-notice')).toHaveLength(0);
    expect(shown(r)).toContain('Nothing to tap');
    // Handed over once: by the app coming back, not again by the screen.
    expect(handedOver().filter((id) => id === 'lunch-end')).toHaveLength(1);
    // Coming back asks nothing.
    expect(notices.requestNotificationPermission).toHaveBeenCalledTimes(1);
  } finally {
    os.restore();
  }
});

// The screen does not only learn what the phone allows from a punch made in the running app. It reads it again,
// without asking anything, whenever it is opened or comes back into view on a shift and whenever the app comes back
// to the front: the app may have been closed during a lunch, or a person may turn a kind of notification off or on in
// the phone's settings in the middle of one.
describe('reading what the phone allows again, with no punch', () => {
  /** Lee clocked in and started lunch earlier, and the app was closed since: the screen opens at lunch. */
  async function openedAtLunch() {
    leesPhone();
    expect(useStore.getState().clockIn('off').ok).toBe(true);
    expect(useStore.getState().startLunch('off').ok).toBe(true);
    root = createRoot();
    const r = root;
    await act(async () => r.render(React.createElement(ClockScreen)));
    for (let i = 0; i < 5; i += 1) await act(async () => undefined);
    expect(byId(r, 'status-lunch')).not.toHaveLength(0);
    return r;
  }
  /** Back in the app from somewhere else, the phone's settings say. */
  async function backToFront() {
    const listeners = AppState.addEventListener.mock.calls.filter(([event]) => event === 'change').map(([, heard]) => heard as (s: string) => void);
    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const heard of listeners) heard('active');
    });
    for (let i = 0; i < 5; i += 1) await act(async () => undefined);
  }
  /** Nothing here asks the phone anything: it only reads. */
  function askedNothing() {
    expect(notices.requestNotificationPermission).not.toHaveBeenCalled();
    expect(notices.allowOnTimeNotices).not.toHaveBeenCalled();
  }
  function onAndroid() {
    return jest.replaceProperty(Platform, 'OS', 'android');
  }

  it('opened at lunch with the Lunch is over notifications turned off, says so', async () => {
    const os = onAndroid();
    try {
      noticeIs('lunch_over_off');
      const r = await openedAtLunch();
      expect(byId(r, 'lunch-no-notice')).not.toHaveLength(0);
      expect(shown(r)).toContain('Lunch is over notifications are turned off');
      expect(shown(r)).not.toContain('Nothing to tap');
      askedNothing();
    } finally {
      os.restore();
    }
  });

  it('opened at lunch with notifications off for the app, says so', async () => {
    noticeIs('off');
    const r = await openedAtLunch();
    expect(byId(r, 'lunch-no-notice')).not.toHaveLength(0);
    expect(shown(r)).toContain('Notifications are off for this app');
    askedNothing();
  });

  it('back from the phone settings with the Lunch is over notifications on again, the warning goes and the notice is handed over', async () => {
    const os = onAndroid();
    try {
      noticeIs('lunch_over_off');
      const r = await openedAtLunch();
      expect(byId(r, 'lunch-no-notice')).not.toHaveLength(0);

      noticeIs('on');
      notices.scheduleLocal.mockClear();
      await backToFront();
      expect(byId(r, 'lunch-no-notice')).toHaveLength(0);
      expect(shown(r)).toContain('Nothing to tap');
      expect(handedOver().filter((id) => id === 'lunch-end')).toHaveLength(1);
      askedNothing();
    } finally {
      os.restore();
    }
  });

  it('back from the phone settings with the Lunch is over notifications turned off during lunch, the warning shows', async () => {
    const os = onAndroid();
    try {
      noticeIs('on');
      const r = await openedAtLunch();
      expect(shown(r)).toContain('Nothing to tap');

      noticeIs('lunch_over_off');
      await backToFront();
      expect(byId(r, 'lunch-no-notice')).not.toHaveLength(0);
      expect(shown(r)).toContain('Lunch is over notifications are turned off');
      expect(shown(r)).not.toContain('Nothing to tap');
      askedNothing();
    } finally {
      os.restore();
    }
  });

  it('back on the Clock tab after notifications were turned off, the warning shows', async () => {
    noticeIs('on');
    const r = await openedAtLunch();
    expect(shown(r)).toContain('Nothing to tap');

    // Another tab, then the phone's settings, then the Clock tab again.
    mockFocused = false;
    await act(async () => r.render(React.createElement(ClockScreen)));
    noticeIs('off');
    mockFocused = true;
    await act(async () => r.render(React.createElement(ClockScreen)));
    for (let i = 0; i < 5; i += 1) await act(async () => undefined);
    expect(byId(r, 'lunch-no-notice')).not.toHaveLength(0);
    expect(shown(r)).toContain('Notifications are off for this app');
    askedNothing();
  });

  it('back from the phone settings with Alarms & reminders on, the Allow on-time notices card goes and the notice is handed over again', async () => {
    const os = onAndroid();
    try {
      noticeIs('on');
      notices.onTimeNotices.mockImplementation(async () => false);
      const r = await openedAtLunch();
      expect(byId(r, 'on-time-notice')).not.toHaveLength(0);

      notices.onTimeNotices.mockImplementation(async () => true);
      notices.scheduleLocal.mockClear();
      await backToFront();
      expect(byId(r, 'on-time-notice')).toHaveLength(0);
      expect(handedOver().filter((id) => id === 'lunch-end')).toHaveLength(1);
      askedNothing();
    } finally {
      os.restore();
    }
  });

  it('off the clock, reads nothing until a punch', async () => {
    leesPhone();
    root = createRoot();
    const r = root;
    await act(async () => r.render(React.createElement(ClockScreen)));
    for (let i = 0; i < 5; i += 1) await act(async () => undefined);
    expect(byId(r, 'status-off')).not.toHaveLength(0);
    expect(notices.lunchNoticeState).not.toHaveBeenCalled();
    askedNothing();
  });
});
