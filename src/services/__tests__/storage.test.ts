/**
 * Where the web build keeps what is saved (storage.ts): in the browser's storage, through AsyncStorage. The store's
 * records are held as a phone holds them (recordGuard.ts): nothing is written over them, and nothing removes them,
 * until the store has read them, so records that could not be read are never saved over by an empty app. A browser
 * that will not let the app at its storage at all (a locked-down frame, some private windows) keeps them in memory
 * for the session, and the store knows it (`recordsInMemory`), so a build that keeps real records can say so. A save
 * the browser turns down (its storage is full) is said, and so is the next one that works.
 *
 * The browser is made up here: its storage is a map.
 */
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
}

const browser = (rows = new Map<string, string>()): Browser => ({ rows });

/** Load a module as the web build loads it, in this browser. */
function inBrowser<T>(b: Browser, load: () => T): T {
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
      b.rows.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      refuse();
      b.rows.delete(key);
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
    loaded = load();
  });
  return loaded!;
}

const webStorage = (b: Browser) => inBrowser(b, () => require('../storage.ts') as Storage);

/** A store build's store, in this browser: it holds nobody made up and names nobody. */
function webStore(b: Browser): UseStore {
  const saved = { ...process.env };
  for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
  Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });
  try {
    return inBrowser(b, () => (require('../../store/useStore') as { useStore: UseStore }).useStore);
  } finally {
    process.env = saved;
  }
}

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
