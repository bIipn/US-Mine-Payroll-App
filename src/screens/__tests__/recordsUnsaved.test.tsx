// When a save of the records cannot be written to the phone (a full phone, say), the app says so over every screen
// until a save works, and tries again by itself meanwhile (the store's recordsUnsaved; what is kept on the phone
// meanwhile is storage.native.test.ts's). When the phone shut off while saving and opened on an older copy of the
// records, the app says so once, over every screen, until the person taps OK (the store's shutOffWhileSaving).
// The app's screens are a stand-in here, and so is everything it starts.
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
const AsyncStorage = require('@react-native-async-storage/async-storage') as { setItem: jest.Mock };
const App = (require('../../../App') as { default: React.ComponentType }).default;
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const { SAVE_AGAIN_MS } = require('../../components/RecordsNotSaved') as typeof import('../../components/RecordsNotSaved');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TITLE = 'Records could not be saved on this phone';
const BODY = 'Free up space on the phone, then keep the app open until this message goes away.';

/** Let every save and read under way finish. */
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const SHUT_OFF = 'This phone shut off while saving';

let root: Root | null = null;
const { saveRecordsAgain, settings } = useStore.getState();
beforeAll(async () => {
  // The store reads what is saved (nothing, here), and from then on its saves are written.
  await flush();
  expect(useStore.getState().hydrated).toBe(true);
});
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  jest.useRealTimers();
  useStore.setState({ recordsUnsaved: false, shutOffWhileSaving: false, saveRecordsAgain, settings });
});

async function opened() {
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(App)));
}
const shown = () => JSON.stringify(root!.container.toJSON());

it('says over the app that the records could not be saved, and stops once a save works', async () => {
  await opened();
  expect(shown()).toContain('The app');
  expect(shown()).not.toContain(TITLE);

  const full = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('database or disk is full'));
  try {
    await act(async () => {
      useStore.setState({ mrfSeq: 5 });
      await flush();
    });
    expect(useStore.getState().recordsUnsaved).toBe(true);
    expect(shown()).toContain(TITLE);
    expect(shown()).toContain(BODY);
    // The app is still there under it.
    expect(shown()).toContain('The app');
  } finally {
    full.mockRestore();
  }

  await act(async () => {
    useStore.getState().saveRecordsAgain();
    await flush();
  });
  expect(useStore.getState().recordsUnsaved).toBe(false);
  expect(shown()).not.toContain(TITLE);
});

it('tries again by itself while it says so, and stops once a save works', async () => {
  // Not setImmediate: React Native's StatusBar keeps the last one it set in a static field, and a fake one handed to
  // the real clearImmediate by the next test throws off Node's count of immediates, which then never run (Jest hangs).
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'clearImmediate'] });
  const again = jest.fn();
  useStore.setState({ recordsUnsaved: true, saveRecordsAgain: again });
  await opened();
  expect(shown()).toContain(TITLE);
  await act(async () => {
    jest.advanceTimersByTime(SAVE_AGAIN_MS);
  });
  expect(again).toHaveBeenCalledTimes(1);
  await act(async () => {
    jest.advanceTimersByTime(SAVE_AGAIN_MS);
  });
  expect(again).toHaveBeenCalledTimes(2);

  await act(async () => {
    useStore.setState({ recordsUnsaved: false });
  });
  await act(async () => {
    jest.advanceTimersByTime(SAVE_AGAIN_MS * 3);
  });
  expect(again).toHaveBeenCalledTimes(2);
  expect(shown()).not.toContain(TITLE);
});

/** What a tap on the button with this testID does. */
function tap(testID: string): () => void {
  const found = root!.container.queryAll((n) => n.props.testID === testID)[0];
  if (!found) throw new Error(`No ${testID} here.`);
  let fiber = found.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  return fiber!.memoizedProps!.onPress as () => void;
}

describe('when the phone shut off while saving', () => {
  it('says so over the app, with what to check, until the person taps OK', async () => {
    useStore.setState({ shutOffWhileSaving: true });
    await opened();
    expect(shown()).toContain(SHUT_OFF);
    expect(shown()).toContain('The last few minutes of changes before that may not be on the phone.');
    expect(shown()).toContain('Check your last punch, checklist, exam or request, and enter again anything that is missing.');
    expect(shown()).toContain('A supervisor can correct the time of a punch.');
    expect(shown()).toContain('The app');

    await act(async () => tap('shut-off-ok')());
    expect(useStore.getState().shutOffWhileSaving).toBe(false);
    expect(shown()).not.toContain(SHUT_OFF);
    expect(shown()).toContain('The app');
  });

  it('says nothing of punches to a company that keeps no time', async () => {
    useStore.setState({ shutOffWhileSaving: true, settings: { ...settings, company: { ...settings.company, timeClock: false } } });
    await opened();
    expect(shown()).toContain(SHUT_OFF);
    expect(shown()).toContain('Check your last checklist, exam or request, and enter again anything that is missing.');
    expect(shown()).not.toContain('punch');
  });

  it('says nothing when it did not', async () => {
    await opened();
    expect(shown()).not.toContain(SHUT_OFF);
  });

  it('is said with a record that could not be saved, one under the other', async () => {
    useStore.setState({ shutOffWhileSaving: true, recordsUnsaved: true, saveRecordsAgain: jest.fn() });
    await opened();
    expect(shown()).toContain(TITLE);
    expect(shown()).toContain(SHUT_OFF);
    await act(async () => tap('shut-off-ok')());
    expect(shown()).toContain(TITLE);
    expect(shown()).not.toContain(SHUT_OFF);
  });
});
