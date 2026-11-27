// The Clock screen drawn alone, with no tab bar under it: the view of someone taken off the roster while on
// the clock, who keeps it until they clock out (signedInView's clock_only). There the phone's own
// navigation bar is at the foot of the screen, so the screen leaves room for it under its last row, as the
// tab bar does in the tabs. And My hours is not there to open, so the hours line is not a button there.
// Everyone and everything here is made up.
jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, HAS_LOGO_ART: false }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('../../services/location', () => ({ locate: async () => ({ ok: false, reason: 'off' }) }));
jest.mock('../../services/notifications', () => ({
  requestNotificationPermission: jest.fn(async () => true),
  lunchNoticeState: jest.fn(async () => 'on'),
  onTimeNotices: jest.fn(async () => true),
  allowOnTimeNotices: jest.fn(async () => true),
  scheduleLocal: jest.fn(async () => undefined),
  cancelLocal: jest.fn(async () => undefined),
}));
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate }),
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
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[] } };
const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const { SafeAreaProvider } = require('react-native-safe-area-context') as typeof import('react-native-safe-area-context');
const { ClockScreen } = require('../clock/ClockScreen') as typeof import('../clock/ClockScreen');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const { space } = require('../../theme/theme') as typeof import('../../theme/theme');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Lee's own phone, Lee signed in and on the clock since an hour ago, taken off the roster meanwhile. */
function leesPhone() {
  useStore.getState().ensureSeeded();
  const { settings } = useStore.getState();
  useStore.setState({
    employees: [{ id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: false }],
    accounts: [{ id: 'acct-lee', employeeId: 'emp-lee', email: '', provider: 'company', createdAt: 1 }],
    session: { accountId: 'acct-lee', employeeId: 'emp-lee' },
    shifts: [{ id: 'sh-lee', employeeId: 'emp-lee', clockIn: { at: Date.now() - 3_600_000, noLocation: 'off' }, lunches: [], breaks: [] }],
    settings: { ...settings, company: { ...settings.company, name: 'Test Pit A', state: 'NV', pay: null } },
  });
}

let root: Root | null = null;
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  mockNavigate.mockClear();
});

/** The Clock screen on a phone whose navigation bar takes 48 at the foot of the screen. */
async function drawn(props: { clockOnly?: boolean }) {
  leesPhone();
  root = createRoot();
  const r = root;
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, bottom: 48, left: 0, right: 0 } };
  await act(async () => r.render(React.createElement(SafeAreaProvider, { initialMetrics: metrics }, React.createElement(ClockScreen, props))));
  for (let i = 0; i < 5; i += 1) await act(async () => undefined);
}
const byId = (id: string) => root!.container.queryAll((n) => n.props.testID === id);
/** A prop of the nearest component around a view that has it. */
function propOf(n: Node, prop: string): unknown {
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && fiber.memoizedProps?.[prop] === undefined) fiber = fiber.return;
  return fiber?.memoizedProps?.[prop];
}

describe('the foot of the Clock screen', () => {
  it('in the tabs keeps its own space: the tab bar under it clears the phone’s bar', async () => {
    await drawn({});
    expect(propOf(byId('clock-screen')[0]!, 'contentContainerStyle')).toMatchObject({ paddingBottom: space.xxl });
  });

  it('alone, leaves room for the phone’s navigation bar under the last row', async () => {
    await drawn({ clockOnly: true });
    expect(propOf(byId('clock-screen')[0]!, 'contentContainerStyle')).toMatchObject({ paddingBottom: space.xxl + 48 });
  });
});

describe('the hours line', () => {
  it('in the tabs opens My hours', async () => {
    await drawn({});
    const [line] = byId('pay-period-line');
    expect(line!.props.accessibilityRole).toBe('button');
    expect(line!.props.accessibilityLabel).toMatch(/Open my hours\.$/);
    await act(async () => (propOf(line!, 'onPress') as () => void)());
    expect(mockNavigate).toHaveBeenCalledWith('Hours');
  });

  it('alone, shows the hours and is not a button, since My hours is not there to open', async () => {
    await drawn({ clockOnly: true });
    const [line] = byId('pay-period-line');
    expect(byId('pay-period-hours')).not.toHaveLength(0);
    expect(line!.props.accessibilityRole).toBeUndefined();
    expect(line!.props.accessibilityLabel).not.toMatch(/Open my hours/);
    expect(propOf(line!, 'onPress')).toBeUndefined();
  });
});
