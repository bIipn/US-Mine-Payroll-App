/**
 * How long the records' copies live on an Android phone (storage.native.ts), judged from outside, as a phone is
 * used: what each start reads, how many full copies of the records are on the disk, whether what a clear or a drop
 * took off is still in any file, what a power cut leaves to read, and what the phone says about it
 * (passedOverNewer, dropUndone). Nothing here knows how the storage names or keeps its copies, only that every
 * file of the records begins with the key and that a mark is an empty file: a full copy is any file of the app's
 * files whose name begins with the key and that holds something. Only the disks that earlier builds left (I8) are
 * written here by name.
 *
 * Three clocks are kept apart:
 * - The phone's clock (Date.now, and each file's modificationTime, which it dates the file by when it is written).
 *   It can jump, an hour or more either way (`jump`).
 * - The steady clock (performance.now). It never jumps, stops while the phone sleeps (`sleep`), and goes back near
 *   0 at a reboot (`reboot`, and every power cut). Under `start` it counts from each start of the app instead, as
 *   React Native says it may one day. The rules count on `boot`, the way React Native 0.88 counts it, and
 *   steadyClock.test.ts fails if that changes: under `start` a start that first reads the clock 10 s or more in can
 *   take copies an earlier start wrote seconds before for settled. The tests of what must never happen run under
 *   both where a start reads it in under 10 s, as these do; those of what must be done in time across short starts
 *   run under `boot`, since under `start` no short start can ever know a copy has settled.
 * - The test's own timeline (`real`), and the phone's awake time over every boot (`awake`). A power cut goes by
 *   these: it tears every file written in its window (half of what it held is left), the kernel's writeback stopping
 *   in sleep as the steady clock does. A clean reboot puts everything on the disk first, so no cut tears what was
 *   written before one; a cut is a reboot too, and what it left is on the disk from then on.
 *
 * The invariants, by number (I1 to I10), are those of round 5 of the Android records work:
 * I1 at most about 5 full copies after any save or start; I2 a power cut opens on a whole copy no older than it may;
 * I3 settling never goes by the phone's clock alone; I4 the save that replaces the file keeps it aside when what it
 * holds is a minute old by either clock; I5 a clear; I6 a drop, and dropUndone; I7 an older version's AsyncStorage
 * row; I8 the files earlier builds left; I9 one write of the records per save; I10 the iPhone as before.
 */

type Os = 'android' | 'ios';
/** How the steady clock counts: from the phone's boot (React Native 0.88), or from each start of the app. */
type Meaning = 'boot' | 'start';
type Api = typeof import('../storage');
type Forgetting = 'clear' | 'drop';

/** The app's files on Android, the only folder the records are kept in. */
const FILES = 'file:///data/user/0/com.minemuster.app/files/';
/** The app's cache folder (Paths.cache). The iPhone's storage looks beside it for AsyncStorage's own folder. */
const CACHE = 'file:///data/user/0/com.minemuster.app/cache/';
const KEY = 'us-mine-crew-records';
const SESSION = 'minemuster-server-session';

const MIN = 60_000;
/** The phone's clock when a test starts. */
const T0 = 1_800_000_000_000;
/** The steady clock when a test starts, under `boot`: the phone has been on about two hours. */
const S0 = 7_000_000;
/** The steady clock when the app first reads after a reboot, under `boot`. */
const BOOT_STEADY = 12_000;
/** How long a reboot takes, on the phone's clock and the test's timeline. */
const REBOOT_MS = 20_000;
/** Written so long ago that no cut tears it. */
const LONG_AGO = -1e15;

/** I1: the file, the copy beside it, and at most 3 checkpoints. */
const MAX_COPIES = 5;
/** A copy has settled on the disk two minutes of awake time after it was written. */
const SETTLE_MS = 2 * MIN;
/** I2: "a minute or more before the torn window": a minute, and a save or two besides. */
const SLACK_MS = 90_000;
/** I5, I6, I7: what must go goes within about 2 minutes of awake time: two minutes, and one more short start. */
const DEADLINE_MS = SETTLE_MS + 45_000;

const MEANINGS: { meaning: Meaning; from: string }[] = [
  { meaning: 'boot', from: 'steady clock from boot' },
  { meaning: 'start', from: 'steady clock from app start' },
];

// ---- The records saved ----------------------------------------------------------------------------------------

/** What marks one save, inside its records: no other save holds it, and an escaped copy of them still does. */
const tagOf = (n: number) => `@save-${String(n).padStart(6, '0')}@`;
/** The records as the n-th save holds them. */
const value = (n: number, extra: Record<string, unknown> = {}) => JSON.stringify({ state: { mrfSeq: n, tag: tagOf(n), ...extra }, version: 10 });
/** The save a copy of the records is, by its tag, or null. */
const numberIn = (text: string | null): number | null => {
  const found = text === null ? null : /@save-(\d+)@/.exec(text);
  return found ? Number(found[1]) : null;
};
/** One person's hourly rate, which a drop takes off the phone. Nothing else spells it. */
const RATE = '@hourly-rate-98765@';
/** Records a clear empties the phone of. Nothing else spells it. */
const CLEARED = '@cleared-records-4242@';
const withRate = (n: number) => value(n, { payRates: { 'emp-1': RATE } });
const withCleared = (n: number) => value(n, { note: CLEARED });
/** What an emptied phone saves. */
const emptied = (n: number) => value(n, { emptied: true });

const isWhole = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};
const half = (text: string) => text.slice(0, Math.floor(text.length / 2));

// ---- The clocks -----------------------------------------------------------------------------------------------

interface Clock {
  meaning: Meaning;
  /** The phone's clock: Date.now. */
  wall: number;
  /** The steady clock: performance.now. */
  steady: number;
  /** The test's own timeline. */
  real: number;
  /** The phone's awake time, over every boot. */
  awake: number;
  /** On the test's timeline, when the phone last woke or booted. */
  wokeAt: number;
  /** The awake time then. */
  awakeAtWake: number;
  /** On the test's timeline, when everything written so far was last put on the disk: a clean reboot, or a power cut. */
  syncedAt: number;
}

const newClock = (meaning: Meaning): Clock => ({
  meaning,
  wall: T0,
  steady: meaning === 'boot' ? S0 : 0,
  real: 0,
  awake: 0,
  wokeAt: 0,
  awakeAtWake: 0,
  syncedAt: LONG_AGO,
});

/** The clocks the phone reads now: Date.now and performance.now read this. A test with a phone sets it. */
let clock: Clock = newClock('boot');

/** A reboot, on these clocks: everything is on the disk, and the steady clock starts again. */
function rebooted(c: Clock): void {
  c.wall += REBOOT_MS;
  c.real += REBOOT_MS;
  c.awake += REBOOT_MS;
  c.steady = c.meaning === 'boot' ? BOOT_STEADY : 0;
  c.wokeAt = c.real;
  c.awakeAtWake = c.awake;
  c.syncedAt = c.real;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['Date', 'performance', 'hrtime', 'nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'] });
  clock = newClock('boot');
  jest.spyOn(Date, 'now').mockImplementation(() => clock.wall);
  jest.spyOn(performance, 'now').mockImplementation(() => clock.steady);
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Let every read and save under way finish. Not on a timer, so that it works while the timers are made up. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

// ---- The phone's disk -----------------------------------------------------------------------------------------

/** When what a file holds was written: by the phone's clock (its modificationTime), in awake time, on the timeline. */
interface Stamp {
  wall: number;
  awake: number;
  real: number;
}

interface Device {
  /** The app's files, by path inside FILES. */
  disk: Map<string, string>;
  /** When each file was written. A file with none was written long ago. */
  stamps: Map<string, Stamp>;
  /** Folders made inside FILES, by path ending in a slash. */
  dirs: Set<string>;
  /** AsyncStorage's rows, by key. */
  rows: Map<string, string>;
  /** Every write of a file, in order: its path and how many characters that write put in it. */
  writes: { name: string; size: number }[];
}

const newDevice = (): Device => ({ disk: new Map(), stamps: new Map(), dirs: new Set(), rows: new Map(), writes: [] });

/** The same phone's disk, as a power cut finds it: what is on it, and nothing of what the app has in memory. */
const cloneDevice = (dev: Device): Device => ({
  disk: new Map(dev.disk),
  stamps: new Map(dev.stamps),
  dirs: new Set(dev.dirs),
  rows: new Map(dev.rows),
  writes: [],
});

/** The files of the records that hold something: every full copy of them on the disk. */
const fullCopies = (dev: Device) => [...dev.disk].filter(([name, text]) => name.startsWith(KEY) && text.length > 0).map(([name]) => name);
/** Files that do not begin with the key: there are none, since every file of the records begins with it. */
const strays = (dev: Device) => [...dev.disk.keys()].filter((name) => !name.startsWith(KEY));
/** The files of the records that hold nothing: marks. */
const emptyFiles = (dev: Device) => [...dev.disk].filter(([name, text]) => name.startsWith(KEY) && text.length === 0).map(([name]) => name);
/** The files that hold this text anywhere in them. */
const filesHolding = (dev: Device, text: string) => [...dev.disk].filter(([, kept]) => kept.includes(text)).map(([name]) => name);

/** A power cut: every file written in its window keeps only half of what it held. A mark holds nothing to tear. */
function tear(dev: Device, torn: (stamp: Stamp) => boolean): void {
  for (const [name, text] of dev.disk) {
    const stamp = dev.stamps.get(name);
    if (stamp && torn(stamp) && text.length > 0) dev.disk.set(name, half(text));
  }
}

/**
 * expo-file-system as it is on Android (58.0.14), over this disk: File.write streams the text and closes with no
 * fsync; a move over a file deletes that file, then renames; a rename refuses to overwrite and keeps what the file
 * holds and when it was written; a copy is a new file, written now. Each file is dated by the phone's clock as it
 * is written. Only the app's files are there: a folder elsewhere does not exist.
 */
function fileSystemOn(dev: Device) {
  const stampNow = (): Stamp => ({ wall: clock.wall, awake: clock.awake, real: clock.real });
  const relOf = (uri: string): string | null => (uri.startsWith(FILES) ? uri.slice(FILES.length) : null);
  const fileOf = (uri: string): string => {
    const rel = relOf(uri);
    if (rel === null || rel === '' || rel.endsWith('/')) throw new Error(`No such file in the app's files: ${uri}`);
    return rel;
  };
  /** As Paths.join does: a part after the first is put in a URI's form, a space as %20. */
  const joined = (parts: (string | { uri: string })[]) =>
    parts
      .map((p, i) => (typeof p !== 'string' ? p.uri : i === 0 ? p : p.replace(/ /g, '%20')))
      .reduce((a, b) => `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`);
  const carry = (from: string, to: string) => {
    dev.disk.set(to, dev.disk.get(from)!);
    dev.disk.delete(from);
    const stamp = dev.stamps.get(from);
    dev.stamps.delete(from);
    if (stamp) dev.stamps.set(to, stamp);
    else dev.stamps.delete(to);
  };
  const decode = (content: string | Uint8Array | ArrayBuffer) =>
    typeof content === 'string' ? content : new TextDecoder().decode(content instanceof ArrayBuffer ? new Uint8Array(content) : content);

  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = `${joined(parts).replace(/\/+$/, '')}/`;
    }
    get name() {
      const trimmed = this.uri.replace(/\/$/, '');
      return trimmed.slice(trimmed.lastIndexOf('/') + 1);
    }
    get parentDirectory() {
      return new Directory(this.uri.replace(/[^/]+\/$/, ''));
    }
    get exists() {
      if (this.uri === CACHE) return true;
      const rel = relOf(this.uri);
      if (rel === null) return false;
      return rel === '' || dev.dirs.has(rel) || [...dev.disk.keys()].some((name) => name.startsWith(rel));
    }
    create() {
      const rel = relOf(this.uri);
      if (rel) dev.dirs.add(rel);
    }
    delete() {
      const rel = relOf(this.uri);
      if (!rel) throw new Error(`Cannot delete ${this.uri}`);
      for (const name of [...dev.disk.keys()]) if (name.startsWith(rel)) dev.disk.delete(name);
      for (const dir of [...dev.dirs]) if (dir.startsWith(rel)) dev.dirs.delete(dir);
    }
    /** What is in it, files and folders. */
    list(): (File | Directory)[] {
      if (!this.exists) throw new Error(`No such directory: ${this.uri}`);
      const rel = relOf(this.uri);
      if (rel === null) return [];
      const inside = new Map<string, boolean>();
      for (const name of [...dev.disk.keys(), ...dev.dirs]) {
        if (!name.startsWith(rel) || name === rel) continue;
        const rest = name.slice(rel.length);
        const slash = rest.indexOf('/');
        const entry = slash < 0 ? rest : rest.slice(0, slash);
        inside.set(entry, (inside.get(entry) ?? false) || slash >= 0);
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
    get extension() {
      const dot = this.name.lastIndexOf('.');
      return dot < 0 ? '' : this.name.slice(dot);
    }
    get parentDirectory() {
      return new Directory(this.uri.slice(0, this.uri.lastIndexOf('/') + 1));
    }
    get exists() {
      const rel = relOf(this.uri);
      return rel !== null && dev.disk.has(rel);
    }
    get size() {
      const rel = relOf(this.uri);
      return (rel === null ? undefined : dev.disk.get(rel))?.length ?? 0;
    }
    get modificationTime() {
      const rel = relOf(this.uri);
      return rel !== null && dev.disk.has(rel) ? (dev.stamps.get(rel)?.wall ?? 0) : null;
    }
    info() {
      const rel = relOf(this.uri);
      if (rel === null || !dev.disk.has(rel)) return { exists: false, uri: this.uri };
      const wall = dev.stamps.get(rel)?.wall ?? 0;
      return { exists: true, uri: this.uri, size: dev.disk.get(rel)!.length, modificationTime: wall, creationTime: wall };
    }
    textSync(): string {
      const rel = relOf(this.uri);
      const text = rel === null ? undefined : dev.disk.get(rel);
      if (text === undefined) throw new Error(`No such file: ${this.uri}`);
      return text;
    }
    async text() {
      return this.textSync();
    }
    bytesSync() {
      return new TextEncoder().encode(this.textSync());
    }
    async bytes() {
      return this.bytesSync();
    }
    async json() {
      return JSON.parse(this.textSync()) as unknown;
    }
    writeSync(content: string | Uint8Array | ArrayBuffer, options: { append?: boolean } = {}) {
      const rel = fileOf(this.uri);
      const text = decode(content);
      dev.disk.set(rel, (options.append ? (dev.disk.get(rel) ?? '') : '') + text);
      dev.stamps.set(rel, stampNow());
      dev.writes.push({ name: rel, size: text.length });
    }
    async write(content: string | Uint8Array | ArrayBuffer, options?: { append?: boolean }) {
      this.writeSync(content, options);
    }
    create(options: { overwrite?: boolean } = {}) {
      const rel = fileOf(this.uri);
      if (dev.disk.has(rel) && !options.overwrite) throw new Error(`File already exists: ${this.uri}`);
      dev.disk.set(rel, '');
      dev.stamps.set(rel, stampNow());
      dev.writes.push({ name: rel, size: 0 });
    }
    delete() {
      const rel = fileOf(this.uri);
      if (!dev.disk.delete(rel)) throw new Error(`No such file: ${this.uri}`);
      dev.stamps.delete(rel);
    }
    private target(to: File | Directory): string {
      return fileOf(to instanceof Directory ? `${to.uri}${this.name}` : to.uri);
    }
    copySync(to: File | Directory, options: { overwrite?: boolean } = {}) {
      const from = fileOf(this.uri);
      const target = this.target(to);
      const text = dev.disk.get(from);
      if (text === undefined) throw new Error(`No such file: ${this.uri}`);
      if (dev.disk.has(target) && !options.overwrite) throw new Error(`Destination exists: ${target}`);
      dev.disk.set(target, text);
      dev.stamps.set(target, stampNow());
      dev.writes.push({ name: target, size: text.length });
    }
    async copy(to: File | Directory, options?: { overwrite?: boolean }) {
      this.copySync(to, options);
    }
    // As on Android (CopyMoveStrategy.LocalFile): a move over a file deletes that file, then renames.
    moveSync(to: File | Directory, options: { overwrite?: boolean } = {}) {
      const from = fileOf(this.uri);
      const target = this.target(to);
      if (!dev.disk.has(from)) throw new Error(`No such file: ${this.uri}`);
      if (target === from) return;
      if (dev.disk.has(target)) {
        if (!options.overwrite) throw new Error(`Destination exists: ${target}`);
        dev.disk.delete(target);
        dev.stamps.delete(target);
      }
      carry(from, target);
      this.uri = `${FILES}${target}`;
    }
    async move(to: File | Directory, options?: { overwrite?: boolean }) {
      this.moveSync(to, options);
    }
    // As on Android (FileSystemPath.rename: Path.moveTo, no overwrite): one rename, all or nothing.
    rename(newName: string) {
      const from = fileOf(this.uri);
      const target = `${from.slice(0, from.lastIndexOf('/') + 1)}${newName}`;
      if (!dev.disk.has(from)) throw new Error(`No such file: ${this.uri}`);
      if (dev.disk.has(target)) throw new Error('FileAlreadyExistsException');
      carry(from, target);
      this.uri = `${FILES}${target}`;
    }
  }

  const Paths = {
    get document() {
      return new Directory(FILES);
    },
    get cache() {
      return new Directory(CACHE);
    },
    get totalDiskSpace() {
      return 64_000_000_000;
    },
    get availableDiskSpace() {
      return 32_000_000_000;
    },
    info(...uris: string[]) {
      const uri = joined(uris);
      const asFile = new File(uri).exists;
      const asDirectory = !asFile && new Directory(uri).exists;
      return { exists: asFile || asDirectory, isDirectory: asDirectory };
    },
    join: (...parts: (string | { uri: string })[]) => joined(parts),
    basename: (path: string) => path.replace(/\/+$/, '').slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1),
    dirname: (path: string) => path.replace(/\/+$/, '').replace(/\/[^/]*$/, ''),
    extname: (path: string) => /\.[^./]*$/.exec(path)?.[0] ?? '',
  };
  return { File, Directory, Paths };
}

/** AsyncStorage over this phone's rows. */
function asyncStorageOn(dev: Device) {
  return {
    getItem: async (key: string) => dev.rows.get(key) ?? null,
    setItem: async (key: string, text: string) => {
      dev.rows.set(key, text);
    },
    removeItem: async (key: string) => {
      dev.rows.delete(key);
    },
    getAllKeys: async () => [...dev.rows.keys()],
    multiGet: async (keys: readonly string[]) => keys.map((key) => [key, dev.rows.get(key) ?? null] as const),
    multiSet: async (pairs: readonly (readonly [string, string])[]) => {
      for (const [key, text] of pairs) dev.rows.set(key, text);
    },
    multiRemove: async (keys: readonly string[]) => {
      for (const key of keys) dev.rows.delete(key);
    },
    clear: async () => {
      dev.rows.clear();
    },
  };
}

/** storage.native.ts as the app loads it at a start, on this phone. Each call is a new start of the app. */
function load(os: Os, dev: Device): Api {
  let api: Api | undefined;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: os } }));
    jest.doMock('expo-file-system', () => fileSystemOn(dev));
    jest.doMock('@react-native-async-storage/async-storage', () => asyncStorageOn(dev));
    api = require('../storage') as Api;
  });
  return api!;
}

/**
 * dropUndone(key), which F5 adds: whether the copy the last read took is older than a drop that is on the phone's
 * disk, so the store does the drop again. Reached through the module, so that a build without it fails only the
 * tests that ask for it.
 */
function dropUndoneOf(api: Api): (key: string) => boolean {
  const found = (api as unknown as Record<string, unknown>).dropUndone;
  if (typeof found !== 'function') throw new Error('storage.native.ts has no dropUndone(key) export (F5): the store is never told that a power cut undid a drop.');
  return found as (key: string) => boolean;
}
/** dropUndone(key) when the build has it; undefined when not, for the tests that only check it where it is. */
function dropUndoneIfThere(api: Api): boolean | undefined {
  const found = (api as unknown as Record<string, unknown>).dropUndone;
  return typeof found === 'function' ? (found as (key: string) => boolean)(KEY) : undefined;
}

// ---- A power cut ----------------------------------------------------------------------------------------------

/**
 * A power cut's window: every file written in the last `ms` of awake time (`awake`), or, after a sleep, every one
 * written since the phone woke (`wake`). Never what a clean reboot or an earlier cut put on the disk.
 */
type Cut = { kind: 'awake'; ms: number } | { kind: 'wake' };
const lastAwake = (ms = SETTLE_MS): Cut => ({ kind: 'awake', ms });
const sinceWake: Cut = { kind: 'wake' };

function tornBy(cut: Cut, c: Clock): (stamp: Stamp) => boolean {
  return (stamp) => stamp.real > c.syncedAt && (cut.kind === 'awake' ? stamp.awake > c.awake - cut.ms : stamp.real >= c.wokeAt);
}

/** One save the store made: what it saved, and when, by every clock. */
interface Save extends Stamp {
  n: number;
  text: string;
}

/**
 * The known limit (AGENTS.md): after a start of the phone that the next start of the app cannot see on the steady clock,
 * a power cut that tears the last two minutes of awake time can open on a copy up to this many saves older than owed,
 * always whole and with the notice. Measured on the rules of round 6: 2 of 54 randomized runs of 200 short starts with
 * sleeps, reboots and jumps of an hour either way, a power cut tried after their saves (round 5's judge), and 3 of 120
 * more (seeds 1000 to 1039, 2000 to 2039 and 3000 to 3039, round 5's review), the copy opened on at most 4 saves
 * (seed 3012) and 206 s of awake time (seed 1029) older than owed, and up to 140 minutes older in real time, the phone
 * asleep between (seed 3012).
 */
const UNSEEN_REBOOT_SAVES = 4;

/**
 * I2: the newest save a cut may not go further back than, or null when it may open on nothing: the newest save made
 * a minute or more (SLACK_MS) before the first save the cut tore, in awake time, or, for a cut since waking, by the
 * phone's clock as well, so that an hour asleep never loses what was saved before it. With nothing torn, the last
 * save. Saves before `floor` (a clear) are never owed.
 *
 * The rules miss this in one case, which AGENTS.md names and (f) of I2 meets: a start of the phone that the next start
 * of the app cannot see on the steady clock (it first reads the records past the time of the last copy before it),
 * while the five copies are kept for other reasons (UNSEEN_REBOOT_SAVES).
 */
function owed(saves: readonly Save[], torn: (stamp: Stamp) => boolean, cut: Cut, floor: number): number | null {
  const live = saves.filter((s) => s.n >= floor);
  const tornSaves = live.filter(torn);
  if (tornSaves.length === 0) return live.length > 0 ? live[live.length - 1].n : null;
  const firstAwake = Math.min(...tornSaves.map((s) => s.awake));
  const firstWall = Math.min(...tornSaves.map((s) => s.wall));
  let most: number | null = null;
  for (const s of live) {
    if (torn(s)) continue;
    const byAwake = s.awake <= firstAwake - SLACK_MS;
    const byClock = cut.kind === 'wake' && s.wall <= firstWall - SLACK_MS;
    if (byAwake || byClock) most = most === null ? s.n : Math.max(most, s.n);
  }
  return most;
}

/** What a start read: the records handed to the store, or the error a read that fails throws, and what it said. */
interface Opened {
  read: string | null;
  error: unknown;
  passedOver: boolean;
  api: Api;
}

interface AfterCut extends Opened {
  cut: Cut;
  /** The newest save it may not go further back than (`owed`), or null. */
  owed: number | null;
  /** The last save made before the cut. */
  last: Save | undefined;
  /** What dropUndone said, when the build has it. */
  dropUndone: boolean | undefined;
  /** The disk as the cut left it, before the start that read it. */
  disk: string[];
}

// ---- A phone in use -------------------------------------------------------------------------------------------

/**
 * A phone, used as the store uses its records: each start reads them (getItem) and, when it can make sense of what it
 * read, says so (recordsRead) and saves from then on; clears and drops say so first (forgetCopies). It notes what was
 * saved and when, and counts the full copies on the disk after every start and save (I1) and the writes of the
 * records each save makes (I9).
 */
class Phone {
  readonly dev: Device;
  readonly clock: Clock;
  readonly os: Os;
  /** The running app's storage, or null while the app is closed. */
  api: Api | null = null;
  /** Every save, in order, and the records the phone held before it was first used here (`older`). */
  readonly saves: Save[] = [];
  /** The number the next save takes. */
  counter = 0;
  /** The first save after the latest clear: nothing before it may be read again. */
  floor = 0;
  private clearing = false;
  starts = 0;
  /** After every start and save: how many full copies were on the disk, and which. */
  readonly copies: { step: string; count: number; names: string[] }[] = [];
  /** Files seen that do not begin with the key. */
  readonly strays = new Set<string>();
  /** Writes that put records in a file (non-empty writes), by step: each save, each start, and time passing. */
  readonly dataWrites: { step: string; count: number }[] = [];

  constructor(meaning: Meaning, dev: Device = newDevice(), os: Os = 'android') {
    this.clock = newClock(meaning);
    clock = this.clock;
    this.dev = dev;
    this.os = os;
  }

  get last(): Save | undefined {
    return this.saves[this.saves.length - 1];
  }

  /** Records that were on the phone before this test used it: a placed file or an older version's row. Never torn. */
  older(n: number, text: string): void {
    this.saves.push({ n, text, wall: LONG_AGO, awake: LONG_AGO, real: LONG_AGO });
    this.counter = Math.max(this.counter, n);
  }

  private dataSince(before: number): number {
    return this.dev.writes.slice(before).filter((w) => w.size > 0).length;
  }

  private count(step: string): void {
    const names = fullCopies(this.dev);
    this.copies.push({ step, count: names.length, names });
    for (const name of strays(this.dev)) this.strays.add(name);
  }

  /** The app starts: a new load of the storage, and the store's read. */
  async start(): Promise<Opened> {
    this.close();
    if (this.clock.meaning === 'start') this.clock.steady = 0;
    const before = this.dev.writes.length;
    const api = load(this.os, this.dev);
    this.api = api;
    let read: string | null = null;
    let error: unknown;
    try {
      read = (await api.recordStorage.getItem(KEY)) ?? null;
    } catch (thrown) {
      error = thrown ?? new Error('read failed');
    }
    await flush();
    // The store says it has read them only when it could make sense of them (useStore's onRehydrateStorage).
    if (error === undefined && (read === null || isWhole(read))) api.recordsRead(KEY);
    this.starts++;
    this.dataWrites.push({ step: `start ${this.starts}`, count: this.dataSince(before) });
    this.count(`start ${this.starts}`);
    return { read, error, passedOver: api.passedOverNewer(KEY), api };
  }

  /** The store saves the records, as `make` makes them with the next number. */
  async save(make: (n: number) => string = value): Promise<Save> {
    if (!this.api) throw new Error('The app is not running.');
    const n = ++this.counter;
    const text = make(n);
    const save: Save = { n, text, wall: this.clock.wall, awake: this.clock.awake, real: this.clock.real };
    this.saves.push(save);
    if (this.clearing) {
      this.floor = n;
      this.clearing = false;
    }
    const before = this.dev.writes.length;
    await this.api.recordStorage.setItem(KEY, text);
    await flush();
    this.dataWrites.push({ step: `save ${n}`, count: this.dataSince(before) });
    this.count(`save ${n} (start ${this.starts})`);
    return save;
  }

  /** The store is about to empty the phone or take one person's records off it (a drop names their account), as it says just before that save. */
  forget(how: Forgetting, id?: string): void {
    if (!this.api) throw new Error('The app is not running.');
    this.api.forgetCopies(KEY, how, id);
    if (how === 'clear') this.clearing = true;
  }

  /** The app is open and the phone awake: every clock moves on, and the app's timers run. */
  async pass(ms: number): Promise<void> {
    const before = this.dev.writes.length;
    for (let left = ms; left > 0; ) {
      const step = Math.min(left, 1_000);
      left -= step;
      this.clock.wall += step;
      this.clock.real += step;
      this.clock.steady += step;
      this.clock.awake += step;
      if (this.api) await jest.advanceTimersByTimeAsync(step);
    }
    await flush();
    this.dataWrites.push({ step: `time passing after start ${this.starts}`, count: this.dataSince(before) });
  }

  /** The app is closed (swiped away, or killed): it goes, and its timers with it. What it saved stays. */
  close(): void {
    if (!this.api) return;
    jest.clearAllTimers();
    this.api = null;
  }

  /** The app closed and the phone awake: every clock moves on. */
  idle(ms: number): void {
    this.close();
    this.clock.wall += ms;
    this.clock.real += ms;
    this.clock.steady += ms;
    this.clock.awake += ms;
  }

  /** The phone asleep, the app open or not: the steady clock stops, and nothing runs. */
  sleep(ms: number): void {
    this.clock.wall += ms;
    this.clock.real += ms;
    this.clock.wokeAt = this.clock.real;
    this.clock.awakeAtWake = this.clock.awake;
  }

  /** The phone is turned off and on again: the app is closed, everything is on the disk, the steady clock starts again. */
  reboot(): void {
    this.close();
    rebooted(this.clock);
  }

  /** The phone's clock alone moves: network time setting it right, or someone setting the date by hand. */
  jump(ms: number): void {
    this.clock.wall += ms;
  }

  /** The power goes now: what was written in the cut's window is torn, the app is gone, and the phone boots again. */
  powerCut(cut: Cut): void {
    tear(this.dev, tornBy(cut, this.clock));
    this.close();
    rebooted(this.clock);
  }

  /**
   * Had the power gone now: the phone's disk as the cut would leave it, read by the start after it, on a copy of the
   * phone; this phone goes on as if nothing had happened.
   */
  async cutAndRead(cut: Cut): Promise<AfterCut> {
    const torn = tornBy(cut, this.clock);
    const dev = cloneDevice(this.dev);
    tear(dev, torn);
    const disk = [...dev.disk].map(([name, text]) => `${name}${text.length === 0 ? ' (empty)' : isWhole(text) ? '' : ' (torn)'}`);
    const live = clock;
    const after: Clock = { ...live };
    rebooted(after);
    clock = after;
    try {
      const api = load('android', dev);
      let read: string | null = null;
      let error: unknown;
      try {
        read = (await api.recordStorage.getItem(KEY)) ?? null;
      } catch (thrown) {
        error = thrown ?? new Error('read failed');
      }
      await flush();
      return { read, error, passedOver: api.passedOverNewer(KEY), api, cut, owed: owed(this.saves, torn, cut, this.floor), last: this.last, dropUndone: dropUndoneIfThere(api), disk };
    } finally {
      clock = live;
    }
  }

  /**
   * I2, for a cut now: the start after it reads, never a read that fails (Records not read) nor torn text; it opens on
   * one of the saves, never on one from before a clear, and never further back than it may (`owed`); and it says it
   * shut off while saving exactly when it did not open on the last save. A cut since waking is tried only when the
   * phone has slept or booted less than two minutes of awake time ago.
   */
  async expectDurable(label: string, options: { passedOver?: boolean } = {}): Promise<AfterCut[]> {
    const cuts: Cut[] = [lastAwake()];
    if (this.clock.wokeAt > 0 && this.clock.awake - this.clock.awakeAtWake < SETTLE_MS) cuts.push(sinceWake);
    const results: AfterCut[] = [];
    for (const cut of cuts) {
      const after = await this.cutAndRead(cut);
      expectReadAfterCut(after, this, `${label}, cut ${cut.kind === 'awake' ? `tearing the last ${cut.ms / 1000} s awake` : 'tearing what was written since waking'}`, options);
      results.push(after);
    }
    return results;
  }

  /** I1: never more than MAX_COPIES full copies after any start or save, and no file that does not begin with the key. */
  expectBounded(): void {
    if (this.strays.size > 0) throw new Error(`Every file of the records begins with the key; these do not: ${[...this.strays].join(', ')}`);
    const worst = this.copies.reduce((a, b) => (b.count > a.count ? b : a), { step: 'nothing', count: 0, names: [] as string[] });
    if (worst.count > MAX_COPIES) {
      const counts = this.copies.map((c) => c.count);
      const names = worst.names.length > 8 ? [...worst.names.slice(0, 8), `and ${worst.names.length - 8} more`] : worst.names;
      throw new Error(
        `I1: ${worst.count} full copies of the records on the disk after ${worst.step}; at most ${MAX_COPIES} may be.\n` +
          `Full copies after each start and save${counts.length > 80 ? ' (the first 80)' : ''}: ${counts.slice(0, 80).join(',')}\nFiles then: ${names.join(', ')}`,
      );
    }
  }
}

function expectReadAfterCut(after: AfterCut, phone: Phone, label: string, options: { passedOver?: boolean } = {}): void {
  const fail = (why: string) => {
    throw new Error(
      `I2 (${label}): ${why}\nRead: ${after.read === null ? 'null' : (numberIn(after.read) ?? 'not a save')}; owed: ${after.owed ?? 'nothing'}; ` +
        `last save: ${after.last?.n ?? 'none'}; passedOverNewer: ${after.passedOver}\nDisk after the cut: ${after.disk.join(', ')}`,
    );
  };
  if (after.error !== undefined) fail(`the start after the cut could not read the records (Records not read): ${String(after.error)}`);
  if (after.read !== null && !isWhole(after.read)) fail('the start after the cut was handed torn text, which the store cannot read (Records not read)');
  if (after.read !== null) {
    const save = phone.saves.find((s) => s.text === after.read);
    if (!save) fail('it opened on records that no save made');
    if (save!.n < phone.floor) fail('it opened on records from before a clear');
    if (after.owed !== null && save!.n < after.owed) fail(`it opened on save ${save!.n}, older than save ${after.owed}, made a minute or more before the torn window`);
  } else if (after.owed !== null) {
    fail(`it opened on nothing, though save ${after.owed} was made a minute or more before the torn window`);
  }
  if (options.passedOver !== false) {
    const expected = after.last !== undefined && after.read !== after.last.text;
    if (after.passedOver !== expected) fail(expected ? 'it did not say it shut off while saving, though the last save was lost' : 'it said it shut off while saving, though it opened on the last save');
  }
}

/** I6, F5, where the build has dropUndone: after a cut, it says the drop was undone exactly when the rate came back. */
function expectDropSaid(after: AfterCut, label: string): void {
  if (after.dropUndone === undefined || after.read === null) return;
  const back = after.read.includes(RATE);
  if (after.dropUndone !== back) throw new Error(`I6 (${label}): dropUndone said ${after.dropUndone}, but the copy read ${back ? 'has' : 'does not have'} the dropped hourly rate in it`);
}

/** A phone used for five minutes, a save every ten seconds, and then closed: its records are on the disk as the storage keeps them. */
async function usedPhone(meaning: Meaning, make: (n: number) => string = value, minutes = 5): Promise<Phone> {
  const phone = new Phone(meaning);
  const first = await phone.start();
  expect(first.read).toBeNull();
  for (let t = 0; t < minutes * MIN; t += 10_000) {
    await phone.save(make);
    await phone.pass(10_000);
  }
  phone.close();
  return phone;
}

/**
 * A short start, under 30 s: the store reads what was saved last, then one save 3 s in and, for two, another 12 s
 * later, and the app is closed 5 s after the last. With `cuts`, a power cut after each save is tried on a copy of the
 * phone (I2).
 */
async function shortStart(phone: Phone, saves: 1 | 2, options: { make?: (n: number) => string; cuts?: boolean; passedOver?: boolean } = {}): Promise<Opened> {
  const expected = phone.last?.text ?? null;
  const opened = await phone.start();
  if (opened.error !== undefined) throw new Error(`Start ${phone.starts} could not read the records: ${String(opened.error)}`);
  if (opened.read !== expected) throw new Error(`Start ${phone.starts} read save ${numberIn(opened.read) ?? opened.read}, not the last save, ${numberIn(expected) ?? expected}`);
  for (let i = 0; i < saves; i++) {
    await phone.pass(i === 0 ? 3_000 : 12_000);
    await phone.save(options.make);
    if (options.cuts) await phone.expectDurable(`start ${phone.starts}, save ${phone.counter}`, { passedOver: options.passedOver });
  }
  await phone.pass(5_000);
  phone.close();
  return opened;
}

/** A pseudo-random sequence that is the same every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

// ---- I1: short starts -----------------------------------------------------------------------------------------

describe('I1: a phone opened for a few seconds at a time keeps a few copies of its records, not one more for every start', () => {
  it('(a) I1 I2: 30 short starts, each under 30 s with 1 or 2 saves, 5 minutes apart awake in one boot: at most 5 full copies after every start and save, each start reads the last save, and a power cut never loses more than it may', async () => {
    const phone = await usedPhone('boot');
    for (let i = 0; i < 30; i++) {
      phone.idle(5 * MIN);
      await shortStart(phone, i % 3 === 0 ? 1 : 2, { cuts: true });
    }
    phone.expectBounded();
  });

  it('(a) I1 I2: 30 short starts, each under 30 s with 1 or 2 saves, the phone asleep 5 minutes between them in one boot: at most 5 full copies, each start reads the last save, and a power cut never loses more than it may', async () => {
    const phone = await usedPhone('boot');
    for (let i = 0; i < 30; i++) {
      phone.sleep(5 * MIN);
      await shortStart(phone, i % 3 === 0 ? 1 : 2, { cuts: true });
    }
    phone.expectBounded();
  });

  it('(b) I1 I2: 40 short starts 5 minutes apart, with a reboot before every sixth and the phone clock jumping an hour forward or back before every other: at most 5 full copies, each start reads the last save, and a power cut never loses more than it may', async () => {
    const phone = await usedPhone('boot');
    for (let i = 0; i < 40; i++) {
      if (i % 6 === 5) phone.reboot();
      phone.idle(5 * MIN);
      if (i % 4 === 1) phone.jump(60 * MIN);
      if (i % 4 === 3) phone.jump(-60 * MIN);
      await shortStart(phone, i % 2 === 0 ? 1 : 2, { cuts: true });
    }
    phone.expectBounded();
  });

  it('(a) I2 I3: 60 short starts with sleeps, idle gaps, reboots and phone-clock jumps, the steady clock counting from each app start, so that no short start can know a copy has settled: each start reads the last save, and a power cut after any save never loses more than it may (no bound on copies here)', async () => {
    const phone = await usedPhone('start');
    for (let i = 0; i < 60; i++) {
      if (i % 9 === 8) phone.reboot();
      if (i % 3 === 0) phone.idle(5 * MIN);
      else phone.sleep(5 * MIN);
      if (i % 7 === 2) phone.jump(60 * MIN);
      if (i % 7 === 5) phone.jump(-60 * MIN);
      await shortStart(phone, i % 2 === 0 ? 1 : 2, { cuts: true });
    }
  });

  it('(b) I1 I2: 200 short starts of 1 or 2 saves each, with sleeps of minutes to hours, idle gaps, the odd reboot and phone-clock jumps of an hour either way: at most 5 full copies, each start reads the last save, and a power cut never loses more than it may', async () => {
    const random = seeded(20261127);
    const phone = await usedPhone('boot');
    for (let i = 0; i < 200; i++) {
      const gap = random();
      if (gap < 0.4) phone.sleep(Math.round(MIN + random() * 8 * 60 * MIN));
      else if (gap < 0.9) phone.idle(Math.round(30_000 + random() * 10 * MIN));
      else {
        phone.reboot();
        phone.idle(Math.round(random() * 5 * MIN));
      }
      const jump = random();
      if (jump < 0.1) phone.jump(60 * MIN);
      else if (jump < 0.2) phone.jump(-60 * MIN);
      await shortStart(phone, random() < 0.5 ? 1 : 2, { cuts: i % 2 === 0 });
    }
    phone.expectBounded();
  }, 60_000);
});

// ---- I2, I4: sleep, steady use, and the phone's clock -----------------------------------------------------------

describe('I2 I4: a power cut opens on a whole copy that is never older than it may be', () => {
  /** I4: right after the save that replaced the file, what the file held before is still in a full copy. */
  const expectKeptAside = (phone: Phone, replaced: Save, label: string) => {
    const kept = filesHolding(phone.dev, tagOf(replaced.n)).filter((name) => fullCopies(phone.dev).includes(name));
    if (kept.length === 0) throw new Error(`I4 (${label}): the save that replaced the file kept nothing of save ${replaced.n}, which the file held. Files: ${fullCopies(phone.dev).join(', ')}`);
  };

  it.each(MEANINGS)('(c) I2 I4: a clock-in, its message 10 s later, an hour asleep (5 s awake), a save as the phone wakes, then a power cut tearing what was written since waking: the save before the sleep is kept, and the phone opens on it ($from)', async ({ meaning }) => {
    const phone = await usedPhone(meaning);
    phone.idle(10 * MIN);
    const before = phone.last!;
    const opened = await phone.start();
    expect(opened.read).toBe(before.text);
    await phone.save(); // the clock-in
    await phone.pass(10_000);
    const message = await phone.save(); // its message
    phone.sleep(60 * MIN);
    await phone.pass(5_000);
    await phone.save(); // the round as the phone wakes
    // I4: what the file held, written an hour ago by the phone's clock, is kept as a full copy by the save that replaced it.
    expectKeptAside(phone, message, 'an hour asleep, 5 s awake');
    await phone.pass(2_000);
    const after = await phone.cutAndRead(sinceWake);
    expectReadAfterCut(after, phone, 'cut tearing what was written since waking');
    expect(numberIn(after.read)).toBe(message.n);
    expect(after.passedOver).toBe(true);
  });

  it.each(MEANINGS)('(c) I4: by the phone clock: the file written 5 minutes ago by it, the phone asleep since and 2 s awake, is kept as a full copy by the save that replaces it ($from)', async ({ meaning }) => {
    const phone = await usedPhone(meaning);
    phone.idle(10 * MIN);
    await phone.start();
    await phone.save();
    await phone.pass(10_000);
    const replaced = await phone.save();
    phone.sleep(5 * MIN);
    await phone.pass(2_000);
    await phone.save();
    expectKeptAside(phone, replaced, '5 minutes by the phone clock, 2 s awake');
  });

  it.each(MEANINGS)('(c) I4: by the steady clock: the file written 70 s ago, with the phone clock set back an hour so that by it the file was written in the future, is kept as a full copy by the save that replaces it ($from)', async ({ meaning }) => {
    const phone = await usedPhone(meaning);
    phone.idle(10 * MIN);
    await phone.start();
    await phone.save();
    await phone.pass(10_000);
    const replaced = await phone.save();
    await phone.pass(70_000);
    phone.jump(-60 * MIN);
    await phone.save();
    expectKeptAside(phone, replaced, '70 s by the steady clock, in the future by the phone clock');
  });

  it.each(MEANINGS)('(c) I4: held by the app: the file read at a start after a reboot, with the phone clock set back an hour, and replaced 70 s later, is kept as a full copy ($from)', async ({ meaning }) => {
    const phone = await usedPhone(meaning);
    phone.idle(10 * MIN);
    await phone.start();
    await phone.pass(3_000);
    const replaced = await phone.save();
    phone.reboot();
    phone.jump(-60 * MIN);
    await phone.start();
    await phone.pass(70_000);
    await phone.save();
    expectKeptAside(phone, replaced, 'held 70 s by this start, after a reboot');
  });

  it('(c) I4: by the steady clock recorded when it was written: the file written 70 s ago at an earlier start in the same boot, with the phone clock set back an hour, is kept by the first save of the next start (steady clock from boot)', async () => {
    const phone = await usedPhone('boot');
    phone.idle(10 * MIN);
    await phone.start();
    await phone.pass(3_000);
    const replaced = await phone.save();
    phone.idle(70_000);
    phone.jump(-60 * MIN);
    await phone.start();
    await phone.save();
    expectKeptAside(phone, replaced, '70 s by the steady clock, across a restart');
  });

  it.each(MEANINGS)('(d) I2: steady use, a save every 10 s for 10 minutes: a power cut tearing the last 2 minutes of awake time, after any save, opens on a whole copy no older than the newest save a minute and a half before the torn window, and says so ($from)', async ({ meaning }) => {
    const phone = await usedPhone(meaning);
    phone.idle(10 * MIN);
    await phone.start();
    for (let t = 0; t < 10 * MIN; t += 10_000) {
      await phone.save();
      await phone.expectDurable(`${t / 1000} s into the session`);
      await phone.pass(10_000);
    }
  });

  it('(d) I1: steady use, a save every 10 s for 10 minutes, in a session after an earlier one: at most 5 full copies after every save, the earlier session’s copies among them (steady clock from boot)', async () => {
    const phone = await usedPhone('boot');
    phone.idle(10 * MIN);
    await phone.start();
    for (let t = 0; t < 10 * MIN; t += 10_000) {
      await phone.save();
      await phone.pass(10_000);
    }
    phone.expectBounded();
  });

  it.each(MEANINGS)('(c) I2: the app open while the phone sleeps an hour after a save, then two saves as it wakes: a cut tearing what was written since waking opens on the save before the sleep, which only the copy before the latest sleep keeps ($from)', async ({ meaning }) => {
    const phone = await usedPhone(meaning);
    phone.idle(10 * MIN);
    await phone.start();
    await phone.pass(3_000);
    const before = await phone.save();
    phone.sleep(60 * MIN);
    await phone.pass(3_000);
    await phone.save();
    await phone.pass(10_000);
    await phone.save();
    await phone.pass(2_000);
    const after = await phone.cutAndRead(sinceWake);
    expectReadAfterCut(after, phone, 'cut tearing what was written since waking');
    expect(numberIn(after.read)).toBe(before.n);
  });

  it('(c) I4: the copy a save replaces, written 65 s before by the phone clock (15 s of it asleep, too short to count as a sleep, and 50 s awake) in the same minute of steady time, is kept by that save, which only the copy a save replaced keeps (steady clock from boot)', async () => {
    const phone = await usedPhone('boot');
    phone.idle(10 * MIN);
    await phone.start();
    await phone.pass(MIN - (phone.clock.steady % MIN) + 500);
    const replaced = await phone.save();
    phone.sleep(15_000);
    await phone.pass(50_000);
    expect(Math.floor(phone.clock.steady / MIN)).toBe(Math.floor((phone.clock.steady - 50_000) / MIN));
    await phone.save();
    expect(filesHolding(phone.dev, tagOf(replaced.n)).filter((name) => fullCopies(phone.dev).includes(name))).toHaveLength(1);
  });

  it('(d) I1: a sleep, then saves across three minutes of steady time, the last after 25 s asleep and 45 s awake, so that the copy before the sleep, the copy it replaces and the newest of each minute all ask to be kept: at most 5 full copies (steady clock from boot, R5-6)', async () => {
    const phone = await usedPhone('boot');
    phone.idle(10 * MIN);
    await phone.start();
    await phone.pass(MIN - (phone.clock.steady % MIN) + 50_000);
    await phone.save();
    phone.sleep(60 * MIN);
    await phone.pass(5_000);
    await phone.save();
    await phone.pass(10_000);
    await phone.save();
    await phone.pass(57_000);
    await phone.save();
    phone.sleep(25_000);
    await phone.pass(45_000);
    await phone.save();
    phone.expectBounded();
    await phone.expectDurable('after the last save');
  });

  it('(d) I1: a new phone that saves across four minutes of steady time with a sleep between, the last save 61 s by the phone clock after the one before (12 s of it asleep): at most 5 full copies (steady clock from boot)', async () => {
    const phone = new Phone('boot');
    await phone.start();
    await phone.save();
    await phone.pass(139_000);
    await phone.save();
    await phone.pass(1_500);
    await phone.save();
    phone.sleep(10 * MIN);
    await phone.pass(49_500);
    await phone.save();
    await phone.pass(10_500);
    await phone.save();
    await phone.pass(49_000);
    phone.sleep(12_000);
    await phone.save();
    phone.expectBounded();
    await phone.expectDurable('after the last save');
  });

  it('(f) I2, the known limit: two reboots close together, the second one the steady clock cannot see, then short starts asleep between: a power cut tearing the last two minutes awake opens on a whole copy, says it shut off while saving, and no more than 2 saves further back than owed (steady clock from boot, R5-8)', async () => {
    const phone = await usedPhone('boot');
    const brief = async (saves: number) => {
      await phone.start();
      for (let i = 0; i < saves; i++) {
        await phone.pass(i === 0 ? 3_000 : 12_000);
        await phone.save();
      }
      await phone.pass(5_000);
      phone.close();
    };
    phone.idle(10 * MIN);
    await brief(1);
    phone.reboot();
    phone.idle(166_000);
    await brief(2);
    phone.reboot();
    // The next start first reads the records 36 s past the steady time of the last copy of the boot before.
    phone.idle(217_000);
    await brief(1);
    phone.sleep(27 * MIN);
    await brief(1);
    phone.sleep(3 * 60 * MIN);
    await brief(2);
    phone.sleep(5 * 60 * MIN);
    await phone.start();
    await phone.pass(3_000);
    await phone.save();
    const after = await phone.cutAndRead(lastAwake());
    expect(after.error).toBeUndefined();
    expect(after.read !== null && isWhole(after.read)).toBe(true);
    expect(after.passedOver).toBe(true);
    const read = phone.saves.find((s) => s.text === after.read)!;
    expect(after.owed).not.toBeNull();
    // The last copy before the reboot the steady clock cannot see is on the disk, and is let go of: the copy read is
    // older. Here 2 saves; at most 4 (UNSEEN_REBOOT_SAVES) in the randomized runs measured.
    expect(after.owed! - read.n).toBeLessThanOrEqual(2);
    expect(after.owed! - read.n).toBeLessThanOrEqual(UNSEEN_REBOOT_SAVES);
  });

  it.each(MEANINGS)('(e) I3: the phone clock jumps an hour forward right after a save; a power cut tearing the last 30 s at any time in the 3 minutes after opens on a whole copy no more than about 3 minutes of awake time old ($from)', async ({ meaning }) => {
    const phone = await usedPhone(meaning);
    phone.idle(10 * MIN);
    await phone.start();
    for (let t = 0; t < 5 * MIN; t += 10_000) {
      await phone.save();
      await phone.pass(10_000);
    }
    await phone.save();
    phone.jump(60 * MIN);
    for (let t = 0; t <= 3 * MIN; t += 10_000) {
      if (t > 0) {
        await phone.pass(10_000);
        await phone.save();
      }
      const after = await phone.cutAndRead(lastAwake(30_000));
      const label = `${t / 1000} s after the jump, cut tearing the last 30 s`;
      expectReadAfterCut(after, phone, label);
      const save = phone.saves.find((s) => s.text === after.read);
      if (!save) throw new Error(`I3 (${label}): it opened on nothing, with whole copies saved minutes before`);
      const age = phone.clock.awake - save.awake;
      if (age > 3 * MIN + 15_000) throw new Error(`I3 (${label}): it opened on save ${save.n}, ${age / 1000} s of awake time old`);
      // And the usual cut, tearing the last two minutes, holds too.
      await phone.expectDurable(label);
    }
  });
});

// ---- I5: a clear --------------------------------------------------------------------------------------------------

/** A phone in use whose records hold what a clear will take off, emptied now by the store, and closed 5 s later. */
async function clearedPhone(meaning: Meaning) {
  const phone = await usedPhone(meaning, withCleared);
  phone.idle(10 * MIN);
  await phone.start();
  await phone.pass(3_000);
  await phone.save(withCleared);
  await phone.pass(5_000);
  const marksBefore = emptyFiles(phone.dev);
  phone.forget('clear');
  const clearing = await phone.save(emptied);
  const marksMade = emptyFiles(phone.dev).filter((name) => !marksBefore.includes(name));
  return { phone, clearing, marksMade };
}

async function clearThenShortStarts(meaning: Meaning, liveness: boolean) {
  const { phone, clearing, marksMade } = await clearedPhone(meaning);
  await phone.pass(5_000);
  phone.close();
  for (let i = 0; i < 10; i++) {
    phone.sleep(5 * MIN);
    const opened = await shortStart(phone, 2, { cuts: true, passedOver: false });
    expect(opened.read).not.toContain(CLEARED);
    const since = phone.clock.awake - clearing.awake;
    if (liveness && since >= DEADLINE_MS) {
      const left = filesHolding(phone.dev, CLEARED);
      if (left.length > 0) throw new Error(`I5: ${since / 1000} s of awake time after the clear, over ${i + 1} short starts, what it cleared is still in ${left.join(', ')}`);
      const marks = marksMade.filter((name) => phone.dev.disk.has(name));
      if (marks.length > 0) throw new Error(`I5: ${since / 1000} s of awake time after the clear, its marks are still there: ${marks.join(', ')}`);
    }
  }
  if (liveness) expect(phone.clock.awake - clearing.awake).toBeGreaterThan(DEADLINE_MS);
}

describe('I5: a clear empties the phone for good', () => {
  it('(f) I5: a clear, then 10 short starts asleep between them: nothing from before the clear is read again, after a power cut neither, and once about 2 minutes of awake time have passed what it cleared and the marks it made are gone (steady clock from boot)', async () => {
    await clearThenShortStarts('boot', true);
  });

  it('(f) I5: a clear, then 10 short starts asleep between them: nothing from before the clear is read again, after a power cut neither (steady clock from app start, where no short start can know a copy has settled)', async () => {
    await clearThenShortStarts('start', false);
  });

  it.each(MEANINGS)('(g) I5 F4: a clear, new work 90 s later, then a power cut tearing the last 2 minutes: the phone opens as the build starts (null), never on what was cleared, and says it shut off while saving ($from)', async ({ meaning }) => {
    const { phone } = await clearedPhone(meaning);
    await phone.pass(90_000);
    await phone.save(); // signed in again, and clocked in
    await phone.pass(5_000);
    const after = await phone.cutAndRead(lastAwake());
    expect(after.error).toBeUndefined();
    expect(after.read).toBeNull();
    if (!after.passedOver) throw new Error('F4: the phone opened as the build starts after the clear, with the work done since it torn, and said nothing of shutting off while saving (passedOverNewer false)');
  });

  it('(g) I5 F4 I8: a disk 64669fa left with a clear mark, copies from before it, and a torn file after it: the phone opens as the build starts and says it shut off while saving', async () => {
    const after = T0 - 5 * MIN;
    const dev = placed({
      [`${KEY}.cleared-${after}.json`]: '',
      [`${KEY}.cp-${T0 - 10 * MIN}.json`]: withCleared(4),
      [`${KEY}.cp-${T0 - 20 * MIN}.json`]: withCleared(3),
      [`${KEY}.json`]: half(value(5)),
    });
    const phone = new Phone('boot', dev);
    const opened = await phone.start();
    expect(opened.error).toBeUndefined();
    expect(opened.read).toBeNull();
    if (!opened.passedOver) throw new Error('F4: a torn file after a clear mark was passed over, and the phone said nothing of shutting off while saving (passedOverNewer false)');
  });
});

// ---- I6: a drop ---------------------------------------------------------------------------------------------------

/** A phone in use with one person's hourly rate in its records, whose store now takes that person's records off it. */
async function droppedPhone(meaning: Meaning) {
  const phone = await usedPhone(meaning, withRate);
  phone.idle(10 * MIN);
  await phone.start();
  await phone.pass(3_000);
  await phone.save(withRate);
  await phone.pass(10_000);
  const marksBefore = emptyFiles(phone.dev);
  phone.forget('drop');
  const dropping = await phone.save(value);
  const marksMade = emptyFiles(phone.dev).filter((name) => !marksBefore.includes(name));
  return { phone, dropping, marksMade };
}

async function dropThenShortStarts(meaning: Meaning, liveness: boolean) {
  const { phone, dropping, marksMade } = await droppedPhone(meaning);
  await phone.pass(5_000);
  phone.close();
  for (let i = 0; i < 10; i++) {
    phone.sleep(5 * MIN);
    const opened = await shortStart(phone, 2);
    expect(opened.read).not.toContain(RATE);
    expect(dropUndoneIfThere(opened.api) ?? false).toBe(false);
    // A power cut now may bring back a copy from before the drop; where the build has dropUndone, it says so then.
    for (const after of await phone.expectDurable(`start ${phone.starts}`)) expectDropSaid(after, `start ${phone.starts}`);
    const since = phone.clock.awake - dropping.awake;
    if (liveness && since >= DEADLINE_MS) {
      const left = filesHolding(phone.dev, RATE);
      if (left.length > 0) throw new Error(`I6: ${since / 1000} s of awake time after the drop, over ${i + 1} short starts, the dropped hourly rate is still in ${left.join(', ')}`);
      const marks = marksMade.filter((name) => phone.dev.disk.has(name));
      if (marks.length > 0) throw new Error(`I6: ${since / 1000} s of awake time after the drop, its marks are still there: ${marks.join(', ')}`);
    }
  }
  if (liveness) expect(phone.clock.awake - dropping.awake).toBeGreaterThan(DEADLINE_MS);
}

describe('I6: a drop takes one person’s records off the phone, and a power cut that undoes it is said', () => {
  it('(h) I6: a drop, then 10 short starts asleep between them: each reads what was saved after the drop, and once about 2 minutes of awake time have passed the dropped hourly rate is in no file and the drop’s marks are gone (steady clock from boot)', async () => {
    await dropThenShortStarts('boot', true);
  });

  it('(h) I6: a drop, then 10 short starts asleep between them: each reads what was saved after the drop, and a power cut never loses more than it may (steady clock from app start)', async () => {
    await dropThenShortStarts('start', false);
  });

  it.each(MEANINGS)('(i) I6 F5: a drop whose save a power cut tears: the phone opens on a copy from before it with dropUndone true; a later start says so again after the next saves have settled, until the drop is done again, and then the rate goes ($from)', async ({ meaning }) => {
    const { phone } = await droppedPhone(meaning);
    await phone.pass(1_000);
    phone.powerCut(lastAwake());
    const opened = await phone.start();
    expect(opened.error).toBeUndefined();
    expect(opened.read).toContain(RATE);
    expect(opened.passedOver).toBe(true);
    expect(dropUndoneOf(opened.api)(KEY)).toBe(true);

    // The store goes on for three minutes with what it read, the rate still in it: the mark outlives that and its settling.
    for (let t = 0; t < 3 * MIN; t += 10_000) {
      await phone.save(withRate);
      await phone.pass(10_000);
    }
    phone.close();
    phone.idle(10 * MIN);
    const later = await phone.start();
    expect(later.read).toBe(phone.last!.text);
    expect(dropUndoneOf(later.api)(KEY)).toBe(true);

    // The store does the drop again; once that has settled, the rate is gone and nothing is said any more.
    phone.forget('drop');
    await phone.save(value);
    for (let t = 0; t < 3 * MIN; t += 10_000) {
      await phone.pass(10_000);
      await phone.save(value);
    }
    phone.close();
    phone.idle(10 * MIN);
    const done = await phone.start();
    expect(done.read).toBe(phone.last!.text);
    expect(dropUndoneOf(done.api)(KEY)).toBe(false);
    expect(filesHolding(phone.dev, RATE)).toEqual([]);
  });

  it('(i) I6 I7 F5: a drop on a phone that moved an older version’s row at this start, whose saves a power cut tears so that the phone opens on the row: dropUndone is true, and when the store cannot make the drop again (the account’s shift is open in the row) it is said again at the next start (R5-5)', async () => {
    const phone = new Phone('boot');
    phone.dev.rows.set(KEY, withRate(1));
    phone.older(1, withRate(1));
    const first = await phone.start();
    expect(first.read).toBe(withRate(1));
    await phone.pass(3_000);
    await phone.save(withRate);
    await phone.pass(10_000);
    phone.forget('drop', 'acct_1');
    await phone.save(value);
    await phone.pass(10_000);
    // Every copy of the file was written in the last two minutes: the cut tears them all, and the row is read.
    phone.powerCut(lastAwake());
    const second = await phone.start();
    expect(second.read).toBe(withRate(1));
    expect(second.passedOver).toBe(true);
    expect(second.api.undoneDrops(KEY)).toEqual(['acct_1']);
    // The store cannot make the drop again: it saves what it read, the rate still in it.
    await phone.pass(3_000);
    await phone.save(withRate);
    await phone.pass(5_000);
    phone.close();
    phone.idle(5 * MIN);
    const third = await phone.start();
    expect(third.read).toBe(phone.last!.text);
    expect(third.read).toContain(RATE);
    expect(third.api.undoneDrops(KEY)).toEqual(['acct_1']);
  });

  it('(i) I6 I7 F5: the same, with the app killed at the start after the cut before it saved anything: the start after that still opens on the row and says the drop was undone', async () => {
    const phone = new Phone('boot');
    phone.dev.rows.set(KEY, withRate(1));
    phone.older(1, withRate(1));
    await phone.start();
    await phone.pass(3_000);
    await phone.save(withRate);
    await phone.pass(10_000);
    phone.forget('drop', 'acct_1');
    await phone.save(value);
    await phone.pass(10_000);
    phone.powerCut(lastAwake());
    const second = await phone.start();
    expect(second.read).toBe(withRate(1));
    expect(second.api.undoneDrops(KEY)).toEqual(['acct_1']);
    // Killed as it opened: the store had read the records and put what it read in place, and saved nothing.
    phone.close();
    const third = await phone.start();
    expect(third.read).toBe(withRate(1));
    expect(third.api.undoneDrops(KEY)).toEqual(['acct_1']);
  });

  it('(i) I6 F5 I8: a disk 64669fa left with a drop mark, copies from before it with the rate, and a torn file after it: the phone opens on the newest copy from before, says it shut off while saving, and dropUndone is true', async () => {
    const after = T0 - 5 * MIN;
    const dev = placed({
      [`${KEY}.dropped-${after}.json`]: '',
      [`${KEY}.cp-${T0 - 10 * MIN}.json`]: withRate(4),
      [`${KEY}.cp-${T0 - 20 * MIN}.json`]: withRate(3),
      [`${KEY}.json`]: half(value(5)),
    });
    const phone = new Phone('boot', dev);
    const opened = await phone.start();
    expect(opened.read).toBe(withRate(4));
    expect(opened.passedOver).toBe(true);
    expect(dropUndoneOf(opened.api)(KEY)).toBe(true);
  });
});

// ---- I2: a new phone ----------------------------------------------------------------------------------------------

describe('I2 F3: a new phone that loses its first saves', () => {
  it.each(MEANINGS)('(j) I2 F3: a new phone whose first four saves, 10 s apart, a power cut tears: it opens as the build starts (null, not torn text), says it shut off while saving, opens the same way again, and keeps what it saves from then on ($from)', async ({ meaning }) => {
    const phone = new Phone(meaning);
    const first = await phone.start();
    expect(first.read).toBeNull();
    expect(first.passedOver).toBe(false);
    for (let i = 0; i < 4; i++) {
      await phone.save();
      await phone.pass(10_000);
    }
    phone.powerCut(lastAwake());
    const opened = await phone.start();
    expect(opened.error).toBeUndefined();
    if (opened.read !== null) throw new Error(`F3: a new phone with nothing whole was handed ${isWhole(opened.read) ? 'records' : 'torn text, which the store cannot read (Records not read, for good)'}, not null`);
    expect(opened.passedOver).toBe(true);

    // Opened again before anything is saved (Try again, or the app closed and opened): the same, never torn text.
    phone.close();
    const again = await phone.start();
    expect(again.error).toBeUndefined();
    expect(again.read).toBeNull();

    // From then on it keeps what it saves.
    await phone.save();
    await phone.pass(3 * MIN);
    const kept = await phone.save();
    phone.close();
    phone.idle(5 * MIN);
    expect((await phone.start()).read).toBe(kept.text);
  });
});

// ---- I7: an older version's row ---------------------------------------------------------------------------------

async function rowThenShortStarts(meaning: Meaning, liveness: boolean) {
  const dev = newDevice();
  const row = value(0, { from: 'an older version' });
  dev.rows.set(KEY, row);
  dev.rows.set(SESSION, 'tokens');
  const phone = new Phone(meaning, dev);
  phone.older(0, row);
  let movedAt: number | null = null;
  const rowStays = (step: string) => {
    if (movedAt !== null && phone.clock.awake - movedAt < SETTLE_MS && !dev.rows.has(KEY)) {
      throw new Error(`I7: the older version's row went ${(phone.clock.awake - movedAt) / 1000} s of awake time after it was moved (${step}), before any copy of the file could have settled`);
    }
  };
  for (let i = 0; i < 12; i++) {
    if (i > 0) phone.sleep(5 * MIN);
    const had = dev.rows.has(KEY);
    const expected = phone.last!.text;
    const opened = await phone.start();
    if (movedAt === null) movedAt = phone.clock.awake;
    expect(opened.read).toBe(expected);
    if (dev.rows.has(KEY) !== had) throw new Error(`I7: the older version's row was removed at a read (start ${phone.starts})`);
    rowStays(`start ${phone.starts}`);
    for (let s = 0; s < 2; s++) {
      await phone.pass(s === 0 ? 3_000 : 12_000);
      await phone.save();
      rowStays(`save ${phone.counter}`);
      await phone.expectDurable(`start ${phone.starts}, save ${phone.counter}`);
    }
    await phone.pass(5_000);
    phone.close();
    const since = phone.clock.awake - movedAt;
    if (liveness && since >= DEADLINE_MS && dev.rows.has(KEY)) {
      throw new Error(`I7: ${since / 1000} s of awake time after the row was moved into the file, over ${i + 1} short starts, the older version's row is still in AsyncStorage`);
    }
  }
  expect(dev.rows.get(SESSION)).toBe('tokens');
}

describe('I7: an older version’s AsyncStorage row', () => {
  it('(k) I7: moved into the file at the first start, then short starts asleep between them: never removed at a read, kept until a copy of the file could have settled, and removed once about 2 minutes of awake time have passed (steady clock from boot)', async () => {
    await rowThenShortStarts('boot', true);
  });

  it('(k) I7: moved into the file at the first start, then short starts asleep between them: never removed at a read, nor before a copy of the file could have settled, and a power cut meanwhile opens on the records (steady clock from app start)', async () => {
    await rowThenShortStarts('start', false);
  });
});

// ---- I8: what earlier builds left -----------------------------------------------------------------------------------

/** A phone whose disk an earlier build left: these files, written long ago, dated by the phone's clock as given (or ten minutes ago). */
function placed(files: Record<string, string>, times: Record<string, number> = {}): Device {
  const dev = newDevice();
  for (const [name, text] of Object.entries(files)) {
    dev.disk.set(name, text);
    dev.stamps.set(name, { wall: times[name] ?? T0 - 10 * MIN, awake: LONG_AGO, real: LONG_AGO });
  }
  return dev;
}

interface Left {
  name: string;
  files: Record<string, string>;
  rows?: Record<string, string>;
  /** The save the start reads, or null for none. */
  reads: number | null;
  /** What passedOverNewer says then, where the earlier builds and the new rules agree. */
  passedOver?: boolean;
  /** Sentinels that are in no file once the next saves have settled. */
  gone?: string[];
  /** The marks it left go once the next saves have settled. */
  marksGo?: boolean;
  /** The row goes once the next saves have settled. */
  rowGoes?: boolean;
}

const cp = (at: number) => `${KEY}.cp-${at}.json`;
const MARK_AT = T0 - 5 * MIN;
const LEFT: Left[] = [
  { name: 'the file alone', files: { [`${KEY}.json`]: value(1) }, reads: 1, passedOver: false },
  { name: 'a whole new copy beside the file', files: { [`${KEY}.json.next`]: value(2), [`${KEY}.json`]: value(1) }, reads: 2, passedOver: false },
  { name: 'a torn new copy beside the file', files: { [`${KEY}.json.next`]: half(value(2)), [`${KEY}.json`]: value(1) }, reads: 1, passedOver: true },
  { name: 'a copy still being written beside the file, however whole it looks', files: { [`${KEY}.json.part`]: value(2), [`${KEY}.json`]: value(1) }, reads: 1 },
  { name: 'a torn file and the copy before it (.prev)', files: { [`${KEY}.json`]: half(value(2)), [`${KEY}.json.prev`]: value(1) }, reads: 1, passedOver: true },
  { name: 'a torn file and two checkpoints', files: { [`${KEY}.json`]: half(value(3)), [cp(T0 - MIN)]: value(2), [cp(T0 - 2 * MIN)]: value(1) }, reads: 2, passedOver: true },
  { name: 'a torn file, a torn checkpoint, and an older whole one', files: { [`${KEY}.json`]: half(value(3)), [cp(T0 - MIN)]: half(value(2)), [cp(T0 - 2 * MIN)]: value(1) }, reads: 1, passedOver: true },
  {
    name: 'a torn new copy and file, a checkpoint and .prev',
    files: { [`${KEY}.json.next`]: half(value(4)), [`${KEY}.json`]: half(value(3)), [cp(T0 - MIN)]: value(2), [`${KEY}.json.prev`]: value(1) },
    reads: 2,
    passedOver: true,
  },
  { name: 'the file, a checkpoint and .prev, all whole (abf5062)', files: { [`${KEY}.json`]: value(3), [cp(T0 - MIN)]: value(2), [`${KEY}.json.prev`]: value(1) }, reads: 3, passedOver: false },
  { name: 'checkpoints alone', files: { [cp(T0 - MIN)]: value(2), [cp(T0 - 2 * MIN)]: value(1) }, reads: 2, passedOver: false },
  { name: 'a torn copy still being written, alone', files: { [`${KEY}.json.part`]: half(value(1)) }, reads: null },
  {
    name: 'a clear mark, copies from before it, and a whole file after it',
    files: { [`${KEY}.cleared-${MARK_AT}.json`]: '', [cp(T0 - 10 * MIN)]: withCleared(4), [`${KEY}.json.prev`]: withCleared(3), [`${KEY}.json`]: value(5) },
    reads: 5,
    passedOver: false,
    gone: [CLEARED],
    marksGo: true,
  },
  {
    name: 'a clear mark, copies from before it, and a torn file after it',
    files: { [`${KEY}.cleared-${MARK_AT}.json`]: '', [cp(T0 - 10 * MIN)]: withCleared(4), [`${KEY}.json`]: half(value(5)) },
    reads: null,
    gone: [CLEARED],
    marksGo: true,
  },
  {
    name: 'a clear mark, a copy from before it, a whole checkpoint after it, and a torn file',
    files: { [`${KEY}.cleared-${MARK_AT}.json`]: '', [cp(T0 - 10 * MIN)]: withCleared(4), [cp(T0 - 2 * MIN)]: value(6), [`${KEY}.json`]: half(value(7)) },
    reads: 6,
    passedOver: true,
    gone: [CLEARED],
    marksGo: true,
  },
  {
    name: 'a drop mark, copies from before it with the rate, and a whole file after it',
    files: { [`${KEY}.dropped-${MARK_AT}.json`]: '', [cp(T0 - 10 * MIN)]: withRate(4), [cp(T0 - 20 * MIN)]: withRate(3), [`${KEY}.json`]: value(5) },
    reads: 5,
    passedOver: false,
    gone: [RATE],
    marksGo: true,
  },
  {
    name: 'a drop mark, a copy from before it with the rate, and a torn file after it',
    files: { [`${KEY}.dropped-${MARK_AT}.json`]: '', [cp(T0 - 10 * MIN)]: withRate(4), [`${KEY}.json`]: half(value(5)) },
    reads: 4,
    passedOver: true,
  },
  {
    name: 'a clear mark, then a drop mark, copies from before each, and a whole file after both',
    files: {
      [`${KEY}.cleared-${T0 - 30 * MIN}.json`]: '',
      [`${KEY}.dropped-${MARK_AT}.json`]: '',
      [cp(T0 - 40 * MIN)]: withCleared(2),
      [cp(T0 - 10 * MIN)]: withRate(4),
      [`${KEY}.json`]: value(5),
    },
    reads: 5,
    passedOver: false,
    gone: [CLEARED, RATE],
    marksGo: true,
  },
  { name: 'the file, with an older version’s row still in AsyncStorage', files: { [`${KEY}.json`]: value(8) }, rows: { [KEY]: value(7) }, reads: 8, passedOver: false, rowGoes: true },
];

describe('I8: the files that builds abf5062 and 64669fa left on a phone', () => {
  it.each(LEFT)('(l) I8: $name: read as it should be, and the next saves leave the phone as this build keeps it', async (left) => {
    const dev = placed(left.files);
    for (const [key, text] of Object.entries(left.rows ?? {})) dev.rows.set(key, text);
    const phone = new Phone('boot', dev);
    phone.counter = 100;
    const marks = Object.keys(left.files).filter((name) => left.files[name] === '');
    const opened = await phone.start();
    expect(opened.error).toBeUndefined();
    expect(opened.read).toBe(left.reads === null ? null : (Object.values(left.files).find((text) => numberIn(text) === left.reads && isWhole(text)) ?? `save ${left.reads}`));
    expect(opened.read ?? '').not.toContain(CLEARED);
    if (left.passedOver !== undefined) expect(opened.passedOver).toBe(left.passedOver);
    if (left.rows?.[KEY]) expect(dev.rows.get(KEY)).toBe(left.rows[KEY]);

    // Three minutes of use, saves among them, then a restart.
    await phone.save();
    await phone.pass(30_000);
    await phone.save();
    await phone.pass(150_000);
    const last = await phone.save();
    phone.close();
    phone.idle(5 * MIN);
    const again = await phone.start();
    expect(again.read).toBe(last.text);
    expect(again.passedOver).toBe(false);
    phone.expectBounded();
    for (const sentinel of left.gone ?? []) expect(filesHolding(dev, sentinel)).toEqual([]);
    if (left.marksGo) expect(marks.filter((name) => dev.disk.has(name))).toEqual([]);
    if (left.rowGoes) expect(dev.rows.has(KEY)).toBe(false);
  });
});

// ---- I9: one write of the records per save --------------------------------------------------------------------------

describe('I9: nothing extra is written', () => {
  it('(m) I9: through steady use, short starts, sleeps, a reboot, clock jumps, a drop and a clear: every save writes the records once, a clear or a drop writes only marks, a start writes nothing but when it moves an older row, and time passing writes nothing', async () => {
    const dev = newDevice();
    const row = value(0, { from: 'an older version' });
    dev.rows.set(KEY, row);
    const phone = new Phone('boot', dev);
    phone.older(0, row);
    await phone.start(); // moves the row: one write
    for (let t = 0; t < 4 * MIN; t += 5_000) {
      await phone.save(withRate);
      await phone.pass(5_000);
    }
    phone.close();
    for (let i = 0; i < 8; i++) {
      if (i === 3) phone.reboot();
      if (i % 2 === 0) phone.sleep(30 * MIN);
      else phone.idle(3 * MIN);
      if (i === 5) phone.jump(60 * MIN);
      if (i === 6) phone.jump(-60 * MIN);
      await shortStart(phone, 2, { make: withRate });
    }
    phone.idle(MIN);
    await phone.start();
    await phone.pass(3_000);
    phone.forget('drop');
    await phone.save(value);
    for (let t = 0; t < 3 * MIN; t += 10_000) {
      await phone.pass(10_000);
      await phone.save(withCleared);
    }
    phone.forget('clear');
    await phone.save(emptied);
    for (let t = 0; t < 3 * MIN; t += 10_000) {
      await phone.pass(10_000);
      await phone.save();
    }
    phone.close();
    phone.sleep(10 * MIN);
    await shortStart(phone, 2);

    const saves = phone.dataWrites.filter((w) => w.step.startsWith('save'));
    const notOne = saves.filter((w) => w.count !== 1);
    if (notOne.length > 0) throw new Error(`I9: these saves did not write the records exactly once: ${notOne.map((w) => `${w.step}: ${w.count}`).join('; ')}`);
    const starts = phone.dataWrites.filter((w) => w.step.startsWith('start'));
    expect(starts[0].count).toBeLessThanOrEqual(1);
    const startWrites = starts.slice(1).filter((w) => w.count !== 0);
    if (startWrites.length > 0) throw new Error(`I9: these starts wrote the records: ${startWrites.map((w) => `${w.step}: ${w.count}`).join('; ')}`);
    const timeWrites = phone.dataWrites.filter((w) => w.step.startsWith('time') && w.count !== 0);
    if (timeWrites.length > 0) throw new Error(`I9: the records were written with the app idle: ${timeWrites.map((w) => `${w.step}: ${w.count}`).join('; ')}`);
    expect(saves.length).toBeGreaterThan(80);
  });
});

// ---- I10: the iPhone ----------------------------------------------------------------------------------------------

describe('I10: the iPhone keeps its records in AsyncStorage, as before', () => {
  it('(n) I10: a drop on the iPhone: nothing is written to the app’s files, the next start reads the last save, and neither passedOverNewer nor dropUndone says anything', async () => {
    const dev = newDevice();
    const phone = new Phone('boot', dev, 'ios');
    expect((await phone.start()).read).toBeNull();
    await phone.save(withRate);
    await phone.pass(10_000);
    phone.forget('drop');
    const last = await phone.save(value);
    phone.close();
    const opened = await phone.start();
    expect(opened.read).toBe(last.text);
    expect(opened.passedOver).toBe(false);
    expect(dropUndoneOf(opened.api)(KEY)).toBe(false);
    expect(dev.disk.size).toBe(0);
    expect(dev.rows.get(KEY)).toBe(last.text);
  });
});
