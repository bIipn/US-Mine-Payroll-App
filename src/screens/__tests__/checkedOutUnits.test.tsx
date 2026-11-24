// The units a person has checked out on this phone, each opening End use: the Clock screen's "You have
// checked out", shared with the Checklists screen. The Checklists screen lists the fleet, so it lists apart
// the units the company took out of the fleet while they were checked out here, which the phone keeps until
// their use is ended: in a company with the time clock off there is no Clock screen, and signing out of the
// phone waits until every unit is checked back in. Everyone and everything here is made up.
import type { Equipment, OperatingLog } from '../../domain/types';

jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({ params: undefined }),
  useIsFocused: () => true,
}));

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
const { CheckedOutUnits } = require('../equipment/CheckedOutUnits') as typeof import('../equipment/CheckedOutUnits');
const { EquipmentScreen } = require('../equipment/EquipmentScreen') as typeof import('../equipment/EquipmentScreen');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const { freshReceiving } = require('../../domain/receive') as typeof import('../../domain/receive');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const L5: Equipment = { id: 'eq-l5', unit: 'L-5', category: 'loader', make: 'Made-up', model: 'LX 1', status: 'ready', meter: 400, meterUnit: 'hrs' };
const T99: Equipment = { id: 'eq-t99', unit: 'T-99', category: 'haul_truck', make: 'Made-up', model: 'HX 40', status: 'ready', meter: 100, meterUnit: 'hrs' };
const use = (id: string, equipmentId: string): OperatingLog => ({ id, equipmentId, employeeId: 'emp-lee', inspectionId: `insp-${id}`, startAt: Date.now() - 3_600_000, startMeter: 100 });

/** Lee's own phone, Lee signed in: L-5 checked out from the fleet, and T-99, which the company took out of the fleet meanwhile. */
function leesPhone() {
  useStore.getState().ensureSeeded();
  useStore.setState({
    employees: [{ id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true }],
    accounts: [{ id: 'acct-lee', employeeId: 'emp-lee', email: '', provider: 'company', createdAt: 1 }],
    session: { accountId: 'acct-lee', employeeId: 'emp-lee' },
    equipment: [L5],
    opLogs: [use('op-l5', L5.id), use('op-t99', T99.id)],
    connectedCompany: { id: 'c-test-a', name: 'Test Pit A', role: 'employee', userId: 'u-lee', email: 'lee@example.test' },
    syncedWith: 'c-test-a',
    receiving: { ...freshReceiving('c-test-a', 'employee'), gone: { [T99.id]: T99 } },
  });
}

/** The rows that open End use, in the order shown: their views, by test ID. */
const endUseRows = (root: Root) => root.container.queryAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('in-use-'));
/** What a tap on a view does: the onPress of the nearest component around it that has one (a Row's, through its Pressable). */
function pressOf(n: Node): () => void {
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('Nothing to press here.');
  return fiber.memoizedProps!.onPress as () => void;
}

let root: Root | null = null;
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  mockNavigate.mockClear();
});

it('lists every unit the person has checked out, as the Clock screen shows them, each opening End use', async () => {
  leesPhone();
  root = createRoot();
  await act(async () => root!.render(React.createElement(CheckedOutUnits, { employeeId: 'emp-lee' })));
  expect(endUseRows(root).map((n) => n.props.testID)).toEqual(['in-use-L-5', 'in-use-T-99']);
  expect(JSON.stringify(root.container.toJSON())).toContain('Taken out of the fleet.');
  await act(async () => pressOf(endUseRows(root!)[0])());
  expect(mockNavigate).toHaveBeenLastCalledWith('EndUse', { logId: 'op-l5' });
});

it('the Checklists screen lists a unit taken out of the fleet while it was checked out, with End use', async () => {
  leesPhone();
  root = createRoot();
  await act(async () => root!.render(React.createElement(EquipmentScreen)));
  // L-5 is in the fleet list, with End use on its sheet. T-99 is in the fleet no more, so it is listed apart.
  expect(root.container.queryAll((n) => n.props.testID === 'unit-L-5')).toHaveLength(1);
  const rows = endUseRows(root);
  expect(rows.map((n) => n.props.testID)).toEqual(['in-use-T-99']);
  expect(JSON.stringify(root.container.toJSON())).toContain('Taken out of the fleet. Tap to end use.');
  await act(async () => pressOf(rows[0])());
  expect(mockNavigate).toHaveBeenCalledWith('EndUse', { logId: 'op-t99' });
});
