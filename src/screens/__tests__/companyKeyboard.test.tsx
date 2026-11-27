// More > Company > Pay periods: the first day of a period is typed as year-month-day, like 2026-11-01. On
// iPhone the box opens the numbers-and-punctuation keyboard. Android has no such keyboard (React Native's
// TextInput names it iOS only, and Android leaves the letter keyboard in its place, word suggestions on),
// so there it opens the number pad, which has the digits and a point, and suggestions are off on both.
// The web build keeps the iPhone's choice: react-native-web makes the number pad inputMode="numeric", which
// Safari on an iPhone shows as digits alone, with no dash to type the day with, and it leaves
// numbers-and-punctuation the ordinary keyboard. Everything here is made up.
import type { Company } from '../../domain/company';
import type { ScreenProps } from '../../navigation/types';

jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, HAS_LOGO_ART: false }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('../../services/notifications', () => ({ requestNotificationPermission: async () => true, cancelLocal: async () => undefined, scheduleLocal: async () => undefined }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// A store build: it holds nobody made up and names nobody. Set before anything below is required.
const savedEnv = { ...process.env };
afterAll(() => {
  process.env = savedEnv;
});
for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });

type Node = { props: Record<string, unknown> };
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[] } };
const React: typeof import('react') = require('react');
const { Platform } = require('react-native') as typeof import('react-native');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const { SafeAreaProvider } = require('react-native-safe-area-context') as typeof import('react-native-safe-area-context');
const { CompanyScreen } = require('../more/CompanyScreen') as typeof import('../more/CompanyScreen');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement as (type: unknown, props?: object | null, ...children: unknown[]) => React.ReactElement;

const WEEKLY: Company = { name: 'Test Pit A', state: 'NV', pay: { frequency: 'biweekly', firstDay: '2026-11-01', payday: { daysAfter: 5 }, ifBankClosed: 'before' } };
// The screen alone, with the one thing it asks of its navigator. A navigator in a web build measures its frame
// in the browser (getBoundingClientRect), which a test has no page for.
const screenProps = { navigation: { goBack: () => undefined }, route: { key: 'Company', name: 'Company' } } as unknown as ScreenProps<'Company'>;

let root: Root | null = null;
let os: jest.ReplaceProperty<string> | null = null;
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  os?.restore();
  os = null;
});

/** The Company screen on a phone of this kind, for a company paid every two weeks. */
async function opened(phone: 'ios' | 'android' | 'web') {
  os = jest.replaceProperty(Platform, 'OS', phone);
  useStore.getState().ensureSeeded();
  useStore.setState((s) => ({ settings: { ...s.settings, company: WEEKLY } }));
  root = createRoot();
  const r = root;
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, bottom: 0, left: 0, right: 0 } };
  await act(async () => {
    r.render(
      h(
        SafeAreaProvider,
        { initialMetrics: metrics },
        h(CompanyScreen, screenProps),
      ),
    );
  });
}

/** The text box with this test ID. */
function box(id: string): Node {
  const found = root!.container.queryAll((n) => n.props.testID === id && typeof n.props.onChangeText === 'function')[0];
  if (!found) throw new Error(`No text box ${id} here.`);
  return found;
}

describe('the first day of a pay period', () => {
  it('opens the number pad on Android, with no word suggestions', async () => {
    await opened('android');
    expect(box('company-first-day').props).toMatchObject({ keyboardType: 'numeric', autoCorrect: false, autoCapitalize: 'none' });
  });

  it('opens the numbers-and-punctuation keyboard on iPhone, as it always has', async () => {
    await opened('ios');
    expect(box('company-first-day').props).toMatchObject({ keyboardType: 'numbers-and-punctuation', autoCorrect: false, autoCapitalize: 'none' });
  });

  it('keeps a keyboard with a dash in the web build, which an iPhone may open in Safari', async () => {
    await opened('web');
    expect(box('company-first-day').props).toMatchObject({ keyboardType: 'numbers-and-punctuation', autoCorrect: false, autoCapitalize: 'none' });
  });
});
