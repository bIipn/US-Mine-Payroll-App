/**
 * The rules for the records' checkpoints on Android (recordCopies.ts): copies of the records file kept aside, by a
 * rename, at most once a minute, so that a whole copy that has had time to reach the disk is always there. Both
 * clocks are passed in, so these run on made-up ones: the phone's clock, which can jump, and a steady one, which
 * cannot and is the only one that says a copy has reached the disk.
 */
import {
  afterEvery,
  CHECKPOINT_EVERY_MS,
  checkpointDue,
  checkpointName,
  checkpointOrder,
  forgottenBefore,
  heldAfter,
  markerName,
  markerOf,
  newestFirst,
  nextOrder,
  isSettled,
  readableAfter,
  SETTLED_MS,
  settlesIn,
  toLetGo,
  type Checkpoint,
} from '../recordCopies';

const KEY = 'us-mine-crew-records';
/** The phone's clock now, and the steady clock now. */
const NOW = 1_800_000_000_000;
const STEADY = 50_000_000;
const MIN = 60_000;
const at = (wall = NOW, steady = STEADY) => ({ wall, steady });

/** A checkpoint at a place, its phone-clock date, how long this session has held it (steady), and whether known whole. */
const cp = (order: number, writtenAt: number | null, heldFor: number | null = writtenAt === null ? null : NOW - writtenAt, known = true): Checkpoint => ({
  name: checkpointName(KEY, order),
  order,
  writtenAt,
  since: heldFor === null ? null : STEADY - heldFor,
  known,
});

describe('checkpoint names', () => {
  it('names a checkpoint after its key and its place, and reads the place back', () => {
    expect(checkpointName(KEY, NOW)).toBe(`${KEY}.cp-${NOW}.json`);
    expect(checkpointOrder(KEY, checkpointName(KEY, NOW))).toBe(NOW);
  });

  it('reads the copy before that an earlier build of this version kept (.prev) as the oldest checkpoint', () => {
    expect(checkpointOrder(KEY, `${KEY}.json.prev`)).toBe(0);
  });

  it('takes no other file for a checkpoint: not another key’s, not the file or its copies, not a mark of a clear, not a name that is not one', () => {
    expect(checkpointOrder(KEY, `us-mine-crew.cp-${NOW}.json`)).toBeNull();
    expect(checkpointOrder('us-mine-crew', `${KEY}.cp-${NOW}.json`)).toBeNull();
    for (const end of ['', '.next', '.part']) expect(checkpointOrder(KEY, `${KEY}.json${end}`)).toBeNull();
    for (const name of [`${KEY}.cp-.json`, `${KEY}.cp-12a.json`, `${KEY}.cp-12.json.part`, `${KEY}.cp-1e30.json`, 'export.xlsx', markerName(KEY, 'clear', 5), markerName(KEY, 'drop', 5)]) {
      expect(checkpointOrder(KEY, name)).toBeNull();
    }
  });

  it('puts them newest first by their place, whatever their clocks say', () => {
    const list = [cp(2, NOW), cp(9, NOW - 5 * MIN), cp(0, NOW)];
    expect(newestFirst(list).map((c) => c.order)).toEqual([9, 2, 0]);
  });

  it('gives a new one a place after every other, even when the clock has gone back', () => {
    expect(nextOrder([cp(NOW - MIN, NOW)], NOW)).toBe(NOW);
    expect(nextOrder([], NOW)).toBe(NOW);
    expect(nextOrder([cp(NOW + 3 * MIN, NOW)], NOW)).toBe(NOW + 3 * MIN + 1);
  });

  it('and never one before the first place after a clear or a drop', () => {
    expect(nextOrder([], NOW - 5 * MIN, NOW)).toBe(NOW);
    expect(nextOrder([cp(NOW + MIN, NOW)], NOW, NOW + 2 * MIN)).toBe(NOW + 2 * MIN);
  });
});

describe('when the file is kept aside as a checkpoint', () => {
  it('with none yet', () => {
    expect(checkpointDue([], at(), undefined)).toBe(true);
  });

  it('once what the newest one holds is a minute old', () => {
    expect(checkpointDue([cp(1, NOW - MIN + 1)], at(), undefined)).toBe(false);
    expect(checkpointDue([cp(1, NOW - MIN)], at(), undefined)).toBe(true);
  });

  it('goes by the newest by its place, not the newest by its clock', () => {
    expect(checkpointDue([cp(2, NOW - 2 * MIN), cp(1, NOW)], at(), undefined)).toBe(true);
    expect(checkpointDue([cp(2, NOW), cp(1, NOW - 9 * MIN)], at(), undefined)).toBe(false);
  });

  it('when the phone cannot say when the newest was written, or its clock has gone back past it', () => {
    expect(checkpointDue([cp(1, null)], at(), undefined)).toBe(true);
    expect(checkpointDue([cp(1, NOW + MIN + 1)], at(), undefined)).toBe(true);
    expect(checkpointDue([cp(1, NOW + 10_000)], at(), undefined)).toBe(false);
  });

  it('at most once a minute in a session by the steady clock, whatever the phone’s clock does', () => {
    const old = [cp(1, NOW - 10 * MIN)];
    expect(checkpointDue(old, at(), STEADY - 1_000)).toBe(false);
    expect(checkpointDue(old, at(), STEADY - CHECKPOINT_EVERY_MS)).toBe(true);
    // The phone's clock jumping an hour either way changes nothing: the last one was made a second ago.
    expect(checkpointDue(old, at(NOW + 60 * MIN), STEADY - 1_000)).toBe(false);
    expect(checkpointDue(old, at(NOW - 60 * MIN), STEADY - 1_000)).toBe(false);
  });
});

describe('a settled copy', () => {
  it('is one this session has held two minutes or more by the steady clock', () => {
    expect(SETTLED_MS).toBe(2 * MIN);
    expect(isSettled(cp(1, NOW, SETTLED_MS - 1), STEADY)).toBe(false);
    expect(isSettled(cp(1, NOW, SETTLED_MS), STEADY)).toBe(true);
  });

  it('is never judged by the phone’s clock, which can jump: a copy written seconds ago and dated an hour ago is not settled', () => {
    expect(isSettled(cp(1, NOW - 60 * MIN, 5_000), STEADY)).toBe(false);
    // And one dated after now, by a clock that has gone back, is settled once it has been held long enough.
    expect(isSettled(cp(1, NOW + 60 * MIN, 3 * MIN), STEADY)).toBe(true);
  });

  it('is never one this session has no time for, or one it saw after now', () => {
    expect(isSettled(cp(1, NOW, null), STEADY)).toBe(false);
    expect(isSettled(cp(1, NOW, -10 * MIN), STEADY)).toBe(false);
  });
});

describe('the checkpoints let go of', () => {
  it('none while none is settled', () => {
    expect(toLetGo([cp(3, NOW - MIN), cp(2, NOW - 90_000), cp(1, NOW - 100_000)], STEADY)).toEqual([]);
  });

  it('only the ones older than the newest settled one', () => {
    const list = [cp(5, NOW), cp(4, NOW - MIN), cp(3, NOW - 2 * MIN), cp(2, NOW - 3 * MIN), cp(1, NOW - 4 * MIN)];
    expect(toLetGo(list, STEADY).map((c) => c.order)).toEqual([2, 1]);
  });

  it('after the phone’s clock jumps forward an hour, still only those older than one held two minutes', () => {
    // Held 2 s, 54 s, 114 s and 174 s, and every one dated more than an hour ago by the clock that jumped.
    const list = [cp(4, NOW - 61 * MIN, 2_000), cp(3, NOW - 62 * MIN, 54_000), cp(2, NOW - 63 * MIN, 114_000), cp(1, NOW - 64 * MIN, 174_000), cp(0, NOW - 65 * MIN, 234_000)];
    expect(toLetGo(list, STEADY).map((c) => c.order)).toEqual([0]);
  });

  it('never because of one this session does not know to be whole: it may be torn', () => {
    const list = [cp(3, NOW - 5 * MIN, 5 * MIN, false), cp(2, NOW - 6 * MIN), cp(1, NOW - 7 * MIN, 7 * MIN, false)];
    // 3 is settled but not known whole: 2, known and settled, is the one that counts.
    expect(toLetGo(list, STEADY).map((c) => c.order)).toEqual([1]);
    expect(toLetGo([cp(2, NOW - 5 * MIN, 5 * MIN, false), cp(1, NOW - 6 * MIN, 6 * MIN, false)], STEADY)).toEqual([]);
  });

  it('keeps the newest settled one itself, and every one newer', () => {
    const list = [cp(3, NOW), cp(2, NOW - 2 * MIN), cp(1, NOW - 3 * MIN)];
    const kept = list.filter((c) => !toLetGo(list, STEADY).includes(c)).map((c) => c.order);
    expect(kept).toEqual([3, 2]);
  });
});

describe('the marks of a clear and of a drop', () => {
  it('name the first place a copy after it takes, and read it back', () => {
    expect(markerName(KEY, 'clear', NOW)).toBe(`${KEY}.cleared-${NOW}.json`);
    expect(markerName(KEY, 'drop', NOW)).toBe(`${KEY}.dropped-${NOW}.json`);
    expect(markerOf(KEY, markerName(KEY, 'clear', NOW))).toEqual({ name: markerName(KEY, 'clear', NOW), how: 'clear', after: NOW });
    expect(markerOf(KEY, markerName(KEY, 'drop', 0))).toEqual({ name: markerName(KEY, 'drop', 0), how: 'drop', after: 0 });
  });

  it('are no other file: not a checkpoint, not the file, not another key’s', () => {
    for (const name of [checkpointName(KEY, NOW), `${KEY}.json`, `${KEY}.json.prev`, `us-mine-crew.cleared-5.json`, `${KEY}.cleared-.json`, `${KEY}.cleared-5x.json`, `${KEY}.cleared-1e30.json`]) {
      expect(markerOf(KEY, name)).toBeNull();
    }
  });

  it('a copy after a clear or a drop takes a place past every checkpoint there was', () => {
    expect(afterEvery([])).toBe(0);
    expect(afterEvery([cp(0, NOW)])).toBe(1);
    expect(afterEvery([cp(7, NOW), cp(NOW, NOW), cp(3, NOW)])).toBe(NOW + 1);
  });

  it('a read takes no checkpoint from before a clear, and does take one from before a drop', () => {
    const marks = [markerOf(KEY, markerName(KEY, 'drop', 40))!, markerOf(KEY, markerName(KEY, 'clear', 20))!, markerOf(KEY, markerName(KEY, 'clear', 30))!];
    expect(readableAfter(marks)).toBe(30);
    expect(readableAfter(marks.slice(0, 1))).toBe(0);
    expect(readableAfter([])).toBe(0);
    // What goes once a copy after them has settled: everything from before the latest of them.
    expect(forgottenBefore(marks)).toBe(40);
    expect(forgottenBefore([])).toBe(0);
  });

  it('what came before goes once a copy after it, known whole, has been held two minutes by the steady clock', () => {
    const after = 10;
    // The file written after (at no place: newer than every checkpoint), held a minute: not yet.
    const file = { order: Number.POSITIVE_INFINITY, since: STEADY - MIN, known: true };
    expect(heldAfter([cp(9, NOW - 60 * MIN, 60 * MIN), file], after, STEADY)).toBe(false);
    expect(heldAfter([{ ...file, since: STEADY - SETTLED_MS }], after, STEADY)).toBe(true);
    // A checkpoint from after, settled, counts; one this session does not know whole does not.
    expect(heldAfter([cp(10, NOW, SETTLED_MS)], after, STEADY)).toBe(true);
    expect(heldAfter([cp(11, NOW, SETTLED_MS, false)], after, STEADY)).toBe(false);
  });

  it('a timer waits until the first copy that is not settled yet has been held two minutes', () => {
    expect(settlesIn([], STEADY)).toBeNull();
    expect(settlesIn([{ since: null }], STEADY)).toBeNull();
    expect(settlesIn([{ since: STEADY - 30_000 }, { since: STEADY - 90_000 }], STEADY)).toBe(30_000);
    expect(settlesIn([{ since: STEADY - 3 * MIN }], STEADY)).toBe(0);
  });
});
