// End use on a phone set to a region that writes 12,5 for twelve and a half: its number pad has a comma and,
// on the iPhone, no point, so 12,5 is twelve and a half gallons, not a number to turn back. A phone that
// writes a point still turns 12,5 back, with an example it can type. Everyone and everything here is made up.
import type { Equipment, OperatingLog } from '../../domain/types';

jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => true,
}));
// The phone's region settings, as expo-localization reads them.
let mockSeparator = ',';
jest.mock('expo-localization', () => {
  const locales = () => [{ languageTag: 'de-DE', decimalSeparator: mockSeparator, digitGroupingSeparator: mockSeparator === ',' ? '.' : ',' }];
  return { getLocales: locales, useLocales: locales };
});

// A store build: it connects, holds nobody made up and names nobody. Set before anything below is required.
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
const { EndUseScreen } = require('../equipment/EndUseScreen') as typeof import('../equipment/EndUseScreen');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const L5: Equipment = { id: 'eq-l5', unit: 'L-5', category: 'loader', make: 'Made-up', model: 'LX 1', status: 'ready', meter: 4250.5, meterUnit: 'hrs' };
const USE: OperatingLog = { id: 'op-l5', equipmentId: L5.id, employeeId: 'emp-lee', inspectionId: 'insp-l5', startAt: Date.now() - 3_600_000, startMeter: 4250.5 };

/** Lee's phone, Lee signed in, with L-5 checked out. */
function leesPhone() {
  useStore.getState().ensureSeeded();
  useStore.setState({
    employees: [{ id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true }],
    accounts: [{ id: 'acct-lee', employeeId: 'emp-lee', email: '', provider: 'company', createdAt: 1 }],
    session: { accountId: 'acct-lee', employeeId: 'emp-lee' },
    equipment: [L5],
    opLogs: [USE],
  });
}

let root: Root | null = null;
const navigation = { goBack: jest.fn(), navigate: jest.fn(), getState: () => ({ routeNames: ['MrfForm'] }) };

async function openEndUse() {
  leesPhone();
  root = createRoot();
  const props = { navigation, route: { key: 'EndUse', name: 'EndUse', params: { logId: USE.id } } } as unknown as Parameters<typeof EndUseScreen>[0];
  await act(async () => root!.render(React.createElement(EndUseScreen, props)));
}

/** What a tap on a view does: the onPress of the nearest component around it that has one. */
function press(id: string) {
  const [n] = root!.container.queryAll((x) => x.props.testID === id);
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error(`Nothing to press at ${id}.`);
  return act(async () => (fiber!.memoizedProps!.onPress as () => void)());
}
function type(id: string, text: string) {
  const [input] = root!.container.queryAll((n) => n.props.testID === id && typeof n.props.onChangeText === 'function');
  return act(async () => (input.props.onChangeText as (t: string) => void)(text));
}
const shown = () => JSON.stringify(root!.container.toJSON());

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  navigation.goBack.mockClear();
  mockSeparator = ',';
});

it('reads 12,5 as twelve and a half gallons, and 4300,5 as the hours, on a phone that writes a comma for a part', async () => {
  await openEndUse();
  await type('end-meter', '4300,5');
  await type('end-fuel', '12,5');
  await press('parked-safe');
  await press('end-use-submit');
  expect(useStore.getState().opLogs.find((l) => l.id === USE.id)).toMatchObject({ endMeter: 4300.5, fuelGal: 12.5, parkedSafely: true });
  expect(navigation.goBack).toHaveBeenCalledTimes(1);
});

it('says how to type the gallons with the comma such a phone has, when what is typed cannot be read', async () => {
  await openEndUse();
  await type('end-meter', '4300,5');
  await type('end-fuel', '12,5,0');
  await press('parked-safe');
  await press('end-use-submit');
  expect(shown()).toContain('Enter the gallons added as a number, like 12,5, or leave it blank.');
  expect(useStore.getState().opLogs.find((l) => l.id === USE.id)?.endAt).toBeUndefined();
  expect(navigation.goBack).not.toHaveBeenCalled();
});

it('still turns 12,5 back on a phone that writes a point, with an example it can type', async () => {
  mockSeparator = '.';
  await openEndUse();
  await type('end-meter', '4300.5');
  await type('end-fuel', '12,5');
  await press('parked-safe');
  await press('end-use-submit');
  expect(shown()).toContain('Enter the gallons added as a number, like 12.5, or leave it blank.');
  expect(useStore.getState().opLogs.find((l) => l.id === USE.id)?.endAt).toBeUndefined();
});
