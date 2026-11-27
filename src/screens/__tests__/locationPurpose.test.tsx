// Why the app reads a location, said before the phone first asks. An iPhone's own prompt shows the app's
// reason (app.json); Android's has no room for one, so on Android the Clock screen shows the same words
// first, the one time the phone is about to ask. One tap goes on, and so does closing it: no punch is held
// by more than that tap. The phone's location service is a stand-in here, as are its notifications.
// Everyone and everything here is made up.
import type { Platform as PlatformType } from 'react-native';

jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, HAS_LOGO_ART: false }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  enableNetworkProviderAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
}));
jest.mock('../../services/notifications', () => ({
  requestNotificationPermission: jest.fn(async () => true),
  lunchNoticeState: jest.fn(async () => 'on'),
  onTimeNotices: jest.fn(async () => true),
  allowOnTimeNotices: jest.fn(async () => true),
  scheduleLocal: jest.fn(async () => undefined),
  cancelLocal: jest.fn(async () => undefined),
}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: jest.fn() }),
  useRoute: () => ({ params: undefined }),
  useIsFocused: () => true,
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
const { Platform } = require('react-native') as { Platform: typeof PlatformType };
const { ClockScreen } = require('../clock/ClockScreen') as typeof import('../clock/ClockScreen');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const { LOCATION_PURPOSE } = require('../../config') as typeof import('../../config');
const phone = require('expo-location') as Record<string, jest.Mock>;
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
const settle = async () => {
  for (let i = 0; i < 15; i += 1) await act(async () => undefined);
};
async function tap(root: Root, id: string) {
  const [node] = byId(root, id);
  if (!node) throw new Error(`No ${id} on the screen.`);
  await act(async () => {
    pressOf(node)();
  });
  await settle();
}

/** What the phone says of the app's location permission: never asked, or allowed. */
const permission = (status: 'undetermined' | 'granted') =>
  ({ status, granted: status === 'granted', canAskAgain: true, expires: 'never', android: { accuracy: status === 'granted' ? 'fine' : 'none' } });

let root: Root | null = null;
let os: { restore(): void } | null = null;
beforeEach(() => {
  for (const fn of Object.values(phone)) if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
  phone.getForegroundPermissionsAsync.mockResolvedValue(permission('undetermined'));
  phone.requestForegroundPermissionsAsync.mockResolvedValue(permission('granted'));
  phone.hasServicesEnabledAsync.mockResolvedValue(true);
  phone.enableNetworkProviderAsync.mockResolvedValue(undefined);
  // At the pin, well placed.
  phone.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 10, longitude: 10, accuracy: 5 }, timestamp: 0, mocked: false });
  phone.getLastKnownPositionAsync.mockResolvedValue(null);
});
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  os?.restore();
  os = null;
});

async function openClock() {
  leesPhone();
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(ClockScreen)));
  return r;
}

describe('on Android', () => {
  beforeEach(() => {
    os = jest.replaceProperty(Platform, 'OS', 'android');
  });

  it('says why the app reads a location, and that supervisors see it, before the phone first asks', async () => {
    const r = await openClock();
    await tap(r, 'clock-in');
    expect(byId(r, 'location-purpose')).not.toHaveLength(0);
    expect(shown(r)).toContain(LOCATION_PURPOSE);
    expect(LOCATION_PURPOSE).toMatch(/supervisors can see where it was made/);
    expect(phone.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(byId(r, 'status-off')).not.toHaveLength(0);

    await tap(r, 'location-purpose-continue');
    expect(phone.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(byId(r, 'location-purpose')).toHaveLength(0);
    expect(byId(r, 'status-on')).not.toHaveLength(0);
    expect(useStore.getState().shifts[0]?.clockIn.geo).toBeDefined();
  });

  it('shows nothing first once the phone has asked', async () => {
    phone.getForegroundPermissionsAsync.mockResolvedValue(permission('granted'));
    const r = await openClock();
    await tap(r, 'clock-in');
    expect(byId(r, 'location-purpose')).toHaveLength(0);
    expect(phone.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(byId(r, 'status-on')).not.toHaveLength(0);
  });

  it('holds a clock-out by that one tap at most: closing the sheet carries on too', async () => {
    phone.getForegroundPermissionsAsync.mockResolvedValue(permission('granted'));
    const r = await openClock();
    await tap(r, 'clock-in');
    expect(byId(r, 'status-on')).not.toHaveLength(0);

    // The phone has never asked by the time of the clock-out (a stand-in for any way it comes to that).
    phone.getForegroundPermissionsAsync.mockResolvedValue(permission('undetermined'));
    phone.requestForegroundPermissionsAsync.mockClear();
    await tap(r, 'clock-out');
    await tap(r, 'confirm-clock-out');
    expect(byId(r, 'location-purpose')).not.toHaveLength(0);
    expect(phone.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    await tap(r, 'sheet-close');
    expect(phone.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(byId(r, 'status-off')).not.toHaveLength(0);
    expect(useStore.getState().shifts[0]?.clockOut).toBeDefined();
  });

  it('says it first on Mine boundary too, when a supervisor putting the pin is the first the phone asks', async () => {
    leesPhone();
    useStore.setState((s) => ({ employees: s.employees.map((e) => ({ ...e, role: 'supervisor' as const })), settings: { ...s.settings, site: null } }));
    const { SiteScreen } = require('../more/SiteScreen') as typeof import('../more/SiteScreen');
    root = createRoot();
    const r = root;
    const props = { navigation: { goBack: jest.fn() }, route: { key: 'Site', name: 'Site' } } as unknown as Parameters<typeof SiteScreen>[0];
    await act(async () => r.render(React.createElement(SiteScreen, props)));
    await tap(r, 'site-pin-here');
    expect(byId(r, 'location-purpose')).not.toHaveLength(0);
    expect(phone.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    await tap(r, 'location-purpose-continue');
    expect(phone.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(useStore.getState().settings.site?.center).toEqual({ lat: 10, lng: 10 });
  });
});

it('on an iPhone, shows nothing first: its own prompt gives the reason', async () => {
  const r = await openClock();
  await tap(r, 'clock-in');
  expect(byId(r, 'location-purpose')).toHaveLength(0);
  expect(phone.getForegroundPermissionsAsync).not.toHaveBeenCalled();
  expect(phone.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(byId(r, 'status-on')).not.toHaveLength(0);
});
