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
 * once a newer one has had two minutes to reach the disk. When a newer copy was torn the phone says so.
 *
 * The phone is made up here: its files are a map, kept as expo-file-system keeps them on Android (a move over a
 * file deletes that file, then renames; a rename keeps what a file holds and when it was written), with the time
 * each was written; its AsyncStorage rows are another map, and on the iPhone a manifest of their keys, as
 * RNCAsyncStorage keeps one.
 */
type Os = 'android' | 'ios';
type Storage = typeof import('../storage');
type UseStore = typeof import('../../store/useStore')['useStore'];

const FILES = 'file:///data/user/0/com.minemuster.app/files/';
const KEY = 'us-mine-crew-records';
const SESSION = 'minemuster-server-session';
/** On the iPhone, the mark that records are kept under KEY. */
const MARK = `${KEY}:on-this-phone`;
/** A file of the records, by its full address on the phone. */
const file = (end = '') => `${FILES}${KEY}.json${end}`;
/** A checkpoint of the records, by its place. */
const checkpoint = (order: number) => `${FILES}${KEY}.cp-${order}.json`;

/** The made-up clock's start, and a minute on it. */
const T0 = 1_800_000_000_000;
const MIN = 60_000;

interface Trouble {
  /** Files that cannot be read, by name. */
  unreadable?: Set<string>;
  /** AsyncStorage rows that cannot be read, as a row over 2 MB cannot on Android. */
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
  /** When each file was written, by its address. A file with none was written long ago. */
  times: Map<string, number>;
  rows: Map<string, string>;
  trouble: Trouble;
  /** What was done to the files and rows, in order. */
  log: string[];
  /** On the iPhone, the keys in AsyncStorage's manifest on the disk; until it is written, every row's. */
  manifest?: Set<string>;
  /** The AsyncStorage the app last loaded on this phone. */
  instance?: { setItem(key: string, value: string): Promise<void> };
}

const device = (disk = new Map<string, string>(), rows = new Map<string, string>(), trouble: Trouble = {}, times = new Map<string, number>()): Device => ({
  disk,
  times,
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

/** The phone's clock, from T0: Date.now reads it, and each file is dated by it as it is written. */
function clockAt(start = T0) {
  let now = start;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    get now() {
      return now;
    },
    pass(ms: number) {
      now += ms;
    },
  };
}
afterEach(() => jest.restoreAllMocks());

/** Load a module as the app loads it on this phone, with this phone's files and rows. */
function onPhone<T>(os: Os, dev: Device, path: string): T {
  const { disk, times, rows, trouble, log } = dev;
  const name = (uri: string) => uri.slice(FILES.length);
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
  /** A file's time goes where the file goes. */
  const carry = (from: string, to: string) => {
    const at = times.get(from);
    times.delete(from);
    if (at === undefined) times.delete(to);
    else times.set(to, at);
  };
  class Directory {
    constructor(readonly uri: string) {}
    list() {
      return [...disk.keys()].filter((uri) => uri.startsWith(this.uri) && !uri.slice(this.uri.length).includes('/')).map((uri) => new File(uri));
    }
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).reduce((a, b) => `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`);
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
      if (trouble.unreadable?.has(name(this.uri))) throw new Error('read failed');
      const kept = disk.get(this.uri);
      if (kept === undefined) throw new Error('no such file');
      return kept;
    }
    async write(content: string) {
      const killed = change();
      log.push(`write ${name(this.uri)}`);
      times.set(this.uri, Date.now());
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
    }
  }
  // On the iPhone, as RNCAsyncStorage keeps them: a manifest of the keys, read from the disk when the app loads it
  // and written back after a change. A value whose file it cannot read is taken off the manifest it holds.
  const manifest = new Set(dev.manifest ?? rows.keys());
  const writeManifest = () => {
    if (os === 'ios') dev.manifest = new Set(manifest);
  };
  const asyncStorage = {
    getItem: jest.fn(async (key: string) => {
      log.push(`read row ${key}`);
      if (os === 'ios' && !manifest.has(key)) return null;
      if (trouble.rowUnreadable?.has(key)) {
        manifest.delete(key);
        throw new Error(os === 'ios' ? 'Failed to read storage file.' : 'Row too big to fit into CursorWindow');
      }
      return rows.get(key) ?? null;
    }),
    setItem: jest.fn(async (key: string, value: string) => {
      if (trouble.rowFull) throw new Error('database or disk is full (code 13 SQLITE_FULL)');
      rows.set(key, value);
      manifest.add(key);
      writeManifest();
    }),
    removeItem: jest.fn(async (key: string) => {
      log.push(`remove row ${key}`);
      rows.delete(key);
      manifest.delete(key);
      writeManifest();
    }),
    getAllKeys: jest.fn(async () => {
      log.push('list rows');
      return [...rows.keys()];
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
      },
    }));
    jest.doMock('@react-native-async-storage/async-storage', () => asyncStorage);
    loaded = require(path) as T;
  });
  return loaded!;
}

const storageOn = (os: Os, dev = device()) => ({ ...onPhone<Storage>(os, dev, '../storage'), ...dev });

/** Let every save and read under way finish. */
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

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

/** A power cut now: whatever was written since `since` did not reach the disk whole. */
function tearSince(dev: Device, since: number) {
  for (const [uri, text] of dev.disk) {
    if ((dev.times.get(uri) ?? 0) > since) dev.disk.set(uri, text.slice(0, Math.floor(text.length / 2)));
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
    const dev = device(new Map([[file('.next'), half(value(3))], [file(), value(2)], [file('.prev'), value(1)]]));
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(2));
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(4));
    // The file read is kept aside; the copy before it, older than one that has long reached the disk, goes.
    expect(new Map(dev.disk)).toEqual(new Map([[file(), value(4)], [checkpoint(T0), value(2)]]));
  });

  it('a whole new copy beside the file is the newest, and is read', async () => {
    const dev = device(new Map([[file('.next'), value(3)], [file(), value(2)], [file('.prev'), value(1)]]));
    const phone = storageOn('android', dev);
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(3));
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(4));
    expect(new Map(dev.disk)).toEqual(new Map([[file(), value(4)], [checkpoint(T0), value(3)]]));
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
    expect(new Map(dev.disk)).toEqual(new Map([[file(), value(6)], [checkpoint(T0 - 2 * MIN), value(2)]]));
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
    tearSince(dev, clock.now - 2 * MIN);
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
    tearSince(dev, clock.now - 2 * MIN);
    expect(await storageOn('android', reopen(dev)).recordStorage.getItem(KEY)).toBe(value(1));
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
    expect(dev.rows.has(KEY)).toBe(false);
    // No mark for records that were never saved.
    expect(dev.rows.has(MARK)).toBe(false);
    dev.trouble.rowFull = false;
    await phone.recordStorage.setItem(KEY, value(2));
    expect(said).toEqual([true, false]);
    expect(dev.rows.get(KEY)).toBe(value(2));
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
  it('moves the row into the file on the first read, and removes the row only at a later start, once the file is two minutes old', async () => {
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
    // What was just written may not be on the disk yet: the row stays this session, after later saves too.
    phone.recordsRead(KEY);
    await phone.recordStorage.setItem(KEY, value(8));
    expect(dev.rows.get(KEY)).toBe(moved);

    // A start a minute later: the file read was written too lately to be sure it reached the disk.
    clock.pass(MIN);
    const soon = storageOn('android', reopen(dev));
    expect(await soon.recordStorage.getItem(KEY)).toBe(value(8));
    expect(dev.rows.get(KEY)).toBe(moved);

    // Two minutes after it was written, it has: the row goes.
    clock.pass(MIN);
    const later = storageOn('android', reopen(dev));
    expect(await later.recordStorage.getItem(KEY)).toBe(value(8));
    expect(dev.rows.has(KEY)).toBe(false);
    expect(later.log).toEqual([`read ${KEY}.json`, 'list rows', `remove row ${KEY}`]);
    // The server session stays in AsyncStorage.
    expect(dev.rows.get(SESSION)).toBe('tokens');

    // From then on the file is read, and AsyncStorage is never asked for the records.
    const after = storageOn('android', reopen(dev));
    expect(await after.recordStorage.getItem(KEY)).toBe(value(8));
    expect(after.log).toEqual([`read ${KEY}.json`, 'list rows']);
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

  it('on the iPhone, a row that cannot be read is left where it is', async () => {
    const dev = device(new Map(), new Map([[KEY, 'saved']]), { rowUnreadable: new Set([KEY]) });
    const phone = storageOn('ios', dev);
    await expect(phone.recordStorage.getItem(KEY)).rejects.toThrow();
    await phone.recordStorage.setItem(KEY, 'empty');
    await phone.recordStorage.removeItem(KEY);
    expect(dev.rows.get(KEY)).toBe('saved');
  });
});

describe('on the iPhone', () => {
  it('keeps the records in AsyncStorage, where they have always been', async () => {
    const phone = storageOn('ios');
    phone.recordsRead(KEY);
    const big = bigValue();
    await phone.recordStorage.setItem(KEY, big);
    expect(phone.rows.get(KEY)).toBe(big);
    expect(phone.disk.size).toBe(0);
    expect(await phone.recordStorage.getItem(KEY)).toBe(big);
  });

  it('marks that records are kept here once they are saved or read, and not before', async () => {
    const fresh = storageOn('ios');
    expect(await fresh.recordStorage.getItem(KEY)).toBeNull();
    expect(fresh.rows.has(MARK)).toBe(false);
    fresh.recordsRead(KEY);
    await fresh.recordStorage.setItem(KEY, value(1));
    expect(fresh.rows.has(MARK)).toBe(true);

    // A phone that saved its records before there was a mark gets one the first time they are read.
    const older = storageOn('ios', device(new Map(), new Map([[KEY, value(2)]])));
    expect(await older.recordStorage.getItem(KEY)).toBe(value(2));
    expect(older.rows.has(MARK)).toBe(true);
  });

  it('takes the mark off with the records', async () => {
    const phone = storageOn('ios', device(new Map(), new Map([[KEY, value(2)], [MARK, '1']])));
    expect(await phone.recordStorage.getItem(KEY)).toBe(value(2));
    phone.recordsRead(KEY);
    await phone.recordStorage.removeItem(KEY);
    expect(phone.rows.has(KEY)).toBe(false);
    expect(phone.rows.has(MARK)).toBe(false);
    expect(await storageOn('ios', reopen(phone)).recordStorage.getItem(KEY)).toBeNull();
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

/** A phone that has been in use: its records saved, with something of its own in them. */
async function usedPhone(os: Os, dev = device()) {
  const store = storeOn(os, dev);
  await flush();
  expect(store.getState().hydrated).toBe(true);
  store.setState({ mrfSeq: 41 });
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
    const dev = await usedPhone('ios');
    const row = dev.rows.get(KEY)!;
    expect(JSON.parse(row).state.mrfSeq).toBe(41);
    // The same records, as an older version left them on an Android phone, grown past what a row can hand back.
    dev.trouble.rowUnreadable = new Set([KEY]);
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
    const row = dev.rows.get(KEY)!;
    dev.trouble.rowUnreadable = new Set([KEY]);
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(store.getState().hydrated).toBe(false);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(dev.rows.get(KEY)).toBe(row);
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
  // the same session it says there is nothing, and its next change writes the manifest to the disk without it.

  it('Try again, which AsyncStorage answers with nothing, opens nothing and writes nothing', async () => {
    const dev = await usedPhone('ios');
    const row = dev.rows.get(KEY)!;
    dev.trouble.rowUnreadable = new Set([KEY]);
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    // The file could be read now, but this AsyncStorage has forgotten the key.
    dev.trouble.rowUnreadable.clear();
    await store.getState().readRecordsAgain();
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(store.getState().hydrated).toBe(false);
    store.setState({ mrfSeq: 0 });
    await flush();
    expect(dev.rows.get(KEY)).toBe(row);
  });

  it('then a write of the session, and a start with nothing read and the mark there: still not a new phone, and nothing written', async () => {
    const dev = await usedPhone('ios');
    const row = dev.rows.get(KEY)!;
    dev.trouble.rowUnreadable = new Set([KEY]);
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    await dev.instance!.setItem(SESSION, 'tokens');
    expect(dev.manifest!.has(KEY)).toBe(false);

    const again = storeOn('ios', reopen(dev));
    await flush();
    expect(again.getState().recordsUnreadable).toBe(true);
    expect(again.getState().hydrated).toBe(false);
    again.setState({ mrfSeq: 0 });
    await flush();
    expect(dev.rows.get(KEY)).toBe(row);
  });

  it('a read that fails writes nothing when the mark is there, so opening MineMuster again can read them', async () => {
    const dev = await usedPhone('ios');
    dev.trouble.rowUnreadable = new Set([KEY]);
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    // The manifest on the disk still lists the records.
    expect(dev.manifest!.has(KEY)).toBe(true);

    const again = storeOn('ios', reopen(dev));
    await flush();
    expect(again.getState().recordsUnreadable).toBe(false);
    expect(again.getState().hydrated).toBe(true);
    expect(again.getState().mrfSeq).toBe(41);
  });

  it('records saved before there was a mark: a read that fails leaves one, so opening again is not a new phone', async () => {
    const dev = await usedPhone('ios');
    const row = dev.rows.get(KEY)!;
    dev.rows.delete(MARK);
    dev.manifest = new Set(dev.rows.keys());
    dev.trouble.rowUnreadable = new Set([KEY]);
    const store = storeOn('ios', dev);
    await flush();
    expect(store.getState().recordsUnreadable).toBe(true);
    expect(dev.rows.has(MARK)).toBe(true);

    const again = storeOn('ios', reopen(dev));
    await flush();
    expect(again.getState().recordsUnreadable).toBe(true);
    again.setState({ mrfSeq: 0 });
    await flush();
    expect(dev.rows.get(KEY)).toBe(row);
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
    expect(mrfSeqSaved(dev.rows.get(KEY))).toBe(8);
  });
});
