/**
 * The rules for the copies of the records on Android (storage.native.ts keeps the files): pure, with both clocks
 * passed in.
 *
 * expo-file-system cannot make a write reach the disk before the app goes on: File.write closes its stream with no
 * fsync, so a copy written in the last half a minute or so can be torn by a power cut, a forced restart or a kernel
 * crash, and the records are saved several times within seconds of a punch. So each save is a copy of its own: it
 * is written whole beside the others and renamed to a name that says its place, when it was written by the steady
 * clock and which start of the app wrote it, and older copies go only by the rules here. A whole copy that has had time
 * to reach the disk is always there, and five copies at most (`MOST_COPIES`, `toLetGo`).
 *
 * Two clocks. The phone's clock (Date.now, and a file's modificationTime) can jump either way: network time setting
 * right a clock that started from zero after the battery ran flat, or someone setting the date by hand. It gives the
 * copies their places and shows when the phone slept, but it never says a copy has reached the disk. That is the
 * steady clock's (performance.now: it never jumps, never runs faster than real time, and stops while the phone sleeps,
 * as the kernel's writeback does). A copy whose steady time is at or below now and two minutes or more before it has
 * had two minutes of awake time since, whatever that clock counts from.
 *
 * The rules count on more, and do so on purpose: that the steady clock counts from the phone's start, as React Native
 * 0.88 reads it (NativePerformance::now, std::chrono::steady_clock, CLOCK_MONOTONIC on Android). A copy whose steady
 * time is above now was then written before the phone last started, so it is on the disk; and copies of earlier starts
 * of the app in the same boot can be set beside this start's, so that starts a few seconds long still thin and settle
 * them. Without that, the copies could not be kept to a few after starts of the phone close together (34 were
 * measured), and under a clock that counted from the app's start, a start that first read it 10 s or more in could take
 * copies an earlier start wrote seconds before for settled, so that a power cut then left nothing whole to read (Records
 * not read). React Native's own comment says its clock "should be carefully changed eventually": steadyClock.test.ts
 * reads its source and fails once it no longer reads that clock, so an upgrade that made it count from the app's start
 * is caught before it ships, and these rules are looked at again. A start whose clock reads less than BOOT_CLOCK_MS as
 * it first reads the records is not trusted with it.
 *
 * Known limit: a start of the phone that the next start of the app cannot see on the steady clock (it first reads the
 * records past the time of the last copy before it) makes that copy look like one of this boot's, written shortly before.
 * While the five copies are kept for other reasons, it can go, and a power cut that tears the last two minutes of
 * awake time then opens up to four saves further back than it should, about 3.5 minutes of awake time at most, always
 * on a whole copy and saying the phone shut off while saving (recordsLifetimes.test.ts, `UNSEEN_REBOOT_SAVES`).
 */

/** Copies kept in the same minute of steady time: only the newest. */
export const MINUTE_MS = 60_000;

/**
 * How long after it was written a copy is taken to be on the disk ("settled"), by the steady clock. Linux writes a
 * changed page back to the disk once it has been changed for 30 seconds (dirty_expire_centisecs, 3000), looking
 * every 5 seconds (dirty_writeback_centisecs, 500), and ext4 commits its journal every 5 seconds; f2fs checkpoints
 * at least once a minute. Two minutes leaves room for all of that.
 */
export const SETTLED_MS = 120_000;

/** Between two copies, the phone's clock moving on this much more than the steady one: the phone slept, or its clock jumped. */
export const SLEPT_MS = 30_000;

/**
 * The most copies kept, the anchor among them (`toLetGo`), as the earlier builds kept them: the file, the copy beside it
 * and three more.
 */
export const MOST_COPIES = 5;

/**
 * A steady clock that reads this much when the app first reads the records counts from the phone's start (a phone
 * takes longer than this to start an app); one that reads less is taken to count from the app's, and its times are
 * never set beside another start's.
 */
export const BOOT_CLOCK_MS = 10_000;

/** The two clocks, read at the same moment. */
export interface Clocks {
  /** The phone's clock (Date.now): it can jump. */
  wall: number;
  /** The steady clock (performance.now): it cannot jump. */
  steady: number;
}

/**
 * How the steady time in a copy's name counts: `boot`, from the phone's start (the start that wrote it read
 * BOOT_CLOCK_MS or more when it first read the records); `app`, from the app's start, or not known; `earlier`, from a
 * start of the phone before the one now, as a later start found, so the copy is on the disk. Null with no time: an
 * earlier build named none.
 */
export type CopyClock = 'boot' | 'app' | 'earlier' | null;

/** What a copy's file name says. */
export interface Named {
  /** Its place among the copies: a newer one is higher. Not a clock, though it starts from one. */
  order: number;
  /** When it was written by the steady clock of the start that wrote it, or null: an earlier build named none. */
  steady: number | null;
  clock: CopyClock;
  /**
   * Which start of the app wrote it: the steady time that start first read the records at, or null when the name does
   * not say. Two neighbouring copies of different starts may have the phone's own start between them.
   */
  session?: number | null;
}

const TAGS = { boot: 'b', app: 'a', earlier: 'e' } as const;
const CLOCKS: Record<string, CopyClock> = { b: 'boot', a: 'app', e: 'earlier' };

/** One copy of the records, as this session knows it. */
export interface Copy extends Named {
  /** Its file's name, in the app's files. */
  name: string;
  /** When it was written by the phone's clock (its file's modificationTime, which a rename keeps), or null. */
  wall: number | null;
  /** By this session's steady clock, when it wrote the copy, or first saw it. */
  firstSeen: number;
  /** Whether this session wrote it. */
  own: boolean;
  /** Whether this session knows it whole: it wrote it, or read it whole. One from before may have been torn. */
  known: boolean;
}

/** What this session knows of its own clock. */
export interface Start {
  /** The steady clock when this session first read the records. */
  startedAt: number;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A whole number read from a file name, or null. */
const wholeIn = (digits: string | undefined) => {
  const found = Number(digits);
  return digits !== undefined && Number.isSafeInteger(found) ? found : null;
};

/** A copy's file name: its place, when it was written by the steady clock (and how that clock counts), and which start wrote it. */
export function copyName(key: string, order: number, steady: number, clock: Exclude<CopyClock, null>, session?: number | null): string {
  const by = session === undefined || session === null ? '' : `-s${Math.floor(session)}`;
  return `${key}.cp-${order}-${TAGS[clock]}${Math.ceil(steady)}${by}.json`;
}

/** A copy named by its place alone, as earlier builds named their checkpoints: it has no steady time. */
export function placeName(key: string, order: number): string {
  return `${key}.cp-${order}.json`;
}

/**
 * What a file name says of a copy of `key`, or null when it is none. Earlier builds named their checkpoints by place
 * alone (`.cp-<place>.json`), and kept the copy before the last beside the file (`.prev`), read as the oldest. The
 * file and the new copy beside it that those builds kept (`.json`, `.json.next`) have no place in their names:
 * storage.native.ts gives them theirs.
 */
export function copyOf(key: string, name: string): Named | null {
  if (name === `${key}.json.prev`) return { order: 0, steady: null, clock: null };
  const found = new RegExp(`^${escape(key)}\\.cp-(\\d+)(?:-([abe])(\\d+)(?:-s(\\d+))?)?\\.json$`).exec(name);
  const order = wholeIn(found?.[1]);
  if (!found || order === null) return null;
  if (found[2] === undefined) return { order, steady: null, clock: null };
  const steady = wholeIn(found[3]);
  if (steady === null) return null;
  if (found[4] === undefined) return { order, steady, clock: CLOCKS[found[2]] };
  const session = wholeIn(found[4]);
  return session === null ? null : { order, steady, clock: CLOCKS[found[2]], session };
}

/** Newest first, by place. */
export function newestFirst<T extends Pick<Named, 'order'>>(copies: readonly T[]): T[] {
  return [...copies].sort((a, b) => b.order - a.order);
}

/** The place a new copy takes: now by the phone's clock, or just past the newest if that clock has gone back, and never before `floor`. */
export function nextOrder(copies: readonly Pick<Named, 'order'>[], wall: number, floor = 0): number {
  const newest = copies.reduce((most, c) => Math.max(most, c.order), -1);
  return Math.max(Math.floor(wall), newest + 1, floor);
}

/** The first place past every one of these copies. */
export function afterEvery(copies: readonly Pick<Named, 'order'>[]): number {
  return copies.reduce((most, c) => Math.max(most, c.order + 1), 0);
}

/** Whether this session's steady clock counts from the phone's start, by what it read when it first read the records. */
export const bootClock = (start: Start) => start.startedAt >= BOOT_CLOCK_MS;

/**
 * Whether a copy's steady time can be set beside this session's: this session wrote it, or both clocks count from the
 * phone's start and it was written before this session read the records: in this boot, or, which no clock can tell
 * apart from a long sleep, in an earlier boot that had been on for less time than this one has. A copy whose time is
 * above now is from an earlier boot for sure (`fromEarlierBoot`).
 */
export function comparable(copy: Copy, start: Start): boolean {
  if (copy.own) return true;
  return copy.steady !== null && copy.clock === 'boot' && bootClock(start) && copy.steady < start.startedAt;
}

/**
 * Whether a copy was written before the phone last started: a later start said so in its name (`earlier`), or both
 * clocks count from the phone's start and its time is above now, since such a clock never goes back but at a start
 * of the phone. Starting the phone puts everything on the disk. storage.native.ts renames such a copy to say so, so
 * that a later start, whose clock has passed its time, does not take it for one of its own boot.
 */
export function fromEarlierBoot(copy: Copy, now: Clocks, start: Start): boolean {
  if (copy.clock === 'earlier') return true;
  return !copy.own && copy.clock === 'boot' && bootClock(start) && copy.steady !== null && copy.steady > now.steady;
}

/**
 * Whether a copy has had time to reach the disk: its steady time is at or below now and two minutes or more before
 * it; or this session has held it two minutes; or it was written before the phone last started. Never by the phone's
 * clock. Not whether it is whole: a power cut may have torn it before then.
 */
export function isSettled(copy: Copy, now: Clocks, start: Start): boolean {
  if (now.steady - copy.firstSeen >= SETTLED_MS || fromEarlierBoot(copy, now, start)) return true;
  return copy.steady !== null && copy.steady <= now.steady && now.steady - copy.steady >= SETTLED_MS;
}

/** The copies that have had time to reach the disk, newest first: the newest of these known whole is the anchor. */
export function settledNewestFirst(copies: readonly Copy[], now: Clocks, start: Start): Copy[] {
  return newestFirst(copies).filter((copy) => isSettled(copy, now, start));
}

/**
 * Whether the phone may have slept between two neighbouring copies: the phone's clock moved on SLEPT_MS or more beyond
 * the steady one (a sleep, or that clock jumping forward), or the steady clock cannot be set beside it (either copy's
 * time cannot be set beside this session's, one is undated, or the steady clock went back). Not when the phone's clock
 * went back: that hides a sleep only as far as it went back, so what that clock still says is a minute and a half old
 * is a minute old by the steady one, and kept as the newest of its minute.
 */
export function sleptBetween(older: Copy, newer: Copy, now: Clocks, start: Start): boolean {
  if (!comparable(older, start) || !comparable(newer, start) || older.wall === null || newer.wall === null) return true;
  const steadyGap = newer.steady! - older.steady!;
  return steadyGap < 0 || newer.wall - older.wall - steadyGap >= SLEPT_MS;
}

export interface Letting {
  now: Clocks;
  start: Start;
  /** The newest copy that is settled and known whole, or null with none. */
  anchor: Copy | null;
  /** At a save, the copy that was the newest before it. */
  replaced?: Copy;
  /** Copies before this place are from before a clear: never read again. */
  readable: number;
}

/**
 * The copies that can go. Every one from before a clear, and every one older than the anchor. Of the copies newer
 * than it, kept while no more than MOST_COPIES are kept in all, the anchor among them, in this order: the newest; the
 * older of the newest neighbouring pair the phone may have slept between (the copy before the latest sleep); the copy
 * a save replaced, when the phone's clock says it was written a minute or more ago; then, newest first, the newest of
 * each minute of steady time; then the copies the steady clock may be wrong about. Besides, every one whose steady
 * time cannot be set beside this session's (`comparable`) is kept until it settles, whatever the count: under React
 * Native 0.88's clock, only a copy of another boot just as the phone or this start began, or one an earlier build named
 * with no time.
 *
 * So, while the minutes find room, a copy that goes for being in a minute with a newer one has that newer one, or a
 * settled one newer still, less than a minute after it by the steady clock, whatever goes later: the minute does not
 * move. The four rules before the minutes keep four at most, the anchor among them, so there is always room for one.
 */
export function toLetGo(copies: readonly Copy[], letting: Letting): Copy[] {
  const { anchor, now, start, replaced, readable } = letting;
  const sorted = newestFirst(copies);
  const go: Copy[] = [];
  const newer: Copy[] = [];
  for (const copy of sorted) {
    if (copy.order < readable || (anchor && copy.order < anchor.order)) go.push(copy);
    else if (copy !== anchor) newer.push(copy);
  }
  if (newer.length === 0) return go;
  const chain = anchor ? [...newer, anchor] : newer;
  const slept = (i: number) => sleptBetween(chain[i + 1], chain[i], now, start);
  // The phone may have started between two copies of different starts of the app, and the steady clock does not show
  // it once the later start has read it past the older copy's time.
  const restarted = (i: number) => chain[i].session == null || chain[i].session !== chain[i + 1].session;
  let pinned = 0;
  while (pinned + 1 < chain.length && !slept(pinned)) pinned++;
  const keep = new Set<Copy>();
  const room = () => keep.size + (anchor ? 1 : 0) < MOST_COPIES;
  /** Keep a copy newer than the anchor, while there is room or `always`. */
  const take = (copy: Copy | undefined, always = false) => {
    if (copy && newer.includes(copy) && (always || room())) keep.add(copy);
  };
  take(newer[0]);
  // The older copy of the newest pair the phone may have slept between: the copy before the latest sleep.
  if (pinned + 1 < chain.length) take(chain[pinned + 1]);
  if (replaced && replaced.wall !== null && replaced.wall <= now.wall && now.wall - replaced.wall >= MINUTE_MS) take(replaced);
  const minutes = new Set<number>();
  for (const copy of newer) {
    if (!comparable(copy, start)) take(copy, true);
    else {
      const minute = Math.floor(copy.steady! / MINUTE_MS);
      if (!minutes.has(minute)) take(copy);
      minutes.add(minute);
    }
  }
  // Then, newest first, the copies the steady clock may be wrong about: the copy before each pair older than the one
  // above that the phone may have slept between (the phone's clock jumping forward looks like a sleep, so that one may
  // not be the latest), and the last copy of each start of the app before the next (the phone may have started between
  // them, and once the next start has read the steady clock past that copy's time the steady time between them says
  // nothing of the awake time between them).
  for (let i = 0; i + 1 < chain.length && room(); i++) {
    if (restarted(i) || (i > pinned && slept(i))) take(chain[i + 1]);
  }
  for (const copy of newer) if (!keep.has(copy)) go.push(copy);
  return go;
}

/**
 * How long until the first copy that has not settled yet does, by the steady clock, or null with none that will: for
 * the timer that tidies with the app idle.
 */
export function settlesIn(copies: readonly Copy[], now: Clocks, start: Start): number | null {
  let soonest: number | null = null;
  for (const copy of copies) {
    if (isSettled(copy, now, start)) continue;
    let wait = copy.firstSeen + SETTLED_MS - now.steady;
    if (copy.steady !== null && copy.steady <= now.steady) wait = Math.min(wait, copy.steady + SETTLED_MS - now.steady);
    soonest = soonest === null ? wait : Math.min(soonest, wait);
  }
  return soonest === null ? null : Math.max(0, soonest);
}

// ---- Emptying the phone, and taking one person's records off it ------------------------------

/**
 * Why the copies from before a save are let go of as soon as it has settled, whatever the rules above: `clear`
 * empties the phone (signing out of it, clearing it, deleting an account with it), and nothing of what was on it may
 * come back; `drop` takes one person's account and hourly rate off it, and the rest of what is on it must not be lost
 * meanwhile.
 */
export type Forgetting = 'clear' | 'drop';

/**
 * A mark beside the records, empty, whose name says it all: a clear or a drop was made, and a copy at `after` or later
 * is from after it; or (`undone`) a drop was made and a power cut undid it, until the store makes it again. A drop's
 * mark names whose account it took off (`id`), so that the store can make one a power cut undid again by itself.
 */
export interface Marker {
  name: string;
  how: Forgetting | 'undone';
  /** The first place a copy made after it takes. */
  after: number;
  /** A drop's, or an undone drop's: the id of the account it took off, as the store named it. */
  id?: string;
}

const MARKS: Record<Marker['how'], string> = { clear: 'cleared', drop: 'dropped', undone: 'undone' };

/** An id a mark's name can hold: the store's own ids (`uid`), letters, digits and underscores. Any other is left out. */
const ID = /^[A-Za-z0-9_]{1,80}$/;

/** A mark's file name: what it is, the first place after it, and, for a drop, whose account it took off. */
export function markerName(key: string, how: Marker['how'], after: number, id?: string): string {
  const whose = how !== 'clear' && id !== undefined && ID.test(id) ? `-${id}` : '';
  return `${key}.${MARKS[how]}-${after}${whose}.json`;
}

/** The mark a file name is, or null when it is no mark of `key`. */
export function markerOf(key: string, name: string): Marker | null {
  const found = new RegExp(`^${escape(key)}\\.(cleared|dropped|undone)-(\\d+)(?:-([A-Za-z0-9_]{1,80}))?\\.json$`).exec(name);
  const after = wholeIn(found?.[2]);
  if (!found || after === null) return null;
  const how = found[1] === 'cleared' ? 'clear' : found[1] === 'dropped' ? 'drop' : 'undone';
  return found[3] !== undefined && how !== 'clear' ? { name, how, after, id: found[3] } : { name, how, after };
}

/**
 * The first place a read may take a copy from: past every one from before a clear, which is never read again. A copy
 * from before a drop is still read when nothing newer is whole, since the rest of the records are in it.
 */
export function readableAfter(markers: readonly Marker[]): number {
  return markers.reduce((most, m) => (m.how === 'clear' ? Math.max(most, m.after) : most), 0);
}

/** The first place past every copy from before the latest clear or drop: a new copy takes no place before it. */
export function forgottenBefore(markers: readonly Marker[]): number {
  return markers.reduce((most, m) => (m.how === 'undone' ? most : Math.max(most, m.after)), 0);
}
