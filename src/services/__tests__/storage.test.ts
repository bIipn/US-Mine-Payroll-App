/**
 * Where the web build keeps what is saved (storage.ts): in the browser's storage, through AsyncStorage. The store's
 * records are held as a phone holds them (recordGuard.ts): nothing is written over them, and nothing removes them,
 * until the store has read them, so records that could not be read are never saved over by an empty app. A browser
 * that will not let the app at its storage at all (a locked-down frame, some private windows) keeps them in memory
 * for the session, and the store knows it (`recordsInMemory`), so a build that keeps real records can say so. A save
 * the browser turns down (its storage is full) is said, and so is the next one that works.
 *
 * Every tab of MineMuster in a browser shares that storage, so one tab at a time saves the records (recordsTab.ts):
 * the one holding a Web Lock named for their key, or, with no Web Locks, every tab until another tab's save reaches
 * it. A tab that does not save them says so (`recordsElsewhere`), and Use this tab takes them (`takeRecordsHere`).
 *
 * The browser is made up here: its storage is a map that every tab shares, a save sends the other tabs a 'storage'
 * event, and its lock manager is src/testing/fakeLocks.ts.
 */
import { FakeLocks } from '../../testing/fakeLocks';

type Storage = typeof import('../storage');
type UseStore = typeof import('../../store/useStore')['useStore'];

const KEY = 'us-mine-crew-records';
const SESSION = 'minemuster-server-session';

interface Browser {
  rows: Map<string, string>;
  /** The browser will not let the app at its storage. */
  blocked?: boolean;
  /** The browser's storage is full: it turns every write down. */
  full?: boolean;
  /** A step of migrating what is saved fails. */
  migrateFails?: boolean;
  /** The browser's lock manager (navigator.locks). Left out, it has none, as a page served over plain http has none. */
  locks?: FakeLocks;
  /** The tabs open in it, by name, each with its 'storage' listeners: what it hears of another tab's save. */
  tabs: Map<string, Set<(event: { key: string | null }) => void>>;
}

const browser = (rows = new Map<string, string>(), locks?: FakeLocks): Browser => ({ rows, locks, tabs: new Map() });

/** A tab saved under `key`: every other tab hears of it, in a task of its own, as a browser sends the 'storage' event. */
function heard(b: Browser, by: string, key: string) {
  for (const [tab, listeners] of b.tabs) {
    if (tab === by) continue;
    setTimeout(() => {
      for (const listener of [...listeners]) listener({ key });
    }, 0);
  }
}

/** The tab closes: the lock it holds goes, and it hears nothing more. */
function close(b: Browser, tab: string) {
  b.locks?.close(tab);
  b.tabs.delete(tab);
}

/**
 * Load storage.ts as this tab of the browser has it: with its own window (its 'storage' listeners) and its own
 * navigator.locks, which storage.ts takes as it loads.
 */
function asTab(b: Browser, tab: string, load: () => void) {
  const listeners = new Set<(event: { key: string | null }) => void>();
  b.tabs.set(tab, listeners);
  const w = window as unknown as Record<string, unknown>;
  const before = { add: Object.getOwnPropertyDescriptor(w, 'addEventListener'), remove: Object.getOwnPropertyDescriptor(w, 'removeEventListener'), locks: Object.getOwnPropertyDescriptor(navigator, 'locks') };
  w.addEventListener = (type: string, listener: (event: { key: string | null }) => void) => {
    if (type === 'storage') listeners.add(listener);
  };
  w.removeEventListener = (type: string, listener: (event: { key: string | null }) => void) => {
    if (type === 'storage') listeners.delete(listener);
  };
  if (b.locks) Object.defineProperty(navigator, 'locks', { value: b.locks.client(tab), configurable: true });
  const put = (on: object, name: string, was: PropertyDescriptor | undefined) => {
    if (was) Object.defineProperty(on, name, was);
    else delete (on as Record<string, unknown>)[name];
  };
  try {
    load();
  } finally {
    put(w, 'addEventListener', before.add);
    put(w, 'removeEventListener', before.remove);
    put(navigator, 'locks', before.locks);
  }
}

/** Load a module as the web build loads it, in this tab of this browser. */
function inBrowser<T>(b: Browser, load: () => T, tab = 'tab'): T {
  const refuse = () => {
    if (b.blocked) throw new Error('SecurityError: The operation is insecure.');
  };
  const asyncStorage = {
    getItem: jest.fn(async (key: string) => {
      refuse();
      return b.rows.get(key) ?? null;
    }),
    setItem: jest.fn(async (key: string, value: string) => {
      refuse();
      if (b.full) throw new Error("QuotaExceededError: Failed to execute 'setItem' on 'Storage'");
      const was = b.rows.get(key);
      b.rows.set(key, value);
      // A browser sends the event only when what is saved changes.
      if (was !== value) heard(b, tab, key);
    }),
    removeItem: jest.fn(async (key: string) => {
      refuse();
      const was = b.rows.has(key);
      b.rows.delete(key);
      if (was) heard(b, tab, key);
    }),
  };
  let loaded: T | undefined;
  jest.isolateModules(() => {
    jest.doMock('@react-native-async-storage/async-storage', () => asyncStorage);
    // The store loads the web's storage, as the web build does (Jest loads a phone's by default).
    jest.doMock('../storage', () => jest.requireActual('../storage.ts'));
    jest.doMock('../../store/migrate', () => {
      const actual = jest.requireActual('../../store/migrate');
      return {
        ...actual,
        migratePersisted: (...args: unknown[]) => {
          if (b.migrateFails) throw new Error('A step of the migration failed');
          return actual.migratePersisted(...args);
        },
      };
    });
    // The web's storage takes this tab's window and navigator.locks as it loads; nothing else is given them.
    asTab(b, tab, () => require('../storage.ts'));
    loaded = load();
  });
  return loaded!;
}

const webStorage = (b: Browser) => inBrowser(b, () => require('../storage.ts') as Storage);

/** Loads as a store build does: it holds nobody made up and names nobody. */
function storeBuild<T>(load: () => T): T {
  const saved = { ...process.env };
  for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
  Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });
  try {
    return load();
  } finally {
    process.env = saved;
  }
}

/** A store build's store, in this tab of this browser. */
function webStore(b: Browser, tab = 'tab'): UseStore {
  return storeBuild(() => inBrowser(b, () => (require('../../store/useStore') as { useStore: UseStore }).useStore, tab));
}

/** A reminder this tab of the browser is holding, to show while it is open (notifications.ts, the web's). */
type Waiting = Map<string, number>;

/**
 * A store build in this tab of this browser, as App.tsx starts it, with the tab's own reminders: the web's
 * notifications are timers of the tab's own, a stand-in here that holds what it is handed until it is taken off.
 */
function webApp(b: Browser, tab: string) {
  const waiting: Waiting = new Map();
  const timers = {
    cancelLocal: jest.fn(async (ids: string[]) => ids.forEach((id) => waiting.delete(id))),
    scheduleLocal: jest.fn(async (reminders: { id: string; at: number }[]) => reminders.forEach((r) => r.at > Date.now() && waiting.set(r.id, r.at))),
  };
  const { useStore, reminders } = storeBuild(() =>
    inBrowser(
      b,
      () => {
        jest.doMock('../notifications', () => timers);
        return { useStore: (require('../../store/useStore') as { useStore: UseStore }).useStore, reminders: require('../reminders') as typeof import('../reminders') };
      },
      tab,
    ),
  );
  /** What App.tsx does once the records are read: the reminders as they have them, and watching from then on. */
  const opened = () => {
    expect(useStore.getState().hydrated).toBe(true);
    useStore.getState().ensureSeeded();
    void reminders.syncReminders();
    return reminders.watchReminders();
  };
  return { useStore, reminders, waiting, opened };
}

/** What the browser has saved of the records. */
const saved = (b: Browser) => JSON.parse(b.rows.get(KEY)!).state as { mrfSeq: number };

/** Let every save and read under way finish. */
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A browser that has been in use: its records saved, with something of its own in them. */
async function usedBrowser() {
  const b = browser();
  const store = webStore(b);
  await flush();
  expect(store.getState().hydrated).toBe(true);
  store.setState({ mrfSeq: 41 });
  await flush();
  const good = b.rows.get(KEY)!;
  expect(JSON.parse(good).state.mrfSeq).toBe(41);
  return { b, good };
}

describe('the web storage', () => {
  it('writes nothing over the records, and removes nothing, until the store has read them', async () => {
    const b = browser(new Map([[KEY, 'saved']]));
    const web = webStorage(b);
    await web.recordStorage.setItem(KEY, 'empty');
    await web.recordStorage.removeItem(KEY);
    expect(b.rows.get(KEY)).toBe('saved');
    expect(await web.recordStorage.getItem(KEY)).toBe('saved');
    web.recordsRead(KEY);
    await web.recordStorage.setItem(KEY, 'saved and more');
    expect(b.rows.get(KEY)).toBe('saved and more');
  });

  it('a browser that will not let the app at its storage keeps the records in memory for the session, and says so', async () => {
    const b: Browser = { ...browser(), blocked: true };
    const web = webStorage(b);
    const said: boolean[] = [];
    web.watchUnsaved((unsaved) => said.push(unsaved));
    expect(web.keptInMemory(KEY)).toBe(false);
    expect(await web.recordStorage.getItem(KEY)).toBeNull();
    web.recordsRead(KEY);
    await web.recordStorage.setItem(KEY, 'this session');
    expect(await web.recordStorage.getItem(KEY)).toBe('this session');
    // Nothing could ever have been saved there, so no save is said to have failed: that they are only in memory is.
    expect(said).toEqual([]);
    expect(web.keptInMemory(KEY)).toBe(true);
    expect(web.keptInMemory('another-key')).toBe(false);
  });

  it('a browser that lets the app at its storage keeps the records there, not in memory', async () => {
    const b = browser(new Map([[KEY, 'saved']]));
    const web = webStorage(b);
    expect(await web.recordStorage.getItem(KEY)).toBe('saved');
    web.recordsRead(KEY);
    b.full = true;
    await web.recordStorage.setItem(KEY, 'more');
    // A full storage is a save turned down, not records kept in memory for good.
    expect(web.keptInMemory(KEY)).toBe(false);
  });

  it('a save the browser turns down is said once, read back meanwhile, and the next save that works says so', async () => {
    const b = browser(new Map([[KEY, 'saved']]));
    const web = webStorage(b);
    const said: boolean[] = [];
    web.watchUnsaved((unsaved) => said.push(unsaved));
    expect(await web.recordStorage.getItem(KEY)).toBe('saved');
    web.recordsRead(KEY);
    b.full = true;
    await web.recordStorage.setItem(KEY, 'more');
    await web.recordStorage.setItem(KEY, 'more again');
    expect(said).toEqual([true]);
    expect(b.rows.get(KEY)).toBe('saved');
    expect(await web.recordStorage.getItem(KEY)).toBe('more again');
    b.full = false;
    await web.recordStorage.setItem(KEY, 'all of it');
    expect(said).toEqual([true, false]);
    expect(b.rows.get(KEY)).toBe('all of it');
  });

  it('keeps everything else where it always has, the server session among it', async () => {
    const b = browser();
    const web = webStorage(b);
    await web.safeStorage.setItem(SESSION, 'tokens');
    expect(b.rows.get(SESSION)).toBe('tokens');
    expect(await web.safeStorage.getItem(SESSION)).toBe('tokens');
  });
});

describe('the store on the web, when the records cannot be read', () => {
  it('records that do not make sense: says so, writes nothing over them, and reads them once they do', async () => {
    const { b, good } = await usedBrowser();
    const broken = '{"state": {"mrfSeq": 41, "shifts": [';
    b.rows.set(KEY, broken);

    const store = webStore(b);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(store.getState().hydrated).toBe(false);
    // Whatever the app does meanwhile is not written over them.
    store.getState().showToast('Anything');
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(b.rows.get(KEY)).toBe(broken);

    // Try again, while they still do not make sense: the same.
    await store.getState().readRecordsAgain();
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(b.rows.get(KEY)).toBe(broken);

    // And once they do.
    b.rows.set(KEY, good);
    await store.getState().readRecordsAgain();
    await flush();
    expect(store.getState().recordsUnreadable).toBe(false);
    expect(store.getState().hydrated).toBe(true);
    expect(store.getState().mrfSeq).toBe(41);
    // From then on its saves are written.
    store.setState({ mrfSeq: 42 });
    await flush();
    expect(JSON.parse(b.rows.get(KEY)!).state.mrfSeq).toBe(42);
  });

  it('records a migration cannot bring up to date: says so, writes nothing over them, and reads them once it can', async () => {
    const { b, good } = await usedBrowser();
    const { STATE_VERSION } = jest.requireActual('../../store/migrate') as typeof import('../../store/migrate');
    const older = JSON.stringify({ ...JSON.parse(good), version: STATE_VERSION - 1 });
    b.rows.set(KEY, older);
    b.migrateFails = true;

    const store = webStore(b);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(store.getState().hydrated).toBe(false);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(b.rows.get(KEY)).toBe(older);

    b.migrateFails = false;
    await store.getState().readRecordsAgain();
    await flush();
    expect(store.getState().recordsUnreadable).toBe(false);
    expect(store.getState().hydrated).toBe(true);
    expect(store.getState().mrfSeq).toBe(41);
    expect(JSON.parse(b.rows.get(KEY)!).version).toBe(STATE_VERSION);
  });

  it('a browser that will not let the app at its storage opens from memory, and the store knows they are only there', async () => {
    const b: Browser = { ...browser(), blocked: true };
    const store = webStore(b);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(false);
    expect(store.getState().hydrated).toBe(true);
    // Said over every screen in a build that keeps real records (RecordsNotSavedFrame): they go when the tab closes.
    expect(store.getState().recordsInMemory).toBe(true);
    store.setState({ mrfSeq: 3 });
    await flush();
    expect(store.getState().recordsUnsaved).toBe(false);
    expect(store.getState().recordsInMemory).toBe(true);
  });

  it('a browser that keeps them says nothing of memory', async () => {
    const { b } = await usedBrowser();
    const store = webStore(b);
    await flush();
    expect(store.getState().hydrated).toBe(true);
    expect(store.getState().recordsInMemory).toBe(false);
  });
});

describe('the store on the web, when a save is turned down', () => {
  it('says so, and stops saying so once a save works', async () => {
    const { b } = await usedBrowser();
    const store = webStore(b);
    await flush();
    b.full = true;
    store.setState({ mrfSeq: 42 });
    await flush();
    expect(store.getState().recordsUnsaved).toBe(true);
    expect(JSON.parse(b.rows.get(KEY)!).state.mrfSeq).toBe(41);
    b.full = false;
    store.getState().saveRecordsAgain();
    await flush();
    expect(store.getState().recordsUnsaved).toBe(false);
    expect(JSON.parse(b.rows.get(KEY)!).state.mrfSeq).toBe(42);
  });
});

describe('two tabs of one browser', () => {
  describe('with Web Locks', () => {
    it('the tab opened first saves the records; one opened while it is open saves nothing, and says so', async () => {
      const b = browser(new Map(), new FakeLocks());
      const first = webStore(b, 'first');
      await flush();
      expect(first.getState().hydrated).toBe(true);
      expect(first.getState().recordsElsewhere).toBe(false);
      expect(b.locks!.holder(KEY)).toBe('first');
      first.setState({ mrfSeq: 41 });
      await flush();
      expect(saved(b).mrfSeq).toBe(41);

      const second = webStore(b, 'second');
      await flush();
      expect(second.getState().hydrated).toBe(true);
      expect(second.getState().mrfSeq).toBe(41);
      // Said over every screen (RecordsNotSavedFrame), and nothing done in it is written over the first tab's.
      expect(second.getState().recordsElsewhere).toBe(true);
      second.setState({ mrfSeq: 7 });
      await flush();
      expect(saved(b).mrfSeq).toBe(41);
      first.setState({ mrfSeq: 42 });
      await flush();
      expect(saved(b).mrfSeq).toBe(42);
      expect(first.getState().recordsElsewhere).toBe(false);
    });

    it('Use this tab reads the records again and saves them; the tab they were taken from saves nothing more, and says so', async () => {
      const b = browser(new Map(), new FakeLocks());
      const first = webStore(b, 'first');
      await flush();
      const second = webStore(b, 'second');
      await flush();
      first.setState({ mrfSeq: 42 });
      second.setState({ mrfSeq: 7 });
      await flush();

      await second.getState().takeRecordsHere();
      await flush();
      expect(second.getState().recordsElsewhere).toBe(false);
      // What the first tab saved, read again; what was done here meanwhile was not saved, as the tab said.
      expect(second.getState().mrfSeq).toBe(42);
      expect(first.getState().recordsElsewhere).toBe(true);
      second.setState({ mrfSeq: 43 });
      await flush();
      expect(saved(b).mrfSeq).toBe(43);
      first.setState({ mrfSeq: 99 });
      await flush();
      expect(saved(b).mrfSeq).toBe(43);

      // And back again.
      await first.getState().takeRecordsHere();
      await flush();
      expect(first.getState().recordsElsewhere).toBe(false);
      expect(first.getState().mrfSeq).toBe(43);
      expect(second.getState().recordsElsewhere).toBe(true);
    });

    it('when the tab that saves them closes, the one left has them by itself, and reads them first', async () => {
      const b = browser(new Map(), new FakeLocks());
      const first = webStore(b, 'first');
      await flush();
      const second = webStore(b, 'second');
      await flush();
      first.setState({ mrfSeq: 50 });
      second.setState({ mrfSeq: 7 });
      await flush();

      close(b, 'first');
      await flush();
      expect(second.getState().recordsElsewhere).toBe(false);
      expect(second.getState().mrfSeq).toBe(50);
      second.setState({ mrfSeq: 51 });
      await flush();
      expect(saved(b).mrfSeq).toBe(51);
    });

    it('a browser that will not let the app at its storage: each tab keeps its own in memory, as before', async () => {
      const b: Browser = { ...browser(new Map(), new FakeLocks()), blocked: true };
      const first = webStore(b, 'first');
      await flush();
      const second = webStore(b, 'second');
      await flush();
      for (const tab of [first, second]) {
        expect(tab.getState().hydrated).toBe(true);
        expect(tab.getState().recordsInMemory).toBe(true);
        expect(tab.getState().recordsElsewhere).toBe(false);
      }
      second.setState({ mrfSeq: 3 });
      await flush();
      expect(second.getState().recordsUnsaved).toBe(false);
      // Nothing is shared, so no tab holds on to the lock.
      expect(b.locks!.holder(KEY)).toBeNull();
    });
  });

  describe('with no Web Locks', () => {
    it('a punch in the tab opened later is not written over by the tab opened earlier: that tab saves nothing more, and says so', async () => {
      const b = browser();
      const earlier = webStore(b, 'earlier');
      await flush();
      const later = webStore(b, 'later');
      await flush();
      expect(earlier.getState().recordsElsewhere).toBe(false);
      expect(later.getState().recordsElsewhere).toBe(false);

      later.setState({ mrfSeq: 41 });
      await flush();
      expect(saved(b).mrfSeq).toBe(41);
      expect(earlier.getState().recordsElsewhere).toBe(true);
      earlier.setState({ mrfSeq: 7 });
      await flush();
      expect(saved(b).mrfSeq).toBe(41);

      // Use this tab, in the earlier one: it reads them again, then saves, and the later one hears of it.
      await earlier.getState().takeRecordsHere();
      await flush();
      expect(earlier.getState().recordsElsewhere).toBe(false);
      expect(earlier.getState().mrfSeq).toBe(41);
      earlier.setState({ mrfSeq: 43 });
      await flush();
      expect(saved(b).mrfSeq).toBe(43);
      expect(later.getState().recordsElsewhere).toBe(true);
      later.setState({ mrfSeq: 99 });
      await flush();
      expect(saved(b).mrfSeq).toBe(43);
    });
  });
});

/**
 * The reminders go with the records: only the tab that saves them sets reminders. Another tab's store has what was
 * saved when it read them, which the tab that saves them changes from then on, so reminders set from it would be wrong
 * as soon as anything is punched there: Start lunch now while the person is at lunch, and no Lunch is over once it
 * has the records. Played with each tab's reminders (reminders.ts) as App.tsx starts them, and its notifications a
 * stand-in for the web's timers.
 */
describe('the reminders, in two tabs of one browser', () => {
  const HOUR = 3_600_000;
  const DEADLINE_IDS = ['lunch-60', 'lunch-30', 'lunch-15', 'lunch-0'];
  /** Lee, signed in, clocked in an hour ago on a California shift: what the tab that saves the records has. */
  const clockedIn = (useStore: UseStore) => {
    const now = Date.now();
    const { settings } = useStore.getState();
    useStore.setState({
      employees: [{ id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true }],
      accounts: [{ id: 'acct-lee', employeeId: 'emp-lee', email: '', provider: 'company', createdAt: 1 }],
      session: { accountId: 'acct-lee', employeeId: 'emp-lee' },
      shifts: [{ id: 'sh-lee', employeeId: 'emp-lee', clockIn: { at: now - HOUR, noLocation: 'off' }, lunches: [], breaks: [] }],
      settings: { ...settings, lunchReminders: true, company: { ...settings.company, name: 'Test Pit A', state: 'CA', pay: null, timeClock: undefined } },
    });
  };
  /** Lunch starts at `at`, and ends by itself 30 minutes later. */
  const atLunch = (useStore: UseStore, at: number) =>
    useStore.setState({ shifts: useStore.getState().shifts.map((s) => ({ ...s, lunches: [{ start: { at, noLocation: 'off' as const }, end: { at: at + 30 * 60_000, auto: true as const } }] })) });

  it('a tab opened beside the one that saves them sets none, and Use this tab sets them from what it reads', async () => {
    const b = browser(new Map(), new FakeLocks());
    const first = webApp(b, 'first');
    await flush();
    const stops = [first.opened()];
    clockedIn(first.useStore);
    await first.reminders.syncReminders();
    await flush();
    expect([...first.waiting.keys()]).toEqual(DEADLINE_IDS);

    // A second tab: it reads what the first saved, and saves nothing. It sets no reminders, opening or coming back to
    // the front.
    const second = webApp(b, 'second');
    await flush();
    stops.push(second.opened());
    await flush();
    expect(second.useStore.getState().recordsElsewhere).toBe(true);
    expect(second.useStore.getState().session).toEqual({ accountId: 'acct-lee', employeeId: 'emp-lee' });
    await second.reminders.handOverWaiting();
    expect([...second.waiting.keys()]).toEqual([]);

    // Lunch starts in the first tab: its deadline reminders come off, and the notice that lunch is over is set.
    const lunchAt = Date.now();
    atLunch(first.useStore, lunchAt);
    await first.reminders.syncReminders();
    await flush();
    expect([...first.waiting.keys()]).toEqual(['lunch-end']);
    expect([...second.waiting.keys()]).toEqual([]);

    // Use this tab, in the second: it reads the records again and sets the notice from them. The first, which saves
    // nothing more, takes its own off. Then the first closes, and the notice is still set.
    await second.useStore.getState().takeRecordsHere();
    await flush();
    expect(first.useStore.getState().recordsElsewhere).toBe(true);
    expect([...first.waiting]).toEqual([]);
    expect([...second.waiting]).toEqual([['lunch-end', lunchAt + 30 * 60_000]]);
    close(b, 'first');
    await flush();
    expect([...second.waiting]).toEqual([['lunch-end', lunchAt + 30 * 60_000]]);
    stops.forEach((stop) => stop());
  });

  it('the tab left when the one that saves them closes sets them from what it reads', async () => {
    const b = browser(new Map(), new FakeLocks());
    const first = webApp(b, 'first');
    await flush();
    const stops = [first.opened()];
    clockedIn(first.useStore);
    const second = webApp(b, 'second');
    await flush();
    stops.push(second.opened());
    const lunchAt = Date.now();
    atLunch(first.useStore, lunchAt);
    await first.reminders.syncReminders();
    await flush();
    expect([...second.waiting]).toEqual([]);

    close(b, 'first');
    await flush();
    expect(second.useStore.getState().recordsElsewhere).toBe(false);
    expect([...second.waiting]).toEqual([['lunch-end', lunchAt + 30 * 60_000]]);
    stops.forEach((stop) => stop());
  });
});
