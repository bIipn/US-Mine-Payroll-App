// When the records saved on this phone cannot be read as the app opens, the app says so in place of everything
// else, instead of opening as a new phone, and Try again reads them again (the store's recordsUnreadable; what
// is kept on the phone meanwhile is storage.native.test.ts's). The app itself is a stand-in here, and so is
// everything it starts once the records are read.
const mockText = (words: string) => () => require('react').createElement(require('react-native').Text, null, words);
jest.mock('../../navigation/RootNavigator', () => ({ RootNavigator: mockText('The app') }));
jest.mock('../../services/connection', () => ({ watchConnection: () => () => undefined }));
jest.mock('../../services/reminders', () => ({ syncReminders: async () => undefined }));
jest.mock('../../services/sync', () => {
  const { create } = require('zustand');
  return { startSync: () => () => undefined, useSyncStatus: create(() => ({ online: true, server: null, waiting: 0 })) };
});
jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));
jest.mock('@expo-google-fonts/barlow/500Medium', () => ({}));
jest.mock('@expo-google-fonts/barlow/600SemiBold', () => ({}));
jest.mock('@expo-google-fonts/barlow/700Bold', () => ({}));
jest.mock('@expo-google-fonts/barlow-condensed/600SemiBold', () => ({}));
jest.mock('@expo-google-fonts/barlow-condensed/700Bold', () => ({}));
// lucide's files are not transformed under Jest; any icon draws nothing here.
jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

type Fiber = { return: Fiber | null; memoizedProps?: Record<string, unknown> } | null;
type Node = { props: Record<string, unknown>; unstable_fiber: unknown };
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[]; toJSON(): unknown } };
const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const App = (require('../../../App') as { default: React.ComponentType }).default;
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
beforeAll(async () => {
  // The store reads what is saved (nothing, here) before each test sets what it found.
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
});
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

async function opened() {
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(App)));
}
const shown = () => JSON.stringify(root!.container.toJSON());
/** The Try again button: what a tap on it does, and whether it is turned off. */
function tryAgain(): { onPress: () => void; off: boolean } {
  const found = root!.container.queryAll((n) => n.props.testID === 'read-records-again')[0];
  if (!found) throw new Error('No Try again here.');
  let fiber = found.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  const props = fiber!.memoizedProps!;
  const state = props.accessibilityState as { disabled?: boolean } | undefined;
  return { onPress: props.onPress as () => void, off: props.disabled === true || state?.disabled === true };
}

it('says the records on the phone could not be read, in place of the app', async () => {
  useStore.setState({ hydrated: false, recordsUnreadable: true });
  await opened();
  expect(shown()).toContain('The records on this phone could not be read');
  expect(shown()).toContain('Nothing has been deleted');
  expect(shown()).not.toContain('The app');
});

it('opens the app once the records are read', async () => {
  useStore.setState({ hydrated: true, recordsUnreadable: false });
  await opened();
  expect(shown()).toContain('The app');
  expect(shown()).not.toContain('could not be read');
});

describe('what to do next', () => {
  const { Platform } = require('react-native') as typeof import('react-native');
  let os: { restore(): void } | null = null;
  afterEach(() => {
    os?.restore();
    os = null;
  });

  it('on the iPhone, says to close MineMuster and open it again, since Try again cannot find them there', async () => {
    // AsyncStorage on the iPhone forgets records it could not read until the app is opened again (storage.native.ts).
    os = jest.replaceProperty(Platform, 'OS', 'ios');
    useStore.setState({ hydrated: false, recordsUnreadable: true });
    await opened();
    expect(shown()).toContain('Swipe MineMuster away to close it, then open it again. If it still says this, ask your supervisor.');
    expect(shown()).not.toContain('Tap Try again');
  });

  it('on Android, says to tap Try again first', async () => {
    os = jest.replaceProperty(Platform, 'OS', 'android');
    useStore.setState({ hydrated: false, recordsUnreadable: true });
    await opened();
    expect(shown()).toContain('Tap Try again. If they still cannot be read, close MineMuster and open it again, then tell your supervisor.');
  });
});

it('reads them again on Try again, and can be tapped once at a time', async () => {
  let done: () => void = () => undefined;
  const readRecordsAgain = jest.fn(() => new Promise<void>((resolve) => (done = resolve)));
  useStore.setState({ hydrated: false, recordsUnreadable: true, readRecordsAgain });
  await opened();
  await act(async () => tryAgain().onPress());
  expect(readRecordsAgain).toHaveBeenCalledTimes(1);
  expect(tryAgain().off).toBe(true);
  await act(async () => done());
  expect(tryAgain().off).toBe(false);
});
