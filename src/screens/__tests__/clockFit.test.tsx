// Clock in on a short phone. Off the clock the Clock screen shows its coloured top, the time card reaching up
// over it, then Clock in. On a 360 x 640 dp Android phone with three-button navigation the tab bar starts
// about 60 dp above the foot of that button, so only a sliver of it showed until the person scrolled. The
// screen measures itself as it is laid out, and when the button would not be whole on the screen without
// scrolling, Clock in goes above the time card. Where it fits, as on every iPhone with no company logo, the
// screen is as it was. The phone's layout is played here by handing the screen the sizes a real phone would.
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
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[]; toJSON(): unknown } };
const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const { SafeAreaProvider } = require('react-native-safe-area-context') as typeof import('react-native-safe-area-context');
const { ClockScreen } = require('../clock/ClockScreen') as typeof import('../clock/ClockScreen');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const { color } = require('../../theme/theme') as typeof import('../../theme/theme');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Lee's own phone, Lee signed in, off the clock or on it. */
function leesPhone(on = false) {
  useStore.getState().ensureSeeded();
  const { settings } = useStore.getState();
  useStore.setState({
    employees: [{ id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true }],
    accounts: [{ id: 'acct-lee', employeeId: 'emp-lee', email: '', provider: 'company', createdAt: 1 }],
    session: { accountId: 'acct-lee', employeeId: 'emp-lee' },
    shifts: on ? [{ id: 'sh-lee', employeeId: 'emp-lee', clockIn: { at: Date.now() - 3_600_000, noLocation: 'off' }, lunches: [], breaks: [] }] : [],
    settings: {
      ...settings,
      company: { ...settings.company, name: 'Test Pit A', state: 'NV', pay: null },
      site: { name: 'Test Pit A', center: { lat: 10, lng: 10 }, radiusM: 500 },
    },
  });
}

let root: Root | null = null;
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

/** The Clock screen on a phone with a 24 dp status bar and `bottom` taken by its navigation bar. */
async function drawn({ clockOnly = false, bottom = 0, on = false } = {}) {
  leesPhone(on);
  root = createRoot();
  const r = root;
  const metrics = { frame: { x: 0, y: 0, width: 360, height: 640 }, insets: { top: 24, bottom, left: 0, right: 0 } };
  await act(async () => r.render(React.createElement(SafeAreaProvider, { initialMetrics: metrics }, React.createElement(ClockScreen, { clockOnly }))));
  for (let i = 0; i < 5; i += 1) await act(async () => undefined);
}
const byId = (id: string) => root!.container.queryAll((n) => n.props.testID === id);
/** A prop of the nearest component around a view that has it. */
function propOf(n: Node, prop: string): unknown {
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && fiber.memoizedProps?.[prop] === undefined) fiber = fiber.return;
  return fiber?.memoizedProps?.[prop];
}
/** The phone lays out the view with this test ID (or the nearest one around it that asks) at this size. */
async function laidOut(id: string, { y = 0, height }: { y?: number; height: number }) {
  const [node] = byId(id);
  if (!node) throw new Error(`No ${id} on the screen.`);
  const onLayout = propOf(node, 'onLayout') as (e: unknown) => void;
  await act(async () => onLayout({ nativeEvent: { layout: { x: 0, y, width: 360, height } } }));
}
/**
 * The sizes the phone gives the screen off the clock: the date line ends 248 dp down the coloured top, the
 * time card is 229 dp, the Clock in button 76, and the screen has `room` above the tab bar to show them in.
 */
async function measured(room: number) {
  await laidOut('clock-screen', { height: room });
  await laidOut('clock-date', { y: 224, height: 24 });
  await laidOut('time-card', { height: 229 });
  await laidOut('clock-in', { height: 76 });
}
/** Whether Clock in comes before the time card on the screen, as it is read from the top. */
function clockInFirst(): boolean {
  const shown = JSON.stringify(root!.container.toJSON());
  const button = shown.indexOf('"Clock in"');
  const card = shown.indexOf('"Time card"');
  if (button === -1 || card === -1) throw new Error('Clock in or the time card is not on the screen.');
  return button < card;
}
const fieldFoot = () => propOf(byId('status-off')[0]!, 'style') as unknown[];
const cornerOf = () => propOf(byId('time-card')[0]!, 'corner');

describe('Clock in on the Clock screen, off the clock', () => {
  it('goes above the time card on a 360 x 640 dp phone with three-button navigation (526 dp above the tab bar)', async () => {
    await drawn();
    expect(clockInFirst()).toBe(false);
    await measured(640 - 114);
    expect(clockInFirst()).toBe(true);
    // The coloured top no longer leaves room for the card to reach up into, and the card's clipped corner
    // shows the page it now sits on.
    expect(fieldFoot()).toContainEqual(expect.objectContaining({ paddingBottom: 20 }));
    expect(cornerOf()).toBe(color.kaolin);
  });

  it('stays under the time card where it fits, as before', async () => {
    await drawn();
    await measured(700);
    expect(clockInFirst()).toBe(false);
    expect(fieldFoot()).toContainEqual(expect.objectContaining({ paddingBottom: 64 }));
    expect(cornerOf()).toBe(color.ink);
  });

  it('stays where it went when the screen measures itself again in the new order', async () => {
    await drawn();
    await measured(640 - 114);
    expect(clockInFirst()).toBe(true);
    // Laid out again with the button first: the parts it measures are the same size.
    await measured(640 - 114);
    expect(clockInFirst()).toBe(true);
    // A taller screen (the no-signal strip gone, a phone turned to gesture navigation): measured again.
    await measured(700);
    expect(clockInFirst()).toBe(false);
  });

  it('alone, with no tab bar, counts the phone’s own navigation bar at the foot of the screen', async () => {
    await drawn({ clockOnly: true, bottom: 48 });
    await measured(620);
    expect(clockInFirst()).toBe(true);
    await act(async () => root!.unmount());
    root = null;

    await drawn({ clockOnly: true, bottom: 0 });
    await measured(620);
    expect(clockInFirst()).toBe(false);
  });

  it('on the clock, the screen is as it was: the time card first', async () => {
    await drawn({ on: true });
    await laidOut('clock-screen', { height: 640 - 114 });
    await laidOut('clock-date', { y: 224, height: 24 });
    await laidOut('time-card', { height: 229 });
    const shown = JSON.stringify(root!.container.toJSON());
    expect(shown.indexOf('"Time card"')).toBeLessThan(shown.indexOf('"Start lunch"'));
  });
});
