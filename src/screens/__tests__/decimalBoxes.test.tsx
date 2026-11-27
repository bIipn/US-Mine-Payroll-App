// The boxes with a decimal pad, on a phone set to a region that writes 12,5 for twelve and a half, and on one
// that writes 12.5. The iPhone's decimal pad in such a region has a comma and no point, so each box reads a
// comma as the part, starts with what it holds written with that comma, gives its example with it, and shows
// the reading beside it the same way. A phone that writes a point reads, writes and shows them as before, and
// still turns back a comma it cannot place. Everyone and everything here is made up.
import type { DayLine } from '../../domain/payroll';
import type { Equipment, Mrf, OperatingLog } from '../../domain/types';

jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => true,
  // The checklist asks before it is left half filled; there is no navigator here to leave.
  usePreventRemove: () => undefined,
}));
// The phone's region settings, as expo-localization reads them.
let mockSeparator: ',' | '.' = ',';
jest.mock('expo-localization', () => {
  const locales = () =>
    mockSeparator === ','
      ? [{ languageTag: 'de-DE', decimalSeparator: ',', digitGroupingSeparator: '.' }]
      : [{ languageTag: 'en-US', decimalSeparator: '.', digitGroupingSeparator: ',' }];
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
const { RateSheet } = require('../../components/PayEstimate') as typeof import('../../components/PayEstimate');
const { LeaveSheet } = require('../../components/LeaveSheet') as typeof import('../../components/LeaveSheet');
const { MrfDetailScreen } = require('../equipment/MrfDetailScreen') as typeof import('../equipment/MrfDetailScreen');
const { InspectionScreen } = require('../equipment/InspectionScreen') as typeof import('../equipment/InspectionScreen');
const { EndUseScreen } = require('../equipment/EndUseScreen') as typeof import('../equipment/EndUseScreen');
const { MrfFormScreen } = require('../equipment/MrfFormScreen') as typeof import('../equipment/MrfFormScreen');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const { startOfDay } = require('../../util/format') as typeof import('../../util/format');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement as (type: unknown, props?: object | null) => React.ReactElement;

/** The space a phone that writes a comma puts between thousands, which does not break across lines. */
const NBSP = ' ';
const L5: Equipment = { id: 'eq-l5', unit: 'L-5', category: 'loader', make: 'Made-up', model: 'LX 1', status: 'ready', meter: 4250.5, meterUnit: 'hrs' };
const USE: OperatingLog = { id: 'op-l5', equipmentId: L5.id, employeeId: 'emp-lee', inspectionId: 'insp-l5', startAt: Date.now() - 3_600_000, startMeter: 4250.5 };
const MRF: Mrf = {
  id: 'mrf-1', number: 1, requestedBy: 'emp-lee', createdAt: Date.now() - 86_400_000, equipmentId: L5.id, description: 'Work light out',
  priority: 'routine', items: [], taggedOut: false, assignedTo: 'emp-lee', status: 'open', history: [{ at: Date.now() - 86_400_000, by: 'emp-lee', status: 'open' }],
};

/** Lee's phone, Lee a supervisor, signed in, not joined to a company, with L-5 in the fleet and checked out. */
function leesPhone() {
  useStore.getState().ensureSeeded();
  useStore.setState((s) => ({
    employees: [{ id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'supervisor', active: true }],
    accounts: [{ id: 'acct-lee', employeeId: 'emp-lee', email: '', provider: 'company', createdAt: 1 }],
    session: { accountId: 'acct-lee', employeeId: 'emp-lee' },
    connectedCompany: null,
    equipment: [L5],
    opLogs: [USE],
    inspections: [],
    mrfs: [MRF],
    leave: [],
    payRates: {},
    settings: { ...s.settings, allowSectionAllOk: true },
  }));
}

let root: Root | null = null;
const navigation = { goBack: jest.fn(), navigate: jest.fn(), replace: jest.fn(), dispatch: jest.fn(), getState: () => ({ routeNames: ['MrfForm'] }) };
async function show(element: React.ReactElement) {
  root = createRoot();
  await act(async () => root!.render(element));
}
const screen = (component: unknown, name: string, params: object) =>
  h(component, { navigation, route: { key: name, name, params } });

/** What a tap on a view does: the onPress of the nearest component around it that has one. */
function press(id: string) {
  const [n] = root!.container.queryAll((x) => x.props.testID === id);
  if (!n) throw new Error(`Nothing is shown at ${id}.`);
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error(`Nothing to press at ${id}.`);
  return act(async () => (fiber!.memoizedProps!.onPress as () => void)());
}
const box = (id: string) => root!.container.queryAll((n) => n.props.testID === id && typeof n.props.onChangeText === 'function')[0];
function type(id: string, text: string) {
  const input = box(id);
  return act(async () => (input.props.onChangeText as (t: string) => void)(text));
}
/** The words on the screen, a line for each piece of text, as one Text shows them however React splits them. */
type Shown = { children?: (Shown | string)[] | null } | string | null;
function words(node: Shown): string[] {
  if (!node || typeof node === 'string') return [];
  const kids = node.children ?? [];
  const own = kids.filter((k): k is string => typeof k === 'string').join('');
  return [...(own ? [own] : []), ...kids.flatMap((k) => (typeof k === 'string' ? [] : words(k)))];
}
const shown = () => words(root!.container.toJSON() as Shown).join('\n');

beforeEach(() => {
  mockSeparator = ',';
  leesPhone();
});
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  jest.clearAllMocks();
});

describe('the hourly rate', () => {
  const rate = () => useStore.getState().payRates['emp-lee'];
  const openRate = () => show(h(RateSheet, { visible: true, onClose: jest.fn() }));

  it('reads 9,75 as $9.75 an hour on a phone that writes a comma, never $975.00', async () => {
    await openRate();
    expect(box('rate-input').props.placeholder).toBe('24,00');
    await type('rate-input', '9,75');
    await press('rate-save');
    expect(rate()).toBe(975);
  });

  it('starts from the saved rate written with that comma, which saves back as the same rate', async () => {
    useStore.setState({ payRates: { 'emp-lee': 2450 } });
    await openRate();
    expect(box('rate-input').props.value).toBe('24,50');
    await press('rate-save');
    expect(rate()).toBe(2450);
  });

  it('takes a dollar sign, and turns back what it cannot read with an example that phone can type', async () => {
    await openRate();
    await type('rate-input', '$24,50');
    await press('rate-save');
    expect(rate()).toBe(2450);
    useStore.setState({ payRates: {} });
    await type('rate-input', '24,50,1');
    await press('rate-save');
    expect(shown()).toContain('Enter your hourly rate in dollars, like 24,00.');
    expect(rate()).toBeUndefined();
  });

  it('is as before on a phone that writes a point, and asks again for 9,75 there rather than saving $975.00', async () => {
    mockSeparator = '.';
    useStore.setState({ payRates: { 'emp-lee': 2450 } });
    await openRate();
    expect(box('rate-input').props.value).toBe('24.50');
    expect(box('rate-input').props.placeholder).toBe('24.00');
    await type('rate-input', '$26.50');
    await press('rate-save');
    expect(rate()).toBe(2650);
    await type('rate-input', '9,75');
    await press('rate-save');
    expect(shown()).toContain('Enter your hourly rate in dollars, like 24.00.');
    expect(rate()).toBe(2650);
  });
});

describe('hours of paid leave', () => {
  const today = startOfDay(Date.now());
  const days = [{ dayStart: today, shifts: [] }] as unknown as DayLine[];
  const openLeave = () =>
    show(h(LeaveSheet, { visible: true, onClose: jest.fn(), employeeId: 'emp-lee', employeeName: 'Lee Park', days, leave: [], now: Date.now() }));
  const hours = () => useStore.getState().leave.map((l) => l.hours);

  it('starts at 8,00 on a phone that writes a comma, and saves it as eight hours', async () => {
    await openLeave();
    expect(box('leave-hours').props.value).toBe('8,00');
    await press('leave-save');
    expect(hours()).toEqual([800]);
  });

  it('reads 4,5 as four and a half hours there', async () => {
    await openLeave();
    await type('leave-hours', '4,5');
    await press('leave-save');
    expect(hours()).toEqual([450]);
  });

  it('says what it takes with that phone’s comma', async () => {
    await openLeave();
    await type('leave-hours', '25');
    await press('leave-save');
    expect(shown()).toContain('Enter the hours for that day, between 0,25 and 24.');
    await type('leave-hours', '4,5,5');
    await press('leave-save');
    expect(shown()).toContain('Enter the hours for that day, between 0,25 and 24.');
    expect(hours()).toEqual([]);
  });

  it('is as before on a phone that writes a point', async () => {
    mockSeparator = '.';
    await openLeave();
    expect(box('leave-hours').props.value).toBe('8.00');
    await type('leave-hours', '4,5');
    await press('leave-save');
    expect(shown()).toContain('Enter the hours for that day, between 0.25 and 24.');
    expect(hours()).toEqual([]);
    await type('leave-hours', '4.5');
    await press('leave-save');
    expect(hours()).toEqual([450]);
  });
});

describe('the time spent on a maintenance request', () => {
  const openRequest = async () => {
    await show(screen(MrfDetailScreen, 'MrfDetail', { mrfId: MRF.id }));
    await press('mrf-complete');
    await type('mrf-note', 'Replaced the work light');
  };
  const done = () => useStore.getState().mrfs.find((m) => m.id === MRF.id);

  it('reads 1,5 as an hour and a half on a phone that writes a comma', async () => {
    await openRequest();
    expect(box('mrf-hours').props.placeholder).toBe('1,5');
    await type('mrf-hours', '1,5');
    await press('mrf-apply');
    expect(done()).toMatchObject({ status: 'completed', timeSpent: 150 });
  });

  it('says how to type it with that phone’s comma, from the screen and from the store', async () => {
    await openRequest();
    await type('mrf-hours', '1,5,5');
    await press('mrf-apply');
    expect(shown()).toContain('Enter the time spent in hours, like 1,5.');
    // More hours than the store takes for one request: its own words, with the same comma.
    await type('mrf-hours', '1500');
    await press('mrf-apply');
    expect(shown()).toContain('Enter the time spent in hours, like 1,5.');
    expect(done()?.status).toBe('open');
  });

  it('is as before on a phone that writes a point', async () => {
    mockSeparator = '.';
    await openRequest();
    expect(box('mrf-hours').props.placeholder).toBe('1.5');
    await type('mrf-hours', '1,5');
    await press('mrf-apply');
    expect(shown()).toContain('Enter the time spent in hours, like 1.5.');
    expect(done()?.status).toBe('open');
    await type('mrf-hours', '1.5');
    await press('mrf-apply');
    expect(done()).toMatchObject({ status: 'completed', timeSpent: 150 });
  });
});

describe('the equipment checklist', () => {
  const openChecklist = () => show(screen(InspectionScreen, 'Inspection', { equipmentId: L5.id }));

  it('shows the last reading beside the box the way the box has it, on a phone that writes a comma', async () => {
    await openChecklist();
    expect(box('meter').props.value).toBe('4250,5');
    expect(shown()).toContain(`Last reading 4${NBSP}250,5 hrs`);
    expect(shown()).not.toContain('4,250.5');
    await type('meter', '4000,5');
    expect(shown()).toContain(`That is lower than the last reading of 4${NBSP}250,5. Check it before you sign.`);
  });

  it('shows what is about to be signed with that phone’s comma', async () => {
    await openChecklist();
    await type('meter', '4260,5');
    await press('all-ok');
    await type('fuel-gallons', '12,5');
    await press('review-sign');
    expect(shown()).toContain(`Equipment hours 4${NBSP}260,5, 12,5 gallons added`);
  });

  it('is as before on a phone that writes a point', async () => {
    mockSeparator = '.';
    await openChecklist();
    expect(box('meter').props.value).toBe('4250.5');
    expect(shown()).toContain('Last reading 4,250.5 hrs');
    await type('meter', '4000.5');
    expect(shown()).toContain('That is lower than the last reading of 4,250.5. Check it before you sign.');
    await type('meter', '4260.5');
    await press('all-ok');
    await type('fuel-gallons', '12.5');
    await press('review-sign');
    expect(shown()).toContain('Equipment hours 4,260.5, 12.5 gallons added');
  });
});

describe('ending use of a unit', () => {
  const openEndUse = () => show(screen(EndUseScreen, 'EndUse', { logId: USE.id }));

  it('shows the reading it started at, and the hours of this use, with a phone’s comma', async () => {
    await openEndUse();
    expect(shown()).toContain(`equipment hours 4${NBSP}250,5 at the start`);
    expect(box('end-meter').props.placeholder).toBe(`4${NBSP}250,5`);
    expect(shown()).toContain(`Started at 4${NBSP}250,5`);
    await type('end-meter', '4300,5');
    expect(shown()).toContain('50,0 hrs this use');
    expect(shown()).not.toContain('4,250.5');
  });

  it('is as before on a phone that writes a point', async () => {
    mockSeparator = '.';
    await openEndUse();
    expect(shown()).toContain('equipment hours 4,250.5 at the start');
    expect(box('end-meter').props.placeholder).toBe('4,250.5');
    expect(shown()).toContain('Started at 4,250.5');
    await type('end-meter', '4300.5');
    expect(shown()).toContain('50.0 hrs this use');
  });
});

describe('a maintenance request on a unit', () => {
  const openForm = () => show(screen(MrfFormScreen, 'MrfForm', { equipmentId: L5.id }));

  it('shows the unit’s reading as the box has it, on a phone that writes a comma', async () => {
    await openForm();
    expect(box('mrf-meter').props.value).toBe('4250,5');
    expect(shown()).toContain(`4${NBSP}250,5`);
    expect(shown()).not.toContain('4,250.5');
  });

  it('is as before on a phone that writes a point', async () => {
    mockSeparator = '.';
    await openForm();
    expect(box('mrf-meter').props.value).toBe('4250.5');
    expect(shown()).toContain('4,250.5');
  });
});
