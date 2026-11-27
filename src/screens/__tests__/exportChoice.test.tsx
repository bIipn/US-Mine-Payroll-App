// Every export a supervisor makes on a phone (the week and the pay period in Excel, the payroll hours file,
// the safety log and the PDF for an MSHA inspector) hands the screen's own way of asking to the save, and the
// sheet that asks is on that screen: on Android it asks Open on this phone, Save to phone or Send to another
// app. The exports themselves are stand-ins here; they ask the way the phone's save does. Everything is made up.
jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, HAS_LOGO_ART: false }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: jest.fn() }),
  useRoute: () => ({ params: undefined }),
  useIsFocused: () => true,
}));
jest.mock('../../services/exportReport', () => {
  const asks = (_build: unknown, choose?: (ask: { name: string; canOpen: boolean }) => Promise<unknown>) =>
    choose ? choose({ name: 'made-up-export.file', canOpen: true }).then(() => undefined) : Promise.resolve();
  return { exportReport: jest.fn(asks), exportPdf: jest.fn(asks), exportCsv: jest.fn(asks), PDF_MIME: 'application/pdf' };
});

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
const exports = require('../../services/exportReport') as Record<'exportReport' | 'exportPdf' | 'exportCsv', jest.Mock>;
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const byId = (root: Root, id: string) => root.container.queryAll((n) => n.props.testID === id);
function text(json: Json | Json[]): string {
  if (json == null) return '';
  if (typeof json === 'string') return json;
  if (Array.isArray(json)) return json.map(text).join(' ');
  return (json.children ?? []).map(text).join(' ');
}
const shown = (root: Root) => text(root.container.toJSON());
function pressOf(n: Node): () => void {
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('Nothing to press here.');
  return fiber.memoizedProps!.onPress as () => void;
}
async function tap(root: Root, id: string) {
  const [node] = byId(root, id);
  if (!node) throw new Error(`No ${id} on the screen.`);
  await act(async () => pressOf(node)());
  for (let i = 0; i < 5; i += 1) await act(async () => undefined);
}

let root: Root | null = null;
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  for (const fn of [exports.exportReport, exports.exportPdf, exports.exportCsv]) fn.mockClear();
});

async function open(screen: 'SafetyLog' | 'Payroll' | 'TimeLogs') {
  useStore.getState().ensureSeeded();
  const mod =
    screen === 'SafetyLog'
      ? (require('../supervisor/SafetyLogScreen') as { SafetyLogScreen: React.ComponentType<object> }).SafetyLogScreen
      : screen === 'Payroll'
        ? (require('../supervisor/PayrollScreen') as { PayrollScreen: React.ComponentType<object> }).PayrollScreen
        : (require('../supervisor/TimeLogsScreen') as { TimeLogsScreen: React.ComponentType<object> }).TimeLogsScreen;
  const props = { navigation: { goBack: jest.fn(), navigate: jest.fn() }, route: { key: screen, name: screen } };
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(mod, props)));
  return r;
}

/** The export was handed the screen's way of asking, and the sheet it asks with is on the screen. */
async function asksOnTheScreen(r: Root, made: jest.Mock) {
  expect(made).toHaveBeenCalledTimes(1);
  expect(made.mock.calls[0]?.[1]).toEqual(expect.any(Function));
  expect(byId(r, 'file-choice')).not.toHaveLength(0);
  expect(shown(r)).toContain('made-up-export.file');
  await tap(r, 'file-share');
  expect(byId(r, 'file-choice')).toHaveLength(0);
}

it('asks on Checklists and exams, for the PDF for an MSHA inspector and the safety log', async () => {
  const r = await open('SafetyLog');
  await tap(r, 'export-inspector-pdf');
  await asksOnTheScreen(r, exports.exportPdf);
  await tap(r, 'export-safety');
  await asksOnTheScreen(r, exports.exportReport);
});

it('asks on Payroll, for the Excel file and the payroll hours file', async () => {
  const r = await open('Payroll');
  await tap(r, 'export-payroll');
  await asksOnTheScreen(r, exports.exportReport);
  await tap(r, 'export-hours-file');
  await tap(r, 'hours-file-period');
  await asksOnTheScreen(r, exports.exportCsv);
});

it('asks on the Time log, for the week in Excel', async () => {
  const r = await open('TimeLogs');
  await tap(r, 'export-week');
  await asksOnTheScreen(r, exports.exportReport);
});
