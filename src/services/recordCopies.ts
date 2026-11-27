/**
 * The rules for the records' checkpoints on Android (storage.native.ts keeps the files): pure, with the clock
 * passed in.
 *
 * expo-file-system cannot make a write reach the disk before the app goes on: File.write closes its stream with no
 * fsync, and a move over a file deletes that file before it renames, so the kernel is never told to put the new
 * copy on the disk before the rename. A copy written in the last half a minute or so can be torn by a power cut,
 * a forced restart or a kernel crash, and the file is saved several times within seconds of a punch. So the file
 * is kept aside now and then, by a rename (which keeps what it holds and when it was written), as a checkpoint: at
 * most once a minute, and an old one goes only once a newer one has had time to reach the disk. There is always a
 * whole copy on the disk at most about three minutes old, a few checkpoints at most, and nothing extra is written.
 */

/** How often, at most, the file is kept aside as a checkpoint. */
export const CHECKPOINT_EVERY_MS = 60_000;

/**
 * How long after it was written a copy is taken to be on the disk ("settled"). Linux writes a changed page back to
 * the disk once it has been changed for 30 seconds (dirty_expire_centisecs, 3000), looking every 5 seconds
 * (dirty_writeback_centisecs, 500), and ext4 commits its journal every 5 seconds; f2fs checkpoints at least once a
 * minute. Two minutes leaves room for all of that.
 */
export const SETTLED_MS = 120_000;

export interface Checkpoint {
  /** Its file's name, in the app's files. */
  name: string;
  /** Its place among the checkpoints: a newer one is higher. Not a clock, though it starts from one. */
  order: number;
  /** When what it holds was written (its file's modificationTime), or null when the phone cannot say. */
  writtenAt: number | null;
  /**
   * Whether this session knows it to be whole: it read it whole, or made it from the file it had read or written.
   * One that was there before is not known: a power cut may have torn it.
   */
  known: boolean;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const found = new RegExp(`^${escape(key)}\\.cp-(\\d+)\\.json$`).exec(name);
  if (!found) return null;
  const order = Number(found[1]);
  return Number.isSafeInteger(order) ? order : null;
}

/** The checkpoints, newest first, by their place. */
export function newestFirst(checkpoints: readonly Checkpoint[]): Checkpoint[] {
  return [...checkpoints].sort((a, b) => b.order - a.order);
}

/** The place a new checkpoint takes: now, or just after the newest if the clock has gone back. */
export function nextOrder(checkpoints: readonly Checkpoint[], now: number): number {
  const newest = checkpoints.reduce((most, c) => Math.max(most, c.order), -1);
  return Math.max(Math.floor(now), newest + 1);
}

/**
 * Whether this save keeps the file aside as a checkpoint: when there is none, or what the newest holds is a minute
 * old or more (or cannot be dated, or is dated more than a minute ahead: the clock has gone back), and this session
 * has not made one in the last minute (`madeAt`, when it last did).
 */
export function checkpointDue(checkpoints: readonly Checkpoint[], now: number, madeAt: number | undefined): boolean {
  if (madeAt !== undefined && now >= madeAt && now - madeAt < CHECKPOINT_EVERY_MS) return false;
  const [newest] = newestFirst(checkpoints);
  if (!newest || newest.writtenAt === null) return true;
  const age = now - newest.writtenAt;
  return age >= CHECKPOINT_EVERY_MS || age < -CHECKPOINT_EVERY_MS;
}

/** Whether a copy has had time to reach the disk: written two minutes ago or more, by a clock not gone back. */
export function isSettled(copy: Pick<Checkpoint, 'writtenAt'>, now: number): boolean {
  return copy.writtenAt !== null && now - copy.writtenAt >= SETTLED_MS;
}

/**
 * The checkpoints that can go: those older than the newest one that is settled and known to be whole. Never one
 * newer than that, never that one itself, and nothing while none is both.
 */
export function toLetGo(checkpoints: readonly Checkpoint[], now: number): Checkpoint[] {
  const sorted = newestFirst(checkpoints);
  const keep = sorted.findIndex((c) => c.known && isSettled(c, now));
  return keep < 0 ? [] : sorted.slice(keep + 1);
}
