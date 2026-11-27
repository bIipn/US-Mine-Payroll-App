/**
 * The rules for the records' checkpoints on Android (storage.native.ts keeps the files): pure, with both clocks
 * passed in.
 *
 * expo-file-system cannot make a write reach the disk before the app goes on: File.write closes its stream with no
 * fsync, and a move over a file deletes that file before it renames, so the kernel is never told to put the new
 * copy on the disk before the rename. A copy written in the last half a minute or so can be torn by a power cut,
 * a forced restart or a kernel crash, and the file is saved several times within seconds of a punch. So the file
 * is kept aside now and then, by a rename (which keeps what it holds and when it was written), as a checkpoint: at
 * most once a minute, and an old one goes only once a newer one has had time to reach the disk. There is always a
 * whole copy on the disk at most about three minutes old, a few checkpoints at most, and nothing extra is written.
 *
 * Two clocks. The phone's clock (Date.now, and a file's modificationTime) can jump either way: network time setting
 * right a clock that started from zero after the battery ran flat, or someone setting the date by hand. It names and
 * orders the checkpoints, and says when the next is due, but it never says a copy has reached the disk: a clock that
 * jumped forward an hour would make a copy written seconds ago look settled, and let go of every older one. That is
 * the steady clock's (performance.now, which on Android is std::chrono::steady_clock: CLOCK_MONOTONIC, counted from
 * when the phone started and never set). It stops while the phone sleeps, which only makes a copy take longer to
 * count as settled, never less: that errs on the side of keeping copies. It means nothing from one start of the app
 * to the next, so a copy that was there before this session counts as written when this session first saw it.
 */

/** How often, at most, the file is kept aside as a checkpoint. */
export const CHECKPOINT_EVERY_MS = 60_000;

/**
 * How long after it was written a copy is taken to be on the disk ("settled"), by the steady clock. Linux writes a
 * changed page back to the disk once it has been changed for 30 seconds (dirty_expire_centisecs, 3000), looking
 * every 5 seconds (dirty_writeback_centisecs, 500), and ext4 commits its journal every 5 seconds; f2fs checkpoints
 * at least once a minute. Two minutes leaves room for all of that.
 */
export const SETTLED_MS = 120_000;

/** The two clocks, read at the same moment. */
export interface Clocks {
  /** The phone's clock (Date.now): it can jump. For names, order and when a checkpoint is due; never for settling. */
  wall: number;
  /** The steady clock (performance.now): it cannot jump. For how long this session has held a copy. */
  steady: number;
}

export interface Checkpoint {
  /** Its file's name, in the app's files. */
  name: string;
  /** Its place among the checkpoints: a newer one is higher. Not a clock, though it starts from one. */
  order: number;
  /** When what it holds was written by the phone's clock (its file's modificationTime), or null when the phone cannot say. */
  writtenAt: number | null;
  /**
   * By the steady clock, since when this session has held what it holds: when this session wrote it (the copy it
   * was renamed from was written), or, for one that was there before, when this session first saw it. Null when
   * this session has no time for it.
   */
  since: number | null;
  /**
   * Whether this session knows it to be whole: it read it whole, or made it from the file it had read or written.
   * One that was there before is not known: a power cut may have torn it.
   */
  known: boolean;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A whole number that is a place, read from a file name, or null. */
const placeIn = (digits: string | undefined) => {
  const order = Number(digits);
  return digits !== undefined && Number.isSafeInteger(order) ? order : null;
};

/** A checkpoint's file name. */
export function checkpointName(key: string, order: number): string {
  return `${key}.cp-${order}.json`;
}

/**
 * The place of the checkpoint a file name is, or null when it is no checkpoint of `key`. The copy before the last
 * that an earlier build of this version kept beside the file (`.prev`) is read as the oldest checkpoint.
 */
export function checkpointOrder(key: string, name: string): number | null {
  if (name === `${key}.json.prev`) return 0;
  return placeIn(new RegExp(`^${escape(key)}\\.cp-(\\d+)\\.json$`).exec(name)?.[1]);
}

/** The checkpoints, newest first, by their place. */
export function newestFirst<T extends Pick<Checkpoint, 'order'>>(checkpoints: readonly T[]): T[] {
  return [...checkpoints].sort((a, b) => b.order - a.order);
}

/**
 * The place a new checkpoint takes: now by the phone's clock, or just after the newest if that clock has gone back,
 * and never before `floor`, the first place after a clear or a drop that a mark on the phone names.
 */
export function nextOrder(checkpoints: readonly Checkpoint[], wall: number, floor = 0): number {
  const newest = checkpoints.reduce((most, c) => Math.max(most, c.order), -1);
  return Math.max(Math.floor(wall), newest + 1, floor);
}

/**
 * Whether this save keeps the file aside as a checkpoint: when there is none, or what the newest holds is a minute
 * old or more by the phone's clock (or cannot be dated, or is dated more than a minute ahead: the clock has gone
 * back), and this session has not made one in the last minute by the steady clock (`madeAt`, when it last did). A
 * jump of the phone's clock can only make one more checkpoint than it would have, never one fewer than once a minute.
 */
export function checkpointDue(checkpoints: readonly Checkpoint[], now: Clocks, madeAt: number | undefined): boolean {
  if (madeAt !== undefined && now.steady >= madeAt && now.steady - madeAt < CHECKPOINT_EVERY_MS) return false;
  const [newest] = newestFirst(checkpoints);
  if (!newest || newest.writtenAt === null) return true;
  const age = now.wall - newest.writtenAt;
  return age >= CHECKPOINT_EVERY_MS || age < -CHECKPOINT_EVERY_MS;
}

/**
 * Whether a copy has had time to reach the disk: this session has held it two minutes or more by the steady clock.
 * Never by the phone's clock, and never one this session has no time for.
 */
export function isSettled(copy: Pick<Checkpoint, 'since'>, steady: number): boolean {
  return copy.since !== null && steady - copy.since >= SETTLED_MS;
}

/**
 * The checkpoints that can go: those older than the newest one that is settled and known to be whole. Never one
 * newer than that, never that one itself, and nothing while none is both.
 */
export function toLetGo(checkpoints: readonly Checkpoint[], steady: number): Checkpoint[] {
  const sorted = newestFirst(checkpoints);
  const keep = sorted.findIndex((c) => c.known && isSettled(c, steady));
  return keep < 0 ? [] : sorted.slice(keep + 1);
}

// ---- Emptying the phone, and taking one person's records off it ------------------------------

/**
 * Why the copies from before a save are let go of as soon as it has settled, whatever the checkpoints' own rule:
 * `clear` empties the phone (signing out of it, clearing it, deleting an account with it), and nothing of what was
 * on it may come back; `drop` takes one person's account and hourly rate off it, and the rest of what is on it must
 * not be lost meanwhile.
 */
export type Forgetting = 'clear' | 'drop';

/**
 * A mark beside the records that a clear or a drop was made: written before the save that clears, so that a
 * restart or a power cut before that save has settled still knows. Its name says it all: what it holds is nothing.
 */
export interface Marker {
  name: string;
  how: Forgetting;
  /** The first place a checkpoint made after it takes: every one before this is from before it. */
  after: number;
}

const MARKS: Record<Forgetting, string> = { clear: 'cleared', drop: 'dropped' };

/** A mark's file name. */
export function markerName(key: string, how: Forgetting, after: number): string {
  return `${key}.${MARKS[how]}-${after}.json`;
}

/** The mark a file name is, or null when it is no mark of `key`. */
export function markerOf(key: string, name: string): Marker | null {
  const found = new RegExp(`^${escape(key)}\\.(cleared|dropped)-(\\d+)\\.json$`).exec(name);
  const after = placeIn(found?.[2]);
  if (!found || after === null) return null;
  return { name, how: found[1] === 'cleared' ? 'clear' : 'drop', after };
}

/** The first place past every one of these checkpoints: where the checkpoints made after a clear or a drop start. */
export function afterEvery(checkpoints: readonly Pick<Checkpoint, 'order'>[]): number {
  return checkpoints.reduce((most, c) => Math.max(most, c.order + 1), 0);
}

/**
 * The first place a read may take a checkpoint from: past every one from before a clear, which is never read again.
 * A checkpoint from before a drop is still read when nothing newer is whole, since the rest of the records are in it.
 */
export function readableAfter(markers: readonly Marker[]): number {
  return markers.reduce((most, m) => (m.how === 'clear' ? Math.max(most, m.after) : most), 0);
}

/** The first place past every checkpoint from before the latest clear or drop: those go once a copy after it has settled. */
export function forgottenBefore(markers: readonly Marker[]): number {
  return markers.reduce((most, m) => Math.max(most, m.after), 0);
}

/**
 * Whether a copy made after a clear or a drop has settled: one at `after` or later (the file written since counts as
 * newer than every checkpoint), known to be whole, held two minutes by the steady clock. From then on the copies
 * from before it can go: the phone has a whole copy without what was cleared, on the disk.
 */
export function heldAfter(copies: readonly Pick<Checkpoint, 'order' | 'since' | 'known'>[], after: number, steady: number): boolean {
  return copies.some((c) => c.order >= after && c.known && isSettled(c, steady));
}

/**
 * How long until the first of these copies settles, by the steady clock: 0 when one already has, null when none
 * has a time. For the timer that lets go of what came before once it has.
 */
export function settlesIn(copies: readonly Pick<Checkpoint, 'since'>[], steady: number): number | null {
  let soonest: number | null = null;
  for (const { since } of copies) {
    if (since === null) continue;
    const wait = Math.max(0, since + SETTLED_MS - steady);
    soonest = soonest === null ? wait : Math.min(soonest, wait);
  }
  return soonest;
}
