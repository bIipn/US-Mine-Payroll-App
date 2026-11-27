/**
 * Where the phone keeps what is saved on it (storage.native.ts). On Android the store's records are kept in a
 * file of their own: an Android AsyncStorage row over about 2 MB cannot be read back, and the records grow past
 * that in months. An older version's row is moved into the file the first time it is read, and removed at a later
 * start, once the file is read whole and has had time to reach the disk. On the iPhone the records stay where they
 * have always been. The server session stays in AsyncStorage on both. A read that fails never opens the phone as a
 * new one, and nothing is written over records that could not be read. A save that cannot be written is said, and
 * so is the next one that works.
 *
 * On Android a save cannot make what it writes reach the disk before the app goes on, so a power cut can tear what
 * was written in the last half a minute or so. A copy that is not whole JSON is passed over for the next newest, and
 * the file is kept aside now and then as a checkpoint, by a rename: at most once a minute, and an old one goes only
 * once a newer one has had two minutes to reach the disk, by a steady clock: the phone's own clock can jump. When a
 * newer copy was torn the phone says so. Emptying the phone, or taking one person's records off it, lets go of every
 * copy from before as soon as the save that did it has settled, and a restart or a power cut meanwhile never opens on
 * what was emptied.
 *
 * The phone is made up here: its files are a map, kept as expo-file-system keeps them on Android (a move over a
 * file deletes that file, then renames; a rename keeps what a file holds and when it was written), with the time
 * each was written by the phone's clock, and the true time, by the steady clock, which a power cut goes by; its
 * AsyncStorage rows are another map on Android. On the iPhone AsyncStorage is kept as RNCAsyncStorage keeps it
 * (ios/RNCAsyncStorage.mm): a manifest of every key on the disk, which holds a value of up to 1,024 characters
 * itself and marks a longer one as kept in a file of its own, named by the MD5 of its key, in
 * Library/Application Support/<bundle id>/RCTAsyncLocalStorage_V1; the manifest is read from the disk when the app
 * loads it and written back whole at a change of it, and a value whose file it cannot read is taken off the
 * manifest it holds.
 */
import { md5 } from '../../util/hash';

type Os = 'android' | 'ios';
type Storage = typeof import('../storage');
type UseStore = typeof import('../../store/useStore')['useStore'];

const FILES = 'file:///data/user/0/com.minemuster.app/files/';
const KEY = 'us-mine-crew-records';
const SESSION = 'minemuster-server-session';
/** On the iPhone, the mark that records are kept under KEY. */
const MARK = `${KEY}:on-this-phone`;
/** On the iPhone, the app's Library: Paths.cache is its Caches. */
const LIBRARY = 'file:///var/mobile/Containers/Data/Application/5D1A0F2E-0B7C-4C55-9E36-2A4F1B8C7D90/Library/';
/** On the iPhone, RNCAsyncStorage's folder (RCTCreateStorageDirectoryPath), under the app's bundle id. */
const ASYNC_FOLDER = `${LIBRARY}Application%20Support/com.minemuster.app/RCTAsyncLocalStorage_V1/`;
/** RNCAsyncStorage keeps a value of up to this many characters in its manifest (RCTInlineValueThreshold). */
const INLINE = 1024;
/** On the iPhone, the file RNCAsyncStorage keeps a longer value of `key` in (_filePathForKey). */
const valueFile = (key: string) => `${ASYNC_FOLDER}${md5(key)}`;
/** A file of the records, by its full address on the phone. */
const file = (end = '') => `${FILES}${KEY}.json${end}`;
/** A checkpoint of the records, by its place. */
const checkpoint = (order: number) => `${FILES}${KEY}.cp-${order}.json`;

/** The phone's clock at the start, the steady clock then (time since the phone started), and a minute on them. */
const T0 = 1_800_000_000_000;
const S0 = 7_000_000;
const MIN = 60_000;

interface Trouble {
  /** Files that cannot be read, by name. */
  unreadable?: Set<string>;
  /**
   * AsyncStorage rows that cannot be read, by key: as a row over 2 MB cannot on Android, and on the iPhone a value
   * kept in its own file, whose file cannot be read, by RNCAsyncStorage or the app. A value held in the manifest is
   * always read.
   */
  rowUnreadable?: Set<string>;
  /** What a write puts in a file, in place of what it was given. */
  writes?: (name: string, content: string) => string;
  /** The app is killed while it writes this file, halfway through. */
  killedInWrite?: (name: string) => boolean;
  /** The app is killed during this move, after the file it moves over is deleted. */
  killedInMove?: (from: string, to: string) => boolean;
  /**
   * The app is killed at this change to the files, counted from 0 (each write, move, rename and delete is one): a
   * write leaves half of what it was given, a move has deleted the file it moves over, a rename or a delete has not
   * happened. The app does nothing more.
   */
  killedAt?: number;
  /** The phone is full: a write to this file stops halfway and fails, and the app carries on. */
  full?: (name: string) => boolean;
  /** AsyncStorage cannot write a row: the phone is full. */
  rowFull?: boolean;
}

interface Device {
  disk: Map<string, string>;
  /** When each file was written by the phone's clock (its modificationTime), by its address. A file with none was written long ago. */
  times: Map<string, number>;
  /** When each file was truly written, by the steady clock. A file with none was written long ago. */
  real: Map<string, number>;
  /**
   * AsyncStorage's rows, by key. On the iPhone, what was saved before the app first loads there: RNCAsyncStorage
   * takes them into its manifest and files then, as it would have saved them, and `saved` reads them from there.
   */
  rows: Map<string, string>;
  trouble: Trouble;
  /** What was done to the files and rows, in order. */
  log: string[];
  /**
   * On the iPhone, RNCAsyncStorage's manifest on the disk, by key: a value of up to 1,024 characters, or null for a
   * longer one, kept in its file (`valueFile`) in `disk`.
   */
  manifest?: Map<string, string | null>;
  /** The AsyncStorage the app last loaded on this phone. */
  instance?: { setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> };
}

/**
 * On the iPhone, what RNCAsyncStorage hands back for `key` when the app is opened again: the value its manifest on
 * the disk holds, or the file it marks the value as kept in.
 */
function saved(dev: Device, key: string): string | null {
  if (!dev.manifest) return dev.rows.get(key) ?? null;
  const listed = dev.manifest.get(key);
  if (listed === undefined) return null;
  return listed ?? dev.disk.get(valueFile(key)) ?? null;
}

/** A phone with these files and rows. A file given a time was truly written then too: the phone's clock was right. */
const device = (disk = new Map<string, string>(), rows = new Map<string, string>(), trouble: Trouble = {}, times = new Map<string, number>()): Device => ({
  disk,
  times,
  real: new Map([...times].map(([uri, at]) => [uri, S0 + (at - T0)])),
  rows,
  trouble,
  log: [],
});

/** The same phone, started again with nothing wrong: what is on it stays. */
function reopen(dev: Device): Device {
  dev.trouble = {};
  dev.log.length = 0;
  return dev;
}

/**
 * The phone's clocks, from T0 and S0: Date.now reads the phone's clock, and each file is dated by it as it is
 * written; performance.now reads the steady one. Time passing moves both; a jump moves the phone's clock alone, as
 * network time setting it right, or someone setting the date, does.
 */
function clockAt(start = T0) {
  let now = start;
  let steady = S0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(performance, 'now').mockImplementation(() => steady);
  return {
    get now() {
      return now;
    },
    get steady() {
      return steady;
    },
    pass(ms: number) {
      now += ms;
      steady += ms;
    },
    jump(ms: number) {
      now += ms;
    },
  };
}
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Load a module as the app loads it on this phone, with this phone's files and rows. */
function onPhone<T>(os: Os, dev: Device, path: string): T {
  const { disk, times, real, rows, trouble, log } = dev;
  /** A file's name in the log and in `trouble`: from the app's files on Android, from the Library on the iPhone. */
  const name = (uri: string) => uri.slice(uri.startsWith(LIBRARY) ? LIBRARY.length : FILES.length);
  /** As Paths.join does: a part after the first is put in a URI's form, a space as %20. */
  const joined = (parts: (string | { uri: string })[]) =>
    parts
      .map((p, i) => (typeof p !== 'string' ? p.uri : i === 0 ? p : p.replace(/ /g, '%20')))
      .reduce((a, b) => `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`);
  /** On the iPhone, the key whose value's file this is, when it is one that cannot be read. */
  const unreadableValue = (uri: string) => os === 'ios' && [...(trouble.rowUnreadable ?? [])].some((key) => valueFile(key) === uri);
  /** Changes made to the files so far, and whether the app has been killed. */
  let changes = 0;
  let dead = false;
  /** One more change to the files: whether the app is killed at it. A dead app changes nothing. */
  const change = () => {
    if (dead) throw new Error('killed');
    const killed = changes++ === trouble.killedAt;
    if (killed) dead = true;
    return killed;
  };
  /** A file's times go where the file goes. */
  const carry = (from: string, to: string) => {
    for (const clock of [times, real]) {
      const at = clock.get(from);
      clock.delete(from);
      if (at === undefined) clock.delete(to);
      else clock.set(to, at);
    }
  };
  /** Every folder on the phone: the app's own, those the files are in, and RNCAsyncStorage's once it has made it. */
  const folders = () => {
    const found = new Set<string>([FILES, LIBRARY, `${LIBRARY}Caches/`]);
    const paths = [...disk.keys(), ...(dev.manifest ? [ASYNC_FOLDER] : [])];
    for (const uri of paths) for (let at = uri.indexOf('/', 'file:///'.length); at >= 0; at = uri.indexOf('/', at + 1)) found.add(uri.slice(0, at + 1));
    return found;
  };
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = `${joined(parts).replace(/\/+$/, '')}/`;
    }
    get exists() {
      return folders().has(this.uri);
    }
    get parentDirectory() {
      return new Directory(this.uri.replace(/[^/]+\/$/, ''));
    }
    /** What is in it, files and folders: a folder's address ends in a slash, as iOS hands it back. */
    list() {
      if (dead) throw new Error('killed');
      if (!this.exists) throw new Error('no such directory');
      const inside = new Map<string, boolean>();
      for (const uri of [...disk.keys(), ...folders()]) {
        if (!uri.startsWith(this.uri) || uri === this.uri) continue;
        const rest = uri.slice(this.uri.length);
        const slash = rest.indexOf('/');
        const entry = slash < 0 ? rest : rest.slice(0, slash);
        inside.set(entry, inside.get(entry) || slash >= 0);
      }
      return [...inside].map(([entry, folder]) => (folder ? new Directory(`${this.uri}${entry}/`) : new File(`${this.uri}${entry}`)));
    }
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = joined(parts);
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    get exists() {
      return disk.has(this.uri);
    }
    info() {
      if (dead) throw new Error('killed');
      return disk.has(this.uri) ? { exists: true, uri: this.uri, modificationTime: times.get(this.uri) ?? 0 } : { exists: false, uri: this.uri };
    }
    async text() {
      if (dead) throw new Error('killed');
      log.push(`read ${name(this.uri)}`);
      if (trouble.unreadable?.has(name(this.uri)) || unreadableValue(this.uri)) throw new Error('read failed');
      const kept = disk.get(this.uri);
      if (kept === undefined) throw new Error('no such file');
      return kept;
    }
    async write(content: string) {
      const killed = change();
      log.push(`write ${name(this.uri)}`);
      times.set(this.uri, Date.now());
      real.set(this.uri, performance.now());
      const half = content.slice(0, Math.floor(content.length / 2));
      if (killed || trouble.killedInWrite?.(name(this.uri))) {
        disk.set(this.uri, half);
        throw new Error('killed');
      }
      if (trouble.full?.(name(this.uri))) {
        disk.set(this.uri, half);
        throw new Error('ENOSPC (No space left on device)');
      }
      disk.set(this.uri, trouble.writes ? trouble.writes(name(this.uri), content) : content);
    }
    // As on Android (CopyMoveStrategy.LocalFile): a move over a file deletes that file, then renames.
    async move(to: File, options: { overwrite?: boolean } = {}) {
      const killed = change();
      log.push(`move ${name(this.uri)} ${name(to.uri)}`);
      const kept = disk.get(this.uri);
      if (kept === undefined) throw new Error('no such file');
      if (disk.has(to.uri)) {
        if (!options.overwrite) throw new Error('destination exists');
        disk.delete(to.uri);
        times.delete(to.uri);
        real.delete(to.uri);
      }
      if (killed || trouble.killedInMove?.(name(this.uri), name(to.uri))) throw new Error('killed');
      disk.delete(this.uri);
      disk.set(to.uri, kept);
      carry(this.uri, to.uri);
      this.uri = to.uri;
    }
    // As on Android (FileSystemPath.rename: Path.moveTo, no overwrite): one rename, all or nothing.
    rename(newName: string) {
      const killed = change();
      const to = `${this.uri.slice(0, this.uri.lastIndexOf('/') + 1)}${newName}`;
      log.push(`rename ${name(this.uri)} ${name(to)}`);
      if (killed) throw new Error('killed');
      const kept = disk.get(this.uri);
      if (kept === undefined) throw new Error('no such file');
      if (disk.has(to)) throw new Error('FileAlreadyExistsException');
      disk.delete(this.uri);
      disk.set(to, kept);
      carry(this.uri, to);
      this.uri = to;
    }
    delete() {
      if (change()) throw new Error('killed');
      log.push(`delete ${name(this.uri)}`);
      if (!disk.delete(this.uri)) throw new Error('no such file');
      times.delete(this.uri);
      real.delete(this.uri);
    }
  }
  // On the iPhone, what was saved before the app first loads there is in RNCAsyncStorage's manifest and files, as it
  // would have saved it.
  if (os === 'ios' && !dev.manifest) {
    dev.manifest = new Map();
    for (const [key, value] of rows) {
      if (value.length <= INLINE) dev.manifest.set(key, value);
      else {
        dev.manifest.set(key, null);
        disk.set(valueFile(key), value);
      }
    }
    rows.clear();
  }
  // As RNCAsyncStorage keeps them on the iPhone: the manifest is read from the disk when the app loads it
  // (_ensureSetup), and written back whole at a change of it (_writeManifest), not at every write. A value whose file
  // it cannot read, or finds missing, is taken off the manifest it holds and not written back then (_getValueForKey).
  const held = new Map(dev.manifest ?? []);
  const writeManifest = () => {
    dev.manifest = new Map(held);
  };
  const iphone = {
    async getItem(key: string) {
      if (!held.has(key)) return null;
      const listed = held.get(key)!;
      if (listed !== null) return listed;
      const kept = disk.get(valueFile(key));
      if (kept === undefined || trouble.rowUnreadable?.has(key)) {
        held.delete(key);
        if (kept !== undefined) throw new Error('Failed to read storage file.');
        return null;
      }
      return kept;
    },
    // _writeEntry: a short value goes into the manifest, and the file of a longer one before it goes, if the manifest
    // marks it; a longer one is written to its file, and the manifest is written only if it did not mark it already.
    async setItem(key: string, value: string) {
      if (value.length <= INLINE) {
        if (held.get(key) === null) disk.delete(valueFile(key));
        held.set(key, value);
        writeManifest();
        return;
      }
      disk.set(valueFile(key), value);
      if (held.get(key) !== null) {
        held.set(key, null);
        writeManifest();
      }
    },
    // multiRemove: the file goes only if the manifest marks it, and the manifest is written only if it lists the key.
    async removeItem(key: string) {
      if (held.get(key) === null) disk.delete(valueFile(key));
      if (held.has(key)) {
        held.delete(key);
        writeManifest();
      }
    },
  };
  const asyncStorage = {
    getItem: jest.fn(async (key: string) => {
      log.push(`read row ${key}`);
      if (os === 'ios') return iphone.getItem(key);
      if (trouble.rowUnreadable?.has(key)) throw new Error('Row too big to fit into CursorWindow');
      return rows.get(key) ?? null;
    }),
    setItem: jest.fn(async (key: string, value: string) => {
      log.push(`write row ${key}`);
      if (trouble.rowFull) throw new Error('database or disk is full (code 13 SQLITE_FULL)');
      if (os === 'ios') return iphone.setItem(key, value);
      rows.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      log.push(`remove row ${key}`);
      if (os === 'ios') return iphone.removeItem(key);
      rows.delete(key);
    }),
    getAllKeys: jest.fn(async () => {
      log.push('list rows');
      return os === 'ios' ? [...held.keys()] : [...rows.keys()];
    }),
  };
  dev.instance = asyncStorage;
  let loaded: T | undefined;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: os } }));
    jest.doMock('expo-file-system', () => ({
      File,
      Directory,
      Paths: {
        get document() {
          return new Directory(FILES);
        },
        get cache() {
          return new Directory(`${LIBRARY}Caches/`);
        },
      },
    }));
    jest.doMock('@react-native-async-storage/async-storage', () => asyncStorage);
    loaded = require(path) as T;
  });
  return loaded!;
}

const storageOn = (os: Os, dev = device()) => ({ ...onPhone<Storage>(os, dev, '../storage'), ...dev });

/** Let every save and read under way finish. Not on a timer, so that it works while the timers are made up. */
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r));
};

/** Timers that run only when a test lets time pass (`waitFor`). The phone's clocks stay the spies of `clockAt`. */
const fakeTimers = () => jest.useFakeTimers({ doNotFake: ['Date', 'performance', 'hrtime', 'nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'] });

/** Let `ms` pass on the phone's clocks, with the app open and idle: what its timers do by then is done. */
async function waitFor(clock: ReturnType<typeof clockAt>, ms: number) {
  clock.pass(ms);
  await jest.advanceTimersByTimeAsync(ms);
  await flush();
}

/** The records' checkpoints on a phone, newest first: what each holds and when it was written. */
function checkpointsOn(dev: Device): { order: number; text: string; writtenAt: number }[] {
  const start = `${FILES}${KEY}.cp-`;
  const found = [];
  for (const [uri, text] of dev.disk) {
    const order = uri === file('.prev') ? 0 : uri.startsWith(start) && uri.endsWith('.json') ? Number(uri.slice(start.length, -'.json'.length)) : null;
    if (order !== null) found.push({ order, text, writtenAt: dev.times.get(uri) ?? 0 });
  }
  return found.sort((a, b) => b.order - a.order);
}

/** A power cut now: whatever was truly written since `since`, by the steady clock, did not reach the disk whole. */
function tearSince(dev: Device, since: number) {
  for (const [uri, text] of dev.disk) {
    const at = dev.real.get(uri);
    if (at !== undefined && at > since) dev.disk.set(uri, text.slice(0, Math.floor(text.length / 2)));
  }
}

/** A value of about 3 MB, as a phone's records reach after a few years: varied, and not all plain ASCII. */
function bigValue(): string {
  const shifts = Array.from({ length: 6000 }, (_, i) => ({
    id: `s-${i}-${(i * 7919).toString(36)}`,
    employeeId: `emp-${i % 40}`,
    clockIn: 1_790_000_000_000 + i * 86_400_000,
    note: `Shift ${i}: haul road ½ mile, Peña's crew, pit ${i % 9}`,
    edits: [{ at: 1_790_000_000_000 + i, reason: 'Forgot to clock out at the end of the shift; set by the supervisor.', by: `emp-${i % 7}` }],
  }));
  const value = JSON.stringify({ state: { shifts, padding: 'x'.repeat(1_600_000) }, version: 10 });
  expect(value.length).toBeGreaterThan(3_000_000);
  return value;
}

const value = (n: number) => JSON.stringify({ state: { mrfSeq: n }, version: 10 });
const half = (text: string) => text.slice(0, Math.floor(text.length / 2));

describe('on Android, the records are kept in a file', () => {
  beforeEach(() => clockAt());

  it('keeps a value of about 3 MB in the file and reads it back unchanged, after a restart too', async () => {
    const phone = storageOn('android');
    phone.recordsRead(KEY);
    const big = bigValue();
    await phone.recordStorage.setItem(KEY, big);
    expect([...phone.disk.keys()]).toEqual([file()]);
    expect(phone.disk.get(file())).toBe(big);
    expect(phone.rows.has(KEY)).toBe(false);
    expect(await phone.recordStorage.getItem(KEY)).toBe(big);

    const again = storageOn('android', reopen(phone));
    expect(await again.recordStorage.getItem(KEY)).toBe(big);
  });

  it('writes a whole new copy beside the file before it takes its place, and keeps the file aside at most once a minute', async () => {
    const clock = clockAt();
    const phone = storageOn('android');
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, 'first');
    await phone.recordStorage.setItem(KEY, 'second');
    await phone.recordStorage.setItem(KEY, 'third');
    expect(phone.log).toEqual([
      `write ${KEY}.json.part`,
      `move ${KEY}.json.part ${KEY}.json.next`,
      `move ${KEY}.json.next ${KEY}.json`,
      `write ${KEY}.json.part`,
      `move ${KEY}.json.part ${KEY}.json.next`,
      // The file is kept aside by a rename, which keeps what it holds, before the new copy takes its place.
      `rename ${KEY}.json ${KEY}.cp-${T0}.json`,
      `move ${KEY}.json.next ${KEY}.json`,
      // Within the minute, the new copy takes the file's place.
      `write ${KEY}.json.part`,
      `move ${KEY}.json.part ${KEY}.json.next`,
      `move ${KEY}.json.next ${KEY}.json`,
    ]);
    expect(new Map(phone.disk)).toEqual(new Map([[file(), 'third'], [checkpoint(T0), 'first']]));
    // Written once each, and kept aside by renames: nothing else is written.
    expect(phone.log.filter((step) => step.startsWith('write'))).toHaveLength(3);

    clock.pass(MIN);
    await phone.recordStorage.setItem(KEY, 'fourth');
    expect(new Map(phone.disk)).toEqual(new Map([[file(), 'fourth'], [checkpoint(T0), 'first'], [checkpoint(T0 + MIN), 'third']]));
  });

  it('a phone killed in the middle of saving opens with the newest whole copy', async () => {
    const killedAt = async (trouble: Trouble) => {
      const dev = device(new Map([[file(), value(1)]]), new Map(), trouble);
      const phone = storageOn('android', dev);
      phone.recordsRead(KEY);
      await phone.recordStorage.setItem(KEY, value(2));
      return dev;
    };
    const opened = async (dev: Device) => {
      const phone = storageOn('android', reopen(dev));
      const read = await phone.recordStorage.getItem(KEY);
      // And the next save leaves the file, with what was read kept aside.
      phone.recordsRead(KEY);
      await phone.recordStorage.setItem(KEY, value(3));
      expect(dev.disk.get(file())).toBe(value(3));
      expect(checkpointsOn(dev).map((c) => c.text)).toContain(read);
      expect(dev.disk.has(file('.next'))).toBe(false);
      expect(dev.disk.has(file('.part'))).toBe(false);
      return read;
    };
    // Halfway through writing the new copy: the old one stands, and the half copy is never read.
    expect(await opened(await killedAt({ killedInWrite: (n) => n.endsWith('.part') }))).toBe(value(1));
    // Once the new copy is whole, before it takes the old one's place.
    expect(await opened(await killedAt({ killedInMove: (from) => from.endsWith('.next') }))).toBe(value(2));
  });

  it('writes the latest of several saves made at once, one save at a time', async () => {
    const phone = storageOn('android');
    phone.recordsRead(KEY);
    await Promise.all([1, 2, 3, 4, 5].map((n) => phone.recordStorage.setItem(KEY, `save ${n}`)));
    expect(phone.disk.get(file())).toBe('save 5');
    // Each save holds everything, so only the latest is written.
    expect(phone.log.filter((step) => step.startsWith('write'))).toHaveLength(1);
  });

  it('writes nothing to the phone until the store has read what was saved', async () => {
    const dev = device(new Map([[file(), 'saved']]));
    const phone = storageOn('android', dev);
    // A save made before the records are read would be an empty phone's: it is not written over them.
    await phone.recordStorage.setItem(KEY, 'empty');
    expect(dev.disk.get(file())).toBe('saved');
    expect(await phone.recordStorage.getItem(KEY)).toBe('saved');
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, 'saved and more');
    expect(dev.disk.get(file())).toBe('saved and more');
  });
});

describe('on Android, a copy that is not whole', () => {
  beforeEach(() => clockAt());

  it('a file holding half of its records, torn by a power cut, is passed over for the copy before it', async () => {
    // The copy before the last, as an earlier build of this version kept it (.prev), is read as a checkpoint.
    const dev = device(new Map([[file(), half(value(2))], [file('.prev'), value(1)]]));
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(1));
    // The next save keeps the whole copy it was made from, not the torn one.
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(3));
    expect(new Map(dev.disk)).toEqual(new Map([[file(), value(3)], [file('.prev'), value(1)]]));
  });

  it('a torn new copy beside the file is passed over for the file, and is not put in its place', async () => {
    const clock = clockAt();
    const dev = device(new Map([[file('.next'), half(value(3))], [file(), value(2)], [file('.prev'), value(1)]]));
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(2));
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(4));
    // The file read is kept aside. It was there before this session, so it counts as written when it was read: the
    // copy before it stays until this session has held it two minutes.
    expect(new Map(dev.disk)).toEqual(new Map([[file(), value(4)], [checkpoint(T0), value(2)], [file('.prev'), value(1)]]));
    clock.pass(2 * MIN);
    await phone.recordStorage.setItem(KEY, value(5));
    expect(dev.disk.has(file('.prev'))).toBe(false);
    expect(dev.disk.get(file())).toBe(value(5));
  });

  it('a whole new copy beside the file is the newest, and is read', async () => {
    const dev = device(new Map([[file('.next'), value(3)], [file(), value(2)], [file('.prev'), value(1)]]));
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(3));
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(4));
    expect(new Map(dev.disk)).toEqual(new Map([[file(), value(4)], [checkpoint(T0), value(3)], [file('.prev'), value(1)]]));
  });

  it('a torn file and torn checkpoints newer than the one read go at the next save, and are never kept aside', async () => {
    const dev = device(
      new Map([
        [file('.next'), half(value(5))],
        [file(), half(value(4))],
        [checkpoint(T0 - MIN), half(value(3))],
        [checkpoint(T0 - 2 * MIN), value(2)],
        [checkpoint(T0 - 3 * MIN), value(1)],
      ]),
    );
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(2));
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(6));
    // The one older than the one read stays until this session has held that one two minutes.
    expect(new Map(dev.disk)).toEqual(new Map([[file(), value(6)], [checkpoint(T0 - 2 * MIN), value(2)], [checkpoint(T0 - 3 * MIN), value(1)]]));
  });

  it('a copy still being written is never read, however whole it looks', async () => {
    const dev = device(new Map([[file('.part'), value(3)], [file(), value(2)]]));
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(2));
    expect(phone.log.filter((step) => step.startsWith('read'))).toEqual([`read ${KEY}.json`]);
  });

  it('with no copy whole, the newest is handed to the store as it is, and nothing is written over any', async () => {
    const torn = new Map([[file(), half(value(2))], [file('.prev'), half(value(1))]]);
    const dev = device(new Map(torn));
    const phone = storageOn('android', dev);
    // The store cannot read it, and says so (below); the files stay as they are.
    expect(await phone.recordStorage.getItem(KEY)).toBe(half(value(2)));
    await phone.recordStorage.setItem(KEY, value(0));
    expect(new Map(dev.disk)).toEqual(torn);
  });

  it('says when a newer copy was there and was passed over, and only then', async () => {
    const said = async (disk: [string, string][]) => {
      const phone = storageOn('android', device(new Map(disk)));
      await phone.recordStorage.getItem(KEY);
      return phone.passedOverNewer(KEY);
    };
    expect(await said([[file(), half(value(2))], [checkpoint(T0 - MIN), value(1)]])).toBe(true);
    expect(await said([[file('.next'), half(value(3))], [file(), value(2)]])).toBe(true);
    expect(await said([[file(), value(2)], [checkpoint(T0 - MIN), value(1)]])).toBe(false);
    expect(await said([[file('.next'), value(3)], [file(), half(value(2))]])).toBe(false);
    // Only a checkpoint left, with nothing newer beside it: nothing was passed over.
    expect(await said([[checkpoint(T0 - MIN), value(1)]])).toBe(false);
    expect(await said([])).toBe(false);
  });
});

describe('on Android, a phone killed at any step of a save', () => {
  beforeEach(() => clockAt());

  /** A phone that has saved twice: the file, and the copy before it. */
  const saved = () => new Map([[file(), value(2)], [file('.prev'), value(1)]]);

  /** Save `value(n)` on these files, killed at the given change to them (or never): the files left. */
  async function save(disk: Map<string, string>, n: number, killedAt?: number, times = new Map<string, number>()) {
    const dev = device(disk, new Map(), { killedAt }, times);
    const phone = storageOn('android', dev);
    // As the store does: it reads what is saved, then saves.
    const read = await phone.recordStorage.getItem(KEY);
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(n));
    return { read, log: dev.log };
  }

  /** How many changes to the files a save makes, from these files. */
  async function changesIn(disk: Map<string, string>, times = new Map<string, number>()) {
    const { log } = await save(new Map(disk), 9, undefined, new Map(times));
    return log.filter((step) => !step.startsWith('read')).length;
  }

  /** What a phone opened on these files reads. */
  const opened = async (disk: Map<string, string>, times = new Map<string, number>()) => storageOn('android', device(disk, new Map(), {}, times)).recordStorage.getItem(KEY);

  it('opens with the copy it had or the new one, and its next save, killed at any step too, does the same', async () => {
    const first = await changesIn(saved());
    expect(first).toBeGreaterThanOrEqual(4);
    for (let k1 = 0; k1 <= first; k1++) {
      const disk = saved();
      await save(disk, 3, k1);
      const read = await opened(disk);
      expect([value(2), value(3)]).toContain(read);

      // The next save starts from what is left, and can be killed at any step of its own.
      const second = await changesIn(disk);
      for (let k2 = 0; k2 <= second; k2++) {
        const again = new Map(disk);
        await save(again, 4, k2);
        expect([read, value(4)]).toContain(await opened(again));
        // And a save that is not killed leaves the newest, with a few whole checkpoints beside it.
        await save(again, 5);
        expect(await opened(again)).toBe(value(5));
        expect(again.has(file('.next'))).toBe(false);
        expect(again.has(file('.part'))).toBe(false);
        const kept = checkpointsOn({ ...device(again) });
        expect(kept.length).toBeGreaterThanOrEqual(1);
        expect(kept.length).toBeLessThanOrEqual(4);
        for (const { text } of kept) expect(() => JSON.parse(text)).not.toThrow();
      }
    }
  });

  it('a save that keeps the file aside, killed at any step, opens with the copy it had or the new one', async () => {
    // The file was written three minutes ago, and the checkpoint before it six: this save keeps the file aside.
    const start = () => ({
      disk: new Map([[file(), value(2)], [checkpoint(T0 - 5 * MIN), value(1)]]),
      times: new Map([[file(), T0 - 3 * MIN], [checkpoint(T0 - 5 * MIN), T0 - 6 * MIN]]),
    });
    const { log } = await save(start().disk, 3, undefined, start().times);
    expect(log).toContain(`rename ${KEY}.json ${KEY}.cp-${T0}.json`);
    const steps = await changesIn(start().disk, start().times);
    for (let k = 0; k <= steps; k++) {
      const { disk, times } = start();
      await save(disk, 3, k, times);
      expect([value(2), value(3)]).toContain(await opened(disk, times));
      // A save after it, not killed, leaves the newest, with what it was made from or older kept aside, whole.
      await save(disk, 4, undefined, times);
      expect(await opened(disk, times)).toBe(value(4));
      const kept = checkpointsOn({ ...device(disk), times }).map((c) => c.text);
      expect(kept.some((text) => text === value(2) || text === value(3))).toBe(true);
      for (const text of kept) expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  it('a power cut soon after a save, that tears the file, opens with a copy before it', async () => {
    for (let k = 0; k <= 4; k++) {
      const disk = saved();
      await save(disk, 3, k);
      // Whatever was written last may not have reached the disk whole.
      const read = await opened(disk);
      for (const name of ['.next', '']) {
        if (disk.get(file(name)) === read) disk.set(file(name), read!.slice(0, 5));
      }
      expect([value(1), value(2), value(3)]).toContain(await opened(disk));
    }
  });
});

describe('on Android, checkpoints that have had time to reach the disk', () => {
  it('three saves within a second, then a power cut that tears everything written in the last two minutes: the phone opens on a whole copy', async () => {
    const clock = clockAt();
    // A phone whose records were last saved ten minutes ago.
    const dev = device(new Map([[file(), value(1)]]), new Map(), {}, new Map([[file(), T0 - 10 * MIN]]));
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(1));
    phone.recordsRead(KEY);
    // A punch, its message, and the message going: three saves within a second.
    for (const n of [2, 3, 4]) {
      await phone.recordStorage.setItem(KEY, value(n));
      clock.pass(300);
    }
    tearSince(dev, clock.steady - 2 * MIN);
    expect(dev.disk.get(file())).toBe(half(value(4)));

    const again = storageOn('android', reopen(dev));
    expect(await again.recordStorage.getItem(KEY)).toBe(value(1));
    expect(again.passedOverNewer(KEY)).toBe(true);
  });

  it('saves every few seconds for ten minutes keep a few checkpoints at most, and always one settled from two minutes on', async () => {
    const clock = clockAt();
    const dev = device();
    const phone = storageOn('android', dev);
    phone.recordsRead(KEY);
    let most = 0;
    let saves = 0;
    for (let t = 0; t <= 10 * MIN; t += 5_000) {
      await phone.recordStorage.setItem(KEY, value(t));
      saves++;
      const kept = checkpointsOn(dev);
      most = Math.max(most, kept.length);
      if (t >= 2 * MIN) {
        // One has had two minutes to reach the disk, and holds what was saved at most about three minutes ago.
        const settled = kept.filter((c) => clock.now - c.writtenAt >= 2 * MIN);
        expect(settled.length).toBeGreaterThan(0);
        expect(clock.now - Math.max(...settled.map((c) => c.writtenAt))).toBeLessThanOrEqual(3 * MIN);
      }
      clock.pass(5_000);
    }
    expect(most).toBeLessThanOrEqual(4);
    // Nothing extra is written: one write a save, and the rest renames.
    expect(dev.log.filter((step) => step.startsWith('write'))).toHaveLength(saves);
  });

  it('lets go of the oldest checkpoint only once a newer one has had two minutes to reach the disk', async () => {
    const clock = clockAt();
    const dev = device();
    const phone = storageOn('android', dev);
    phone.recordsRead(KEY);
    const saveAt = async (ms: number, n: number) => {
      clock.pass(T0 + ms - clock.now);
      await phone.recordStorage.setItem(KEY, value(n));
    };
    await saveAt(0, 1);
    await saveAt(5_000, 2);
    await saveAt(70_000, 3);
    const first = checkpoint(T0 + 5_000);
    const second = checkpoint(T0 + 70_000);
    expect(dev.disk.get(first)).toBe(value(1));
    expect(dev.disk.get(second)).toBe(value(2));
    // The second holds what was written at 5 s: it is settled at 2 min 5 s, not before.
    await saveAt(124_999, 4);
    expect(dev.disk.has(first)).toBe(true);
    await saveAt(125_000, 5);
    expect(dev.disk.has(first)).toBe(false);
    expect(dev.disk.get(second)).toBe(value(2));
  });

  it('a checkpoint left from before, which a power cut may have torn, never makes the phone let go of an older one', async () => {
    const clock = clockAt();
    const dev = device(
      new Map([
        [file(), value(3)],
        [checkpoint(T0 - 5 * MIN), half(value(2))],
        [checkpoint(T0 - 9 * MIN), value(1)],
      ]),
      new Map(),
      {},
      new Map([
        [file(), T0 - 10_000],
        [checkpoint(T0 - 5 * MIN), T0 - 6 * MIN],
        [checkpoint(T0 - 9 * MIN), T0 - 10 * MIN],
      ]),
    );
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(3));
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(4));
    // The torn one is settled by its time, but this session never read it whole: the older one stays.
    expect(dev.disk.get(checkpoint(T0 - 9 * MIN))).toBe(value(1));
    // A power cut now tears what was written in the last two minutes, the file kept aside among it.
    clock.pass(1_000);
    tearSince(dev, clock.steady - 2 * MIN);
    expect(await storageOn('android', reopen(dev)).recordStorage.getItem(KEY)).toBe(value(1));
  });
});

describe('on Android, when the phone’s clock jumps', () => {
  /** Save every five seconds, on the steady clock, for this long: the last value saved. */
  async function saveFor(phone: ReturnType<typeof storageOn>, clock: ReturnType<typeof clockAt>, ms: number, from = 0) {
    let n = from;
    for (let t = 0; t < ms; t += 5_000) {
      n = from + t;
      await phone.recordStorage.setItem(KEY, value(n));
      clock.pass(5_000);
    }
    return n;
  }

  it('forward an hour while checkpoints are there, then a power cut that tears everything written in the last two minutes: the phone opens on a whole copy', async () => {
    const clock = clockAt();
    const dev = device();
    const phone = storageOn('android', dev);
    phone.recordsRead(KEY);
    // Three minutes of saves: checkpoints made a minute apart, the oldest two minutes and more ago.
    await saveFor(phone, clock, 3 * MIN + 10_000);
    const held = checkpointsOn(dev);
    expect(held.length).toBeGreaterThanOrEqual(3);
    // Network time sets the clock right: it jumps forward an hour. Every copy now looks an hour old by it.
    clock.jump(60 * MIN);
    await saveFor(phone, clock, 15_000, 10 * MIN);
    // The one written more than two minutes ago by the steady clock is still there,
    const settled = checkpointsOn(dev).filter((c) => (dev.real.get(checkpoint(c.order)) ?? 0) <= clock.steady - 2 * MIN);
    expect(settled.length).toBeGreaterThan(0);
    // so a power cut now, tearing what was truly written in the last two minutes, leaves a whole copy to open on.
    tearSince(dev, clock.steady - 2 * MIN);
    const again = storageOn('android', reopen(dev));
    const read = await again.recordStorage.getItem(KEY);
    expect(() => JSON.parse(read!)).not.toThrow();
    expect(again.passedOverNewer(KEY)).toBe(true);
  });

  it('back an hour: checkpoints still come no more than once a minute, and a power cut still leaves a whole copy a few minutes old', async () => {
    const clock = clockAt();
    const dev = device();
    const phone = storageOn('android', dev);
    phone.recordsRead(KEY);
    await saveFor(phone, clock, 3 * MIN);
    clock.jump(-60 * MIN);
    const before = dev.log.filter((step) => step.startsWith('rename')).length;
    const last = await saveFor(phone, clock, 4 * MIN, 10 * MIN);
    // Four minutes of saves after the jump keep the file aside about once a minute, not at every save.
    const renames = dev.log.filter((step) => step.startsWith('rename')).length - before;
    expect(renames).toBeGreaterThanOrEqual(3);
    expect(renames).toBeLessThanOrEqual(5);
    expect(checkpointsOn(dev).length).toBeLessThanOrEqual(4);
    tearSince(dev, clock.steady - 2 * MIN);
    const read = JSON.parse((await storageOn('android', reopen(dev)).recordStorage.getItem(KEY))!);
    // What it opens on was saved at most about three minutes before the cut.
    expect(read.state.mrfSeq).toBeGreaterThanOrEqual(last - 3 * MIN - 10_000);
  });
});

/** An hourly rate, in cents, that nothing else in the records spells out. */
const RATE = 98765;
/** A record that holds one person's hourly rate. */
const withRate = (n: number) => JSON.stringify({ state: { mrfSeq: n, payRates: { 'emp-1': RATE } }, version: 10 });
/** Whether a copy is whole JSON, as a power cut leaves one it did not tear. */
const isWhole = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};
/** What an emptied phone saves. */
const EMPTY = JSON.stringify({ state: { mrfSeq: 0 }, version: 10 });
/** The files on a phone that hold a record with the hourly rate in it. */
const holdingRate = (dev: Device) => [...dev.disk].filter(([, text]) => text.includes(String(RATE))).map(([uri]) => uri.slice(FILES.length));
/** A mark that a clear or a drop was made, by the first place after it. */
const marksOn = (dev: Device) => [...dev.disk.keys()].map((uri) => uri.slice(FILES.length)).filter((name) => /\.(cleared|dropped)-\d+\.json$/.test(name));

describe('on Android, emptying the phone, or taking one person’s records off it', () => {
  beforeEach(() => fakeTimers());

  /** The app is closed and opened again: the one that was running goes, and its timers with it. */
  const restart = (dev: Device) => {
    jest.clearAllTimers();
    return reopen(dev);
  };

  /** A phone that has saved every five seconds for four minutes: its file and a few checkpoints. */
  async function savingPhone(clock: ReturnType<typeof clockAt>, make: (n: number) => string = withRate) {
    const dev = device();
    const phone = storageOn('android', dev);
    phone.recordsRead(KEY);
    for (let t = 0; t <= 4 * MIN; t += 5_000) {
      await phone.recordStorage.setItem(KEY, make(t));
      clock.pass(5_000);
    }
    expect(checkpointsOn(dev).length).toBeGreaterThanOrEqual(2);
    return { dev, phone };
  }

  it('a clear: the save that clears keeps nothing of what it clears aside, and every copy from before it goes once that save has settled, with the app idle', async () => {
    const clock = clockAt();
    const { dev, phone } = await savingPhone(clock);
    const before = checkpointsOn(dev).map((c) => c.order);
    phone.forgetCopies(KEY, 'clear');
    await phone.recordStorage.setItem(KEY, EMPTY);
    expect(dev.disk.get(file())).toBe(EMPTY);
    // No checkpoint was made of the file it cleared: those there are the ones from before, which are never read again.
    expect(checkpointsOn(dev).map((c) => c.order)).toEqual(before);
    expect(marksOn(dev)).toHaveLength(1);
    await waitFor(clock, 2 * MIN - 1);
    expect(checkpointsOn(dev).map((c) => c.order)).toEqual(before);
    // Held two minutes by the steady clock: everything from before goes, then the mark.
    await waitFor(clock, 1);
    expect(new Map(dev.disk)).toEqual(new Map([[file(), EMPTY]]));
  });

  it('a clear, then a restart before it has settled: the phone opens on what was saved after it, and the next start lets go of the rest', async () => {
    const clock = clockAt();
    const { dev, phone } = await savingPhone(clock);
    phone.forgetCopies(KEY, 'clear');
    await phone.recordStorage.setItem(KEY, EMPTY);
    clock.pass(30_000);
    const again = storageOn('android', restart(dev));
    expect(await again.recordStorage.getItem(KEY)).toBe(EMPTY);
    again.recordsRead(KEY);
    await again.recordStorage.setItem(KEY, EMPTY);
    expect(holdingRate(dev).length).toBeGreaterThan(0);
    // This session has held what it read two minutes: what came before the clear goes, and the mark with it.
    await waitFor(clock, 2 * MIN);
    expect(holdingRate(dev)).toEqual([]);
    expect(marksOn(dev)).toEqual([]);
  });

  it('a clear, then a power cut before it has settled: the phone opens as the build starts, never on what was cleared, and never on Records not read', async () => {
    const clock = clockAt();
    const { dev, phone } = await savingPhone(clock);
    phone.forgetCopies(KEY, 'clear');
    await phone.recordStorage.setItem(KEY, EMPTY);
    clock.pass(1_000);
    // What was written in the last two minutes is torn: the cleared file among it. Whole copies from before are there.
    tearSince(dev, clock.steady - 2 * MIN);
    expect(checkpointsOn(dev).some((c) => c.text.includes(String(RATE)) && isWhole(c.text))).toBe(true);
    const again = storageOn('android', restart(dev));
    expect(await again.recordStorage.getItem(KEY)).toBeNull();
    expect(again.passedOverNewer(KEY)).toBe(false);
    // Its first save starts the phone over; what came before goes once that has settled.
    again.recordsRead(KEY);
    await again.recordStorage.setItem(KEY, EMPTY);
    await waitFor(clock, 2 * MIN);
    expect(new Map(dev.disk)).toEqual(new Map([[file(), EMPTY]]));
  });

  it('a clear, with the app killed at any step of it: the phone opens emptied, or, killed before the file it clears was taken away, as it was', async () => {
    const steps = async (killedAt?: number) => {
      jest.clearAllTimers();
      jest.restoreAllMocks();
      const clock = clockAt();
      const { dev, phone } = await savingPhone(clock);
      const last = dev.disk.get(file());
      dev.trouble.killedAt = killedAt;
      dev.log.length = 0;
      phone.forgetCopies(KEY, 'clear');
      // A save that the kill stops is held in memory, as one the phone cannot write is: it does not fail.
      await phone.recordStorage.setItem(KEY, EMPTY);
      await flush();
      return { dev, last, changes: dev.log.filter((step) => !step.startsWith('read') && !step.includes('row')).length };
    };
    // Counted on a phone that was not killed: the changes the clear and its save make.
    const { changes } = await steps();
    expect(changes).toBeGreaterThanOrEqual(4);
    for (let k = 0; k <= changes; k++) {
      const { dev, last } = await steps(k);
      // Never a copy from before the clear but the file itself, and that only while the clear had not taken it away.
      const asItWas = dev.disk.get(file()) === last ? [last] : [];
      const read = await storageOn('android', restart(dev)).recordStorage.getItem(KEY);
      expect([null, EMPTY, ...asItWas]).toContain(read);
    }
  });

  it('a drop: the copies from before go once the save has settled; a power cut before then brings back the copy before it, and says so', async () => {
    const clock = clockAt();
    const { dev, phone } = await savingPhone(clock);
    phone.forgetCopies(KEY, 'drop');
    await phone.recordStorage.setItem(KEY, value(9));
    // The rest of the records stay on the phone meanwhile, in copies from before.
    expect(holdingRate(dev).length).toBeGreaterThan(0);
    const cut = new Map(dev.disk);
    const cutReal = new Map(dev.real);
    const cutAt = clock.steady;

    await waitFor(clock, 2 * MIN);
    expect(holdingRate(dev)).toEqual([]);
    expect(marksOn(dev)).toEqual([]);
    expect(dev.disk.get(file())).toBe(value(9));

    // The same phone, had its power gone in that window: it opens on a whole copy from before, which still has the
    // rate in it, and says it shut off while saving. Nothing else on it is lost.
    const powerCut = device(cut);
    for (const [uri, at] of cutReal) powerCut.real.set(uri, at);
    tearSince(powerCut, cutAt - 2 * MIN);
    const again = storageOn('android', powerCut);
    expect(await again.recordStorage.getItem(KEY)).toContain(String(RATE));
    expect(again.passedOverNewer(KEY)).toBe(true);
  });

  it('a drop, then a restart before it has settled: the next start lets go of the copies from before once the copy it read has settled', async () => {
    const clock = clockAt();
    const { dev, phone } = await savingPhone(clock);
    phone.forgetCopies(KEY, 'drop');
    await phone.recordStorage.setItem(KEY, value(9));
    clock.pass(10_000);
    const again = storageOn('android', restart(dev));
    expect(await again.recordStorage.getItem(KEY)).toBe(value(9));
    again.recordsRead(KEY);
    await again.recordStorage.setItem(KEY, value(9));
    expect(holdingRate(dev).length).toBeGreaterThan(0);
    await waitFor(clock, 2 * MIN);
    expect(holdingRate(dev)).toEqual([]);
    expect(marksOn(dev)).toEqual([]);
  });

  it('nothing is let go of before the store has read the records, and removing them takes the marks too', async () => {
    const clock = clockAt();
    const { dev, phone } = await savingPhone(clock);
    phone.forgetCopies(KEY, 'clear');
    await phone.recordStorage.setItem(KEY, EMPTY);
    // A start whose read the store could not make sense of saves nothing, so nothing is let go of there.
    const again = storageOn('android', restart(dev));
    await again.recordStorage.getItem(KEY);
    await waitFor(clock, 3 * MIN);
    expect(holdingRate(dev).length).toBeGreaterThan(0);
    again.recordsRead(KEY);
    await again.recordStorage.removeItem(KEY);
    expect(dev.disk.size).toBe(0);
  });

  it('is asked for nothing before the store has read the records', async () => {
    const clock = clockAt();
    const dev = device(new Map([[file(), withRate(1)]]), new Map(), {}, new Map([[file(), T0 - 10 * MIN]]));
    const phone = storageOn('android', dev);
    phone.forgetCopies(KEY, 'clear');
    await waitFor(clock, 3 * MIN);
    expect(new Map(dev.disk)).toEqual(new Map([[file(), withRate(1)]]));
  });
});

describe('a save that cannot be written', () => {
  it('on Android, is said once, leaves no half copy, is read back meanwhile, and the next save that works says so', async () => {
    const dev = device(new Map([[file(), value(1)]]), new Map(), { full: (n) => n.endsWith('.part') });
    const phone = storageOn('android', dev);
    const said: boolean[] = [];
    phone.watchUnsaved((unsaved) => said.push(unsaved));
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(1));
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(2));
    expect(said).toEqual([true]);
    // The half copy would only fill the phone more.
    expect(new Map(dev.disk)).toEqual(new Map([[file(), value(1)]]));
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(2));
    await phone.recordStorage.setItem(KEY, value(3));
    expect(said).toEqual([true]);

    dev.trouble.full = undefined;
    await phone.recordStorage.setItem(KEY, value(4));
    expect(said).toEqual([true, false]);
    expect(dev.disk.get(file())).toBe(value(4));
  });

  it('on the iPhone, is said the same way', async () => {
    const dev = device(new Map(), new Map(), { rowFull: true });
    const phone = storageOn('ios', dev);
    const said: boolean[] = [];
    phone.watchUnsaved((unsaved) => said.push(unsaved));
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(1));
    expect(said).toEqual([true]);
    expect(saved(dev, KEY)).toBeNull();
    // No mark for records that were never saved.
    expect(saved(dev, MARK)).toBeNull();
    dev.trouble.rowFull = false;
    await phone.recordStorage.setItem(KEY, value(2));
    expect(said).toEqual([true, false]);
    expect(saved(dev, KEY)).toBe(value(2));
  });

  it('is not said for saves held before the records are read', async () => {
    const dev = device(new Map([[file(), value(1)]]), new Map(), { full: () => true });
    const phone = storageOn('android', dev);
    const said: boolean[] = [];
    phone.watchUnsaved((unsaved) => said.push(unsaved));
    await phone.recordStorage.setItem(KEY, value(2));
    expect(said).toEqual([]);
  });
});

describe('moving an older version’s records into the file', () => {
  it('moves the row into the file on the first read, and removes the row once the file has been held two minutes by the steady clock', async () => {
    const clock = clockAt();
    const moved = bigValue().slice(0, 1_500_000);
    const dev = device(new Map(), new Map([[KEY, moved], [SESSION, 'tokens']]));
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(moved);
    expect(dev.disk.get(file())).toBe(moved);
    expect(phone.log).toEqual([
      `read row ${KEY}`,
      `write ${KEY}.json.part`,
      `move ${KEY}.json.part ${KEY}.json.next`,
      `move ${KEY}.json.next ${KEY}.json`,
      `read ${KEY}.json`,
    ]);
    // What was just written may not be on the disk yet: the row stays, after later saves too.
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(8));
    expect(dev.rows.get(KEY)).toBe(moved);
    // The phone's clock jumping forward an hour does not put it on the disk any sooner.
    clock.jump(60 * MIN);
    clock.pass(2 * MIN - 1);
    await phone.recordStorage.setItem(KEY, value(8));
    expect(dev.rows.get(KEY)).toBe(moved);

    // Two minutes after it was written, by the steady clock, it has: the row goes at the next save.
    clock.pass(1);
    await phone.recordStorage.setItem(KEY, value(8));
    expect(dev.rows.has(KEY)).toBe(false);
    // The server session stays in AsyncStorage.
    expect(dev.rows.get(SESSION)).toBe('tokens');

    // From then on the file is read, and AsyncStorage is never asked for the records.
    const after = storageOn('android', reopen(dev));
    expect(await after.recordStorage.getItem(KEY)).toBe(value(8));
    expect(after.log).toEqual([`read ${KEY}.json`, 'list rows']);
  });

  it('a row moved at an earlier start, read whole now, goes only once this session has held the file two minutes, whatever the phone’s clock says', async () => {
    fakeTimers();
    const clock = clockAt();
    // The file was written long ago by the phone's clock; the row an older version left is still there.
    const dev = device(new Map([[file(), value(8)]]), new Map([[KEY, value(7)], [SESSION, 'tokens']]));
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(8));
    // Not at the read: this session has only just seen the file, which may have been written just before a restart.
    expect(dev.rows.get(KEY)).toBe(value(7));
    expect(phone.log).toEqual([`read ${KEY}.json`, 'list rows']);
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(8));
    clock.jump(60 * MIN);
    await phone.recordStorage.setItem(KEY, value(8));
    expect(dev.rows.get(KEY)).toBe(value(7));
    await waitFor(clock, 2 * MIN - 1);
    expect(dev.rows.get(KEY)).toBe(value(7));
    // With no save meanwhile, a timer takes it off once the file has been held two minutes.
    await waitFor(clock, 1);
    expect(dev.rows.has(KEY)).toBe(false);
    expect(dev.rows.get(SESSION)).toBe('tokens');
  });

  it('keeps the row when the file does not read back the same, and leaves no copy that differs', async () => {
    const row = value(7);
    const dev = device(new Map(), new Map([[KEY, row]]), { writes: (_n, content) => content.slice(0, 10) });
    const phone = storageOn('android', dev);
    // The phone still opens with its records,
    expect(await phone.recordStorage.getItem(KEY)).toBe(row);
    // which stay where they were,
    expect(dev.rows.get(KEY)).toBe(row);
    // and no copy that is not the same is left to be read next time.
    expect(dev.disk.size).toBe(0);

    // The next start, with the files working, moves them.
    const later = storageOn('android', reopen(dev));
    expect(await later.recordStorage.getItem(KEY)).toBe(row);
    expect(dev.disk.get(file())).toBe(row);
    expect(dev.rows.get(KEY)).toBe(row);
  });

  it('a power cut soon after the move, that tears the files, opens on the row, which is still there', async () => {
    clockAt();
    // The row an older version left, and the files this version made of it and saved since, every one torn.
    const dev = device(
      new Map([
        [file('.next'), half(value(9))],
        [file(), half(value(8))],
        [checkpoint(T0 - 10_000), half(value(7))],
      ]),
      new Map([[KEY, value(7)]]),
    );
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(7));
    // What was saved after the move is gone, and the phone says so.
    expect(phone.passedOverNewer(KEY)).toBe(true);
    // The next save puts whole records in place of the torn ones; the row stays until the file has reached the disk.
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(10));
    expect(new Map(dev.disk)).toEqual(new Map([[file(), value(10)]]));
    expect(dev.rows.get(KEY)).toBe(value(7));
  });
});

describe('a read that fails', () => {
  it('on Android, a file that cannot be read is not taken for a new phone, and nothing is written over it', async () => {
    const dev = device(new Map([[file(), 'saved']]), new Map(), { unreadable: new Set([`${KEY}.json`]) });
    const phone = storageOn('android', dev);
    await expect(phone.recordStorage.getItem(KEY)).rejects.toThrow();
    await phone.recordStorage.setItem(KEY, 'empty');
    await phone.recordStorage.removeItem(KEY);
    expect([...dev.disk.entries()]).toEqual([[file(), 'saved']]);
    // Once it can be read, it is all there.
    dev.trouble.unreadable!.clear();
    expect(await phone.recordStorage.getItem(KEY)).toBe('saved');
  });

  it('on Android, an older version’s row too big to read is left where it is', async () => {
    const big = bigValue();
    const dev = device(new Map(), new Map([[KEY, big]]), { rowUnreadable: new Set([KEY]) });
    const phone = storageOn('android', dev);
    await expect(phone.recordStorage.getItem(KEY)).rejects.toThrow();
    await phone.recordStorage.setItem(KEY, 'empty');
    await phone.recordStorage.removeItem(KEY);
    expect(dev.rows.get(KEY)).toBe(big);
    expect(dev.disk.size).toBe(0);
  });

  it('on the iPhone, records whose file cannot be read are left where they are, and the read writes nothing to AsyncStorage', async () => {
    const big = bigValue();
    const dev = device(new Map(), new Map([[KEY, big]]), { rowUnreadable: new Set([KEY]) });
    const phone = storageOn('ios', dev);
    await expect(phone.recordStorage.getItem(KEY)).rejects.toThrow();
    await phone.recordStorage.setItem(KEY, 'empty');
    await phone.recordStorage.removeItem(KEY);
    expect(dev.disk.get(valueFile(KEY))).toBe(big);
    // Nothing was written: RNCAsyncStorage's manifest on the disk still lists them, as kept in their file.
    expect(phone.log.filter((step) => /^(write|remove) row/.test(step))).toEqual([]);
    expect(saved(dev, KEY)).toBe(big);
  });
});

describe('on the iPhone', () => {
  it('keeps the records in AsyncStorage, where they have always been', async () => {
    const dev = device();
    const phone = storageOn('ios', dev);
    phone.recordsRead(KEY);
    const big = bigValue();
    await phone.recordStorage.setItem(KEY, big);
    expect(saved(dev, KEY)).toBe(big);
    // In RNCAsyncStorage's own file for them, and nowhere in the app's files, as on Android.
    expect([...dev.disk.keys()]).toEqual([valueFile(KEY)]);
    expect(await phone.recordStorage.getItem(KEY)).toBe(big);
  });

  it('marks that records are kept here once they are saved or read, and not before', async () => {
    const empty = device();
    const fresh = storageOn('ios', empty);
    expect(await fresh.recordStorage.getItem(KEY)).toBeNull();
    expect(saved(empty, MARK)).toBeNull();
    fresh.recordsRead(KEY);
    await fresh.recordStorage.setItem(KEY, value(1));
    expect(saved(empty, MARK)).toBe('1');

    // A phone that saved its records before there was a mark gets one the first time they are read.
    const before = device(new Map(), new Map([[KEY, value(2)]]));
    const older = storageOn('ios', before);
    expect(await older.recordStorage.getItem(KEY)).toBe(value(2));
    expect(saved(before, MARK)).toBe('1');
  });

  it('takes the mark off with the records', async () => {
    const dev = device(new Map(), new Map([[KEY, value(2)], [MARK, '1']]));
    const phone = storageOn('ios', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(2));
    phone.recordsRead(KEY);
    await phone.recordStorage.removeItem(KEY);
    expect(saved(dev, KEY)).toBeNull();
    expect(saved(dev, MARK)).toBeNull();
    expect(await storageOn('ios', reopen(dev)).recordStorage.getItem(KEY)).toBeNull();
  });

  /** A phone whose manifest on the disk lists the mark and not the records, though their file is there. */
  const unlisted = (records: string) => {
    const dev = device(new Map([[valueFile(KEY), records]]));
    dev.manifest = new Map([[MARK, '1']]);
    return dev;
  };

  it('reads records that AsyncStorage no longer lists from their own file', async () => {
    const big = bigValue();
    const dev = unlisted(big);
    const phone = storageOn('ios', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(big);
    expect(phone.log).toEqual([`read row ${KEY}`, `read Application%20Support/com.minemuster.app/RCTAsyncLocalStorage_V1/${md5(KEY)}`, `read row ${MARK}`]);
    // Its next save of them lists them again.
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, big);
    expect(saved(dev, KEY)).toBe(big);
    expect(dev.manifest!.get(KEY)).toBeNull();
  });

  it('a removal of records read from their own file takes that file too, so a later start does not read them back', async () => {
    const dev = unlisted(bigValue());
    const phone = storageOn('ios', dev);
    expect(await phone.recordStorage.getItem(KEY)).not.toBeNull();
    phone.recordsRead(KEY);
    await phone.recordStorage.removeItem(KEY);
    expect(dev.disk.has(valueFile(KEY))).toBe(false);
    expect(saved(dev, MARK)).toBeNull();
    expect(await storageOn('ios', reopen(dev)).recordStorage.getItem(KEY)).toBeNull();
  });

  it('a save short enough for the manifest leaves no file of the records from before it', async () => {
    // RNCAsyncStorage takes away the file of a longer value only if its manifest marks it as kept there.
    const dev = unlisted(bigValue());
    const phone = storageOn('ios', dev);
    expect(await phone.recordStorage.getItem(KEY)).not.toBeNull();
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(3));
    expect(saved(dev, KEY)).toBe(value(3));
    expect(dev.disk.has(valueFile(KEY))).toBe(false);
  });

  it('records whose own file is there but not whole are a read that fails, and nothing is written', async () => {
    const torn = half(bigValue());
    const dev = unlisted(torn);
    dev.manifest = new Map();
    const phone = storageOn('ios', dev);
    await expect(phone.recordStorage.getItem(KEY)).rejects.toThrow();
    expect(phone.log.filter((step) => /^(write|remove) row/.test(step))).toEqual([]);
    expect(dev.disk.get(valueFile(KEY))).toBe(torn);
  });
});

describe('the server session', () => {
  it('stays in AsyncStorage on Android', async () => {
    const phone = storageOn('android');
    await phone.safeStorage.setItem(SESSION, 'tokens');
    expect(phone.rows.get(SESSION)).toBe('tokens');
    expect(phone.disk.size).toBe(0);
    expect(await phone.safeStorage.getItem(SESSION)).toBe('tokens');
  });

  it('is still saved on the phone after the records could not be read', async () => {
    const dev = device(new Map(), new Map([[KEY, bigValue()]]), { rowUnreadable: new Set([KEY]) });
    const phone = storageOn('android', dev);
    await expect(phone.recordStorage.getItem(KEY)).rejects.toThrow();
    await phone.safeStorage.setItem(SESSION, 'tokens');
    expect(dev.rows.get(SESSION)).toBe('tokens');
  });

  it('a row that cannot be read falls back to memory on its own, and every other row is still saved', async () => {
    const dev = device(new Map(), new Map([['other', 'old']]), { rowUnreadable: new Set(['other']) });
    const phone = storageOn('android', dev);
    expect(await phone.safeStorage.getItem('other')).toBeNull();
    await phone.safeStorage.setItem('other', 'new');
    expect(await phone.safeStorage.getItem('other')).toBe('new');
    expect(dev.rows.get('other')).toBe('old');
    await phone.safeStorage.setItem(SESSION, 'tokens');
    expect(dev.rows.get(SESSION)).toBe('tokens');
    expect(await phone.safeStorage.getItem(SESSION)).toBe('tokens');
  });
});

/** A store build's store (eas.json) on this phone: it connects, holds nobody made up and names nobody. */
function storeOn(os: Os, dev: Device): UseStore {
  const saved = { ...process.env };
  for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
  Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });
  try {
    return onPhone<{ useStore: UseStore }>(os, dev, '../../store/useStore').useStore;
  } finally {
    process.env = saved;
  }
}

/**
 * A phone that has been in use: its records saved, with something of its own in them, and long enough that the
 * iPhone keeps them in a file of their own, as it does a phone's records within days.
 */
async function usedPhone(os: Os, dev = device()) {
  const store = storeOn(os, dev);
  await flush();
  expect(store.getState().hydrated).toBe(true);
  const denied = Array.from({ length: 20 }, (_, i) => ({ id: `dp_${i}`, employeeId: 'emp-1', at: T0 + i * MIN, action: 'clock_in' as const, reason: 'outside' as const }));
  store.setState({ mrfSeq: 41, denied });
  await flush();
  return dev;
}

describe('the store, when the records on the phone cannot be read', () => {
  it('on Android, says so instead of opening as a new phone, writes nothing over them, and reads them once it can', async () => {
    const dev = await usedPhone('android');
    expect(JSON.parse(dev.disk.get(file())!).state.mrfSeq).toBe(41);
    const files = new Map(dev.disk);

    dev.trouble.unreadable = new Set([`${KEY}.json`]);
    const store = storeOn('android', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(store.getState().hydrated).toBe(false);
    // Whatever the app does meanwhile is not written over them.
    store.getState().showToast('Anything');
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(new Map(dev.disk)).toEqual(files);

    // Try again, while they still cannot be read: the same.
    await store.getState().readRecordsAgain();
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(store.getState().hydrated).toBe(false);

    // And once they can.
    dev.trouble.unreadable.clear();
    await store.getState().readRecordsAgain();
    await flush();
    expect(store.getState().recordsUnreadable).toBe(false);
    expect(store.getState().hydrated).toBe(true);
    expect(store.getState().mrfSeq).toBe(41);
  });

  it('on Android, an older version’s row too big to read is not taken for a new phone', async () => {
    const row = saved(await usedPhone('ios'), KEY)!;
    expect(JSON.parse(row).state.mrfSeq).toBe(41);
    // The same records, as an older version left them on an Android phone, grown past what a row can hand back.
    const dev = device(new Map(), new Map([[KEY, row]]), { rowUnreadable: new Set([KEY]) });
    const store = storeOn('android', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(store.getState().hydrated).toBe(false);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(dev.rows.get(KEY)).toBe(row);
    expect(dev.disk.size).toBe(0);
  });

  it('on the iPhone, says so instead of opening as a new phone, and writes nothing over them', async () => {
    const dev = await usedPhone('ios');
    const row = saved(dev, KEY)!;
    // Kept in a file of their own, which is what RNCAsyncStorage can fail to read.
    expect(row.length).toBeGreaterThan(INLINE);
    dev.trouble.rowUnreadable = new Set([KEY]);
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(store.getState().hydrated).toBe(false);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(saved(dev, KEY)).toBe(row);
  });

  it('records that do not make sense are not written over either', async () => {
    const dev = device(new Map([[file(), '{"state": {"mrfSeq": 4']]));
    const store = storeOn('android', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(dev.disk.get(file())).toBe('{"state": {"mrfSeq": 4');
  });

  it('a phone that can read its records opens as before, and says nothing about a shut-off', async () => {
    const dev = await usedPhone('android');
    const store = storeOn('android', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(false);
    expect(store.getState().hydrated).toBe(true);
    expect(store.getState().mrfSeq).toBe(41);
    expect(store.getState().shutOffWhileSaving).toBe(false);
    // A phone keeps its records on the phone: never only in memory, as a browser that blocks its storage does.
    expect(store.getState().recordsInMemory).toBe(false);
  });

  it('a phone that lost power just after a save opens with a checkpoint before it, and says so until it is seen', async () => {
    const clock = clockAt();
    const dev = await usedPhone('android');
    clock.pass(MIN);
    const store = storeOn('android', dev);
    await flush();
    store.setState({ mrfSeq: 42 });
    await flush();
    const torn = dev.disk.get(file())!;
    expect(JSON.parse(torn).state.mrfSeq).toBe(42);
    dev.disk.set(file(), torn.slice(0, Math.floor(torn.length / 2)));
    const again = storeOn('android', dev);
    await flush();
    expect(again.getState().recordsUnreadable).toBe(false);
    expect(again.getState().hydrated).toBe(true);
    expect(again.getState().mrfSeq).toBe(41);
    expect(again.getState().shutOffWhileSaving).toBe(true);
    // What is said is never saved itself.
    expect(JSON.parse(dev.disk.get(file())!).state).not.toHaveProperty('shutOffWhileSaving');
    again.getState().dismissShutOffNotice();
    expect(again.getState().shutOffWhileSaving).toBe(false);
  });
});

describe('the store on the iPhone, when AsyncStorage could not read the records', () => {
  // RNCAsyncStorage takes the key off the manifest it holds when it cannot read the value's file: asked again in
  // the same session it says there is nothing, and its next change of the manifest, of any key, writes it to the
  // disk without the key, so that a new RNCAsyncStorage never looks at the file again. So a read that fails writes
  // nothing to AsyncStorage, and records it does not list are read from their own file.

  /** A phone in use: its records in a file of their own, with the mark beside them, or without, as the App Store build left them. */
  async function inUse(mark: boolean) {
    const dev = reopen(await usedPhone('ios'));
    expect(dev.manifest!.get(KEY)).toBeNull();
    if (!mark) dev.manifest!.delete(MARK);
    return { dev, row: saved(dev, KEY)! };
  }
  /** What was written to AsyncStorage since the phone was last started. */
  const written = (dev: Device) => dev.log.filter((step) => /^(write|remove) row/.test(step));
  const readFromFile = `read Application%20Support/com.minemuster.app/RCTAsyncLocalStorage_V1/${md5(KEY)}`;

  it('a read that fails writes nothing when the mark is there, so opening MineMuster again reads them', async () => {
    const { dev } = await inUse(true);
    const onDisk = new Map(dev.manifest);
    dev.trouble.rowUnreadable = new Set([KEY]);
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(written(dev)).toEqual([]);
    // The manifest on the disk still lists the records.
    expect(dev.manifest).toEqual(onDisk);

    const again = storeOn('ios', reopen(dev));
    await flush();
    expect(again.getState().recordsUnreadable).toBe(false);
    expect(again.getState().hydrated).toBe(true);
    expect(again.getState().mrfSeq).toBe(41);
  });

  it('records saved before there was a mark: a read that fails writes nothing, not even a mark, so opening again reads them', async () => {
    const { dev, row } = await inUse(false);
    const onDisk = new Map(dev.manifest);
    dev.trouble.rowUnreadable = new Set([KEY]);
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(written(dev)).toEqual([]);
    expect(dev.manifest).toEqual(onDisk);
    expect(saved(dev, KEY)).toBe(row);

    const again = storeOn('ios', reopen(dev));
    await flush();
    expect(again.getState().recordsUnreadable).toBe(false);
    expect(again.getState().hydrated).toBe(true);
    expect(again.getState().mrfSeq).toBe(41);
    // Read as they were, then marked.
    expect(saved(dev, MARK)).toBe('1');
  });

  for (const mark of [true, false]) {
    it(`a manifest on the disk that lost the records’ key ${mark ? 'with' : 'without'} the mark there: they are read from their own file, and the save as the app opens lists them again`, async () => {
      const { dev, row } = await inUse(mark);
      dev.trouble.rowUnreadable = new Set([KEY]);
      const store = storeOn('ios', dev);
      await flush();
      expect(store.getState().recordsUnreadable).toBe(true);
      // A change of another key in that session writes the manifest RNCAsyncStorage holds, as the mark an earlier
      // version wrote then did.
      await dev.instance!.setItem(SESSION, 'tokens');
      expect(dev.manifest!.has(KEY)).toBe(false);
      expect(dev.disk.get(valueFile(KEY))).toBe(row);

      const again = storeOn('ios', reopen(dev));
      await flush();
      expect(again.getState().recordsUnreadable).toBe(false);
      expect(again.getState().hydrated).toBe(true);
      expect(again.getState().mrfSeq).toBe(41);
      expect(dev.log).toContain(readFromFile);
      expect(dev.manifest!.get(KEY)).toBeNull();

      // From then on AsyncStorage hands them back itself.
      const third = storeOn('ios', reopen(dev));
      await flush();
      expect(third.getState().mrfSeq).toBe(41);
      expect(dev.log).not.toContain(readFromFile);
    });
  }

  it('Try again, which AsyncStorage answers with nothing, reads them from their own file once it can, and writes nothing before then', async () => {
    const { dev, row } = await inUse(true);
    dev.trouble.rowUnreadable = new Set([KEY]);
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    // Their file still cannot be read.
    await store.getState().readRecordsAgain();
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(store.getState().hydrated).toBe(false);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(written(dev)).toEqual([]);
    expect(dev.disk.get(valueFile(KEY))).toBe(row);

    // Now it can: this AsyncStorage has forgotten the key, and the file is read.
    dev.trouble.rowUnreadable.clear();
    await store.getState().readRecordsAgain();
    await flush();
    expect(store.getState().recordsUnreadable).toBe(false);
    expect(store.getState().hydrated).toBe(true);
    expect(store.getState().mrfSeq).toBe(41);
    expect(dev.manifest!.get(KEY)).toBeNull();
  });

  it('records whose own file is there but not whole: not a new phone, and nothing written over them', async () => {
    const torn = half(saved((await inUse(false)).dev, KEY)!);
    const dev = device(new Map([[valueFile(KEY), torn]]));
    dev.manifest = new Map();
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(written(dev)).toEqual([]);
    expect(dev.disk.get(valueFile(KEY))).toBe(torn);
  });

  it('no records anywhere, and the mark there: still not a new phone, and nothing written', async () => {
    const dev = device(new Map(), new Map([[MARK, '1']]));
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(store.getState().hydrated).toBe(false);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(written(dev)).toEqual([]);
  });

  it('a new iPhone, with nothing saved and no mark, opens as a new phone', async () => {
    const store = storeOn('ios', device());
    await flush();
    expect(store.getState().recordsUnreadable).toBe(false);
    expect(store.getState().hydrated).toBe(true);
  });
});

describe('the store, when a save of the records cannot be written', () => {
  const mrfSeqSaved = (text: string | undefined) => JSON.parse(text!).state.mrfSeq;

  it('on Android, says so, keeps what was done in the app, and stops saying so once a save works', async () => {
    const dev = device();
    const store = storeOn('android', dev);
    await flush();
    store.setState({ mrfSeq: 41 });
    await flush();
    expect(store.getState().recordsUnsaved).toBe(false);

    dev.trouble.full = (n) => n.endsWith('.part');
    store.setState({ mrfSeq: 42 });
    await flush();
    expect(store.getState().recordsUnsaved).toBe(true);
    expect(store.getState().mrfSeq).toBe(42);
    expect(mrfSeqSaved(dev.disk.get(file()))).toBe(41);

    // Saving again, while the phone is still full: still said.
    store.getState().saveRecordsAgain();
    await flush();
    expect(store.getState().recordsUnsaved).toBe(true);

    // Once there is room.
    dev.trouble.full = undefined;
    store.getState().saveRecordsAgain();
    await flush();
    expect(store.getState().recordsUnsaved).toBe(false);
    expect(mrfSeqSaved(dev.disk.get(file()))).toBe(42);
    // What is said is never saved itself.
    expect(JSON.parse(dev.disk.get(file())!).state).not.toHaveProperty('recordsUnsaved');
  });

  it('on the iPhone, the same', async () => {
    const dev = device();
    const store = storeOn('ios', dev);
    await flush();
    dev.trouble.rowFull = true;
    store.setState({ mrfSeq: 7 });
    await flush();
    expect(store.getState().recordsUnsaved).toBe(true);
    dev.trouble.rowFull = false;
    store.setState({ mrfSeq: 8 });
    await flush();
    expect(store.getState().recordsUnsaved).toBe(false);
    expect(mrfSeqSaved(saved(dev, KEY) ?? undefined)).toBe(8);
  });
});

describe('the store on Android, emptying the phone or deleting an account', () => {
  beforeEach(() => fakeTimers());

  /** A store build's phone in use for four minutes, saving every five seconds, with an hourly rate on it. */
  async function inUse(clock: ReturnType<typeof clockAt>) {
    const dev = device();
    const store = storeOn('android', dev);
    await flush();
    expect(store.getState().hydrated).toBe(true);
    for (let i = 1; i <= 50; i++) {
      store.setState({ mrfSeq: i, payRates: { 'emp-1': RATE } });
      await flush();
      clock.pass(5_000);
    }
    expect(checkpointsOn(dev).length).toBeGreaterThanOrEqual(2);
    return { dev, store };
  }

  it('emptying the phone (signing out of it, clearing it, deleting an account with it) leaves nothing of what it held in its files once that save has settled', async () => {
    const clock = clockAt();
    const { dev, store } = await inUse(clock);
    store.getState().resetDemo();
    await flush();
    expect(JSON.parse(dev.disk.get(file())!).state.payRates).toEqual({});
    // Copies from before are there for two minutes at most, and never read again meanwhile.
    expect(holdingRate(dev).length).toBeGreaterThan(0);
    await waitFor(clock, 2 * MIN);
    expect(holdingRate(dev)).toEqual([]);
    expect([...dev.disk.keys()]).toEqual([file()]);
  });

  it('emptying the phone, then a power cut before that save has settled: it opens as the build starts, and says nothing of a shut-off', async () => {
    const clock = clockAt();
    const { dev, store } = await inUse(clock);
    store.getState().resetDemo();
    await flush();
    clock.pass(1_000);
    tearSince(dev, clock.steady - 2 * MIN);
    const again = storeOn('android', reopen(dev));
    await flush();
    expect(again.getState().recordsUnreadable).toBe(false);
    expect(again.getState().hydrated).toBe(true);
    expect(again.getState().payRates).toEqual({});
    expect(again.getState().mrfSeq).not.toBe(50);
    expect(again.getState().shutOffWhileSaving).toBe(false);
  });

  it('deleting an account takes its hourly rate out of every copy once that save has settled, and the rest of the records stay', async () => {
    const clock = clockAt();
    const { dev, store } = await inUse(clock);
    store.setState({ accounts: [{ id: 'acct_1', employeeId: 'emp-1', email: '', provider: 'company', createdAt: T0 }], session: { accountId: 'acct_1', employeeId: 'emp-1' } });
    await flush();
    expect(store.getState().deleteMyAccount({ clearPhone: false })).toEqual({ ok: true, cleared: false });
    await flush();
    expect(holdingRate(dev).length).toBeGreaterThan(0);
    await waitFor(clock, 2 * MIN);
    expect(holdingRate(dev)).toEqual([]);
    const kept = JSON.parse(dev.disk.get(file())!).state;
    expect(kept.mrfSeq).toBe(50);
    expect(kept.accounts).toEqual([]);
  });
});
