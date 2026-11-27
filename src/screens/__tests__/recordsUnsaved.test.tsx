// When a save of the records cannot be written to the phone (a full phone, say), the app says so over every screen
// until a save works, and tries again by itself meanwhile (the store's recordsUnsaved; what is kept on the phone
// meanwhile is storage.native.test.ts's). When the phone shut off while saving and opened on an older copy of the
// records, the app says so once, over every screen, until the person taps OK (the store's shutOffWhileSaving).
// In a browser the words are a browser's, and a browser that will not let the app at its storage at all, so the
// records are only in memory, is said over every screen too (the store's recordsInMemory), but not in the preview.
// And while another tab of the browser saves the records, so this one saves nothing, that is said in place of every
// screen until the person uses this tab instead (the store's recordsElsewhere; storage.test.ts has the tabs).
// The app's screens are a stand-in here, and so is everything it starts.
const mockText = (words: string) => () => require('react').createElement(require('react-native').Text, null, words);
jest.mock('../../navigation/RootNavigator', () => ({ RootNavigator: mockText('The app') }));
jest.mock('../../services/connection', () => ({ watchConnection: () => () => undefined }));
jest.mock('../../services/reminders', () => ({ syncReminders: async () => undefined, watchReminders: () => () => undefined }));
// How many times the app has started sending to the company, and stopped.
const mockSync = { started: 0, stopped: 0 };
jest.mock('../../services/sync', () => {
  const { create } = require('zustand');
  return {
    startSync: () => {
      mockSync.started += 1;
      return () => {
        mockSync.stopped += 1;
      };
    },
    useSyncStatus: create(() => ({ online: true, server: null, waiting: 0 })),
  };
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
// What build this is, as config.ts says: the preview (DEMO_MODE) or one that keeps real records, and one that sends
// to a company server (SERVER) or not. A test that cares says which; the others run as the build Jest makes.
let mockBuild: { preview?: boolean; server?: boolean } = {};
jest.mock('../../config', () => {
  const actual = jest.requireActual('../../config');
  const build = { ...actual, __esModule: true };
  Object.defineProperty(build, 'DEMO_MODE', { enumerable: true, get: () => mockBuild.preview ?? actual.DEMO_MODE });
  Object.defineProperty(build, 'SERVER', {
    enumerable: true,
    get: () => (mockBuild.server === undefined ? actual.SERVER : mockBuild.server ? { url: 'https://example.supabase.co', key: 'sb_publishable_example' } : null),
  });
  return build;
});

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
const { Platform } = require('react-native') as typeof import('react-native');
const { SAVE_AGAIN_SLOWLY_MS } = require('../../components/RecordsNotSaved') as typeof import('../../components/RecordsNotSaved');

/** Let every save and read under way finish. */
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const SHUT_OFF = 'This phone shut off while saving';

let root: Root | null = null;
const { saveRecordsAgain, settings, takeRecordsHere } = useStore.getState();
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
  mockBuild = {};
  useStore.setState({ recordsUnsaved: false, shutOffWhileSaving: false, deletionNotFinished: false, recordsInMemory: false, recordsElsewhere: false, saveRecordsAgain, settings, takeRecordsHere });
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

it('on a phone, keeps trying every 15 seconds, since freeing space on the phone makes room', async () => {
  const os = jest.replaceProperty(Platform, 'OS', 'android');
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'clearImmediate'] });
  try {
    const again = jest.fn();
    useStore.setState({ recordsUnsaved: true, saveRecordsAgain: again });
    await opened();
    for (let tries = 1; tries <= 8; tries++) {
      await act(async () => {
        jest.advanceTimersByTime(SAVE_AGAIN_MS);
      });
      expect(again).toHaveBeenCalledTimes(tries);
    }
  } finally {
    os.restore();
  }
});

describe('in a browser', () => {
  const FULL = 'This browser has no more room for MineMuster’s records';
  let os: { restore(): void } | null = null;
  beforeEach(() => {
    os = jest.replaceProperty(Platform, 'OS', 'web');
  });
  afterEach(() => {
    os?.restore();
    os = null;
  });

  it('a save turned down says the browser has no room, that what is done now lasts while the tab is open, and to tell a supervisor', async () => {
    // A browser's room for a site is fixed, whatever room the computer has: freeing space on it changes nothing.
    mockBuild = { server: true };
    useStore.setState({ recordsUnsaved: true, saveRecordsAgain: jest.fn() });
    await opened();
    expect(shown()).toContain(FULL);
    expect(shown()).toContain('What you do now is kept only while this tab stays open. Records already sent to your company are safe. Tell your supervisor.');
    expect(shown()).not.toContain(TITLE);
    expect(shown()).not.toContain('Free up space');
    expect(shown()).toContain('The app');
  });

  it('says nothing of records sent in a build that sends none', async () => {
    mockBuild = { server: false };
    useStore.setState({ recordsUnsaved: true, saveRecordsAgain: jest.fn() });
    await opened();
    expect(shown()).toContain(FULL);
    expect(shown()).toContain('What you do now is kept only while this tab stays open. Tell your supervisor.');
    expect(shown()).not.toContain('sent');
  });

  it('tries again three times, 15 seconds apart, then every five minutes, and quickly again once a save has worked', async () => {
    // Each try writes all the records, and a full browser turns every one down: not every 15 seconds for nothing.
    // A change in the app still saves at once, as it always does.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'clearImmediate'] });
    const again = jest.fn();
    useStore.setState({ recordsUnsaved: true, saveRecordsAgain: again });
    await opened();
    for (let tries = 1; tries <= 3; tries++) {
      await act(async () => {
        jest.advanceTimersByTime(SAVE_AGAIN_MS);
      });
      expect(again).toHaveBeenCalledTimes(tries);
    }
    await act(async () => {
      jest.advanceTimersByTime(SAVE_AGAIN_SLOWLY_MS - 1);
    });
    expect(again).toHaveBeenCalledTimes(3);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(again).toHaveBeenCalledTimes(4);
    await act(async () => {
      jest.advanceTimersByTime(SAVE_AGAIN_SLOWLY_MS);
    });
    expect(again).toHaveBeenCalledTimes(5);

    // A save works, and later one is turned down again: three quick tries again, as from the start.
    await act(async () => {
      useStore.setState({ recordsUnsaved: false });
    });
    await act(async () => {
      jest.advanceTimersByTime(SAVE_AGAIN_SLOWLY_MS * 2);
    });
    expect(again).toHaveBeenCalledTimes(5);
    await act(async () => {
      useStore.setState({ recordsUnsaved: true });
    });
    await act(async () => {
      jest.advanceTimersByTime(SAVE_AGAIN_MS);
    });
    expect(again).toHaveBeenCalledTimes(6);
  });

  describe('that will not let the app at its storage, so the records are only in memory', () => {
    const IN_MEMORY = 'This browser is not keeping MineMuster’s records';

    it('says so over the app in a build that keeps real records, with what to do', async () => {
      mockBuild = { preview: false, server: true };
      useStore.setState({ recordsInMemory: true });
      await opened();
      expect(shown()).toContain(IN_MEMORY);
      expect(shown()).toContain(
        'What you do here is lost when this tab closes, unless it has been sent to your company. Use the app on your phone, or allow this site to store data.',
      );
      expect(shown()).toContain('The app');
      // Nothing is waiting to be saved: there is nowhere to save it, which is what is said.
      expect(shown()).not.toContain(FULL);
    });

    it('speaks of nothing sent in a build that sends none', async () => {
      mockBuild = { preview: false, server: false };
      useStore.setState({ recordsInMemory: true });
      await opened();
      expect(shown()).toContain(IN_MEMORY);
      expect(shown()).toContain('What you do here is lost when this tab closes. Use the app on your phone, or allow this site to store data.');
      expect(shown()).not.toContain('sent');
    });

    it('says nothing in the preview, which runs from memory inside a frame', async () => {
      mockBuild = { preview: true };
      useStore.setState({ recordsInMemory: true });
      await opened();
      expect(shown()).not.toContain(IN_MEMORY);
      expect(shown()).toContain('The app');
    });

    it('says nothing when the browser keeps them', async () => {
      mockBuild = { preview: false, server: true };
      await opened();
      expect(shown()).not.toContain(IN_MEMORY);
    });
  });
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

describe('when the phone shut off before an account deleted on it was off it for good, and it could not be deleted again by itself', () => {
  const BACK = 'A deleted account may be back on this phone';
  it('says so over the app, with what to do, until the person taps OK, beside the shut-off notice', async () => {
    useStore.setState({ deletionNotFinished: true, shutOffWhileSaving: true });
    await opened();
    expect(shown()).toContain(BACK);
    expect(shown()).toContain('The phone shut off before it finished deleting an account, so the account and its hourly rate may be on the phone again.');
    expect(shown()).toContain('Clock out if you are on the clock, then delete it again on More, Delete my account.');
    expect(shown()).toContain(SHUT_OFF);
    await act(async () => tap('deletion-not-finished-ok')());
    expect(useStore.getState().deletionNotFinished).toBe(false);
    expect(shown()).not.toContain(BACK);
    expect(shown()).toContain(SHUT_OFF);
    expect(shown()).toContain('The app');
  });

  it('says so on its own, with its OK, when the phone opened on what it saved last (no shut-off notice with it)', async () => {
    useStore.setState({ deletionNotFinished: true, shutOffWhileSaving: false });
    await opened();
    expect(shown()).toContain(BACK);
    expect(shown()).not.toContain(SHUT_OFF);
    expect(root!.container.queryAll((n) => n.props.testID === 'deletion-not-finished-ok').length).toBeGreaterThan(0);
    await act(async () => tap('deletion-not-finished-ok')());
    expect(useStore.getState().deletionNotFinished).toBe(false);
    expect(shown()).not.toContain(BACK);
    expect(shown()).toContain('The app');
  });

  it('stays once the shut-off notice beside it has been seen first', async () => {
    useStore.setState({ deletionNotFinished: true, shutOffWhileSaving: true });
    await opened();
    await act(async () => tap('shut-off-ok')());
    expect(useStore.getState().shutOffWhileSaving).toBe(false);
    expect(shown()).not.toContain(SHUT_OFF);
    expect(shown()).toContain(BACK);
    expect(useStore.getState().deletionNotFinished).toBe(true);
  });

  it('says nothing when there is none', async () => {
    await opened();
    expect(shown()).not.toContain(BACK);
  });
});

describe('while MineMuster is open in another tab, which saves the records', () => {
  const TITLE_ELSEWHERE = 'MineMuster is open in another tab';
  const { StyleSheet } = require('react-native') as typeof import('react-native');
  /** Whether the app under the notice is hidden: nothing in it can be seen, tapped or reached from the keyboard. */
  const appHidden = () => {
    const app = root!.container.queryAll((n) => n.props.testID === 'records-app')[0];
    if (!app) throw new Error('No app here.');
    return StyleSheet.flatten(app.props.style as import('react-native').StyleProp<import('react-native').ViewStyle>)?.display === 'none';
  };
  /** The Use this tab button: what a tap on it does, and whether it is turned off. */
  function useThisTab(): { onPress: () => void; off: boolean } {
    const found = root!.container.queryAll((n) => n.props.testID === 'use-this-tab')[0];
    if (!found) throw new Error('No Use this tab here.');
    let fiber = found.unstable_fiber as Fiber;
    while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
    const props = fiber!.memoizedProps!;
    const state = props.accessibilityState as { disabled?: boolean } | undefined;
    return { onPress: props.onPress as () => void, off: props.disabled === true || state?.disabled === true };
  }

  it('says so in place of the app, with what to do, and nothing in this tab can be changed meanwhile', async () => {
    useStore.setState({ recordsElsewhere: true });
    await opened();
    expect(shown()).toContain(TITLE_ELSEWHERE);
    expect(shown()).toContain('Only one tab at a time can save the records, so nothing is saved in this one. Use the other tab, or use this one instead.');
    expect(shown()).toContain('Use this tab');
    expect(appHidden()).toBe(true);
  });

  it('Use this tab takes the records, once at a time, and the app is back once they have been read again', async () => {
    let done: () => void = () => undefined;
    const take = jest.fn(() => new Promise<void>((resolve) => (done = resolve)));
    useStore.setState({ recordsElsewhere: true, takeRecordsHere: take });
    await opened();
    await act(async () => useThisTab().onPress());
    expect(take).toHaveBeenCalledTimes(1);
    expect(useThisTab().off).toBe(true);
    await act(async () => {
      useStore.setState({ recordsElsewhere: false });
      done();
    });
    expect(shown()).not.toContain(TITLE_ELSEWHERE);
    expect(appHidden()).toBe(false);
    expect(shown()).toContain('The app');
  });

  it('is not said while this tab saves them', async () => {
    await opened();
    expect(shown()).not.toContain(TITLE_ELSEWHERE);
    expect(appHidden()).toBe(false);
  });

  it('sends nothing from this tab meanwhile: what it has may be older, and the tab that saves the records sends them', async () => {
    mockSync.started = 0;
    mockSync.stopped = 0;
    useStore.setState({ recordsElsewhere: true });
    await opened();
    expect(mockSync.started).toBe(0);
    await act(async () => {
      useStore.setState({ recordsElsewhere: false });
    });
    expect(mockSync).toEqual({ started: 1, stopped: 0 });
    await act(async () => {
      useStore.setState({ recordsElsewhere: true });
    });
    expect(mockSync).toEqual({ started: 1, stopped: 1 });
  });

  it('is said in place of a notice that a save could not be written: there is none to make here', async () => {
    useStore.setState({ recordsElsewhere: true, recordsUnsaved: true, saveRecordsAgain: jest.fn() });
    await opened();
    expect(shown()).toContain(TITLE_ELSEWHERE);
    expect(shown()).not.toContain(TITLE);
  });
});
