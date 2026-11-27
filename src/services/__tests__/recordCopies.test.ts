/**
 * The rules for the records' checkpoints on Android (recordCopies.ts): copies of the records file kept aside, by a
 * rename, at most once a minute, so that a whole copy that has had time to reach the disk is always there. The
 * clock is passed in, so these run on a made-up one.
 */
import {
  CHECKPOINT_EVERY_MS,
  checkpointDue,
  checkpointName,
  checkpointOrder,
  newestFirst,
  nextOrder,
  isSettled,
  SETTLED_MS,
  toLetGo,
  type Checkpoint,
} from '../recordCopies';

const KEY = 'us-mine-crew-records';
const NOW = 1_800_000_000_000;
const MIN = 60_000;

const cp = (order: number, writtenAt: number | null, known = true): Checkpoint => ({ name: checkpointName(KEY, order), order, writtenAt, known });

describe('checkpoint names', () => {
  it('names a checkpoint after its key and its place, and reads the place back', () => {
    expect(checkpointName(KEY, NOW)).toBe(`${KEY}.cp-${NOW}.json`);
    expect(checkpointOrder(KEY, checkpointName(KEY, NOW))).toBe(NOW);
  });

  it('reads the copy before that an earlier build of this version kept (.prev) as the oldest checkpoint', () => {
    expect(checkpointOrder(KEY, `${KEY}.json.prev`)).toBe(0);
  });

  it('takes no other file for a checkpoint: not another key’s, not the file or its copies, not a name that is not one', () => {
    expect(checkpointOrder(KEY, `us-mine-crew.cp-${NOW}.json`)).toBeNull();
    expect(checkpointOrder('us-mine-crew', `${KEY}.cp-${NOW}.json`)).toBeNull();
    for (const end of ['', '.next', '.part']) expect(checkpointOrder(KEY, `${KEY}.json${end}`)).toBeNull();
    for (const name of [`${KEY}.cp-.json`, `${KEY}.cp-12a.json`, `${KEY}.cp-12.json.part`, `${KEY}.cp-1e30.json`, 'export.xlsx']) {
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
});

describe('when the file is kept aside as a checkpoint', () => {
  it('with none yet', () => {
    expect(checkpointDue([], NOW, undefined)).toBe(true);
  });

  it('once what the newest one holds is a minute old', () => {
    expect(checkpointDue([cp(1, NOW - MIN + 1)], NOW, undefined)).toBe(false);
    expect(checkpointDue([cp(1, NOW - MIN)], NOW, undefined)).toBe(true);
  });

  it('goes by the newest by its place, not the newest by its clock', () => {
    expect(checkpointDue([cp(2, NOW - 2 * MIN), cp(1, NOW)], NOW, undefined)).toBe(true);
    expect(checkpointDue([cp(2, NOW), cp(1, NOW - 9 * MIN)], NOW, undefined)).toBe(false);
  });

  it('when the phone cannot say when the newest was written, or its clock has gone back past it', () => {
    expect(checkpointDue([cp(1, null)], NOW, undefined)).toBe(true);
    expect(checkpointDue([cp(1, NOW + MIN + 1)], NOW, undefined)).toBe(true);
    expect(checkpointDue([cp(1, NOW + 10_000)], NOW, undefined)).toBe(false);
  });

  it('at most once a minute in a session, even when what the newest holds is older', () => {
    const old = [cp(1, NOW - 10 * MIN)];
    expect(checkpointDue(old, NOW, NOW - 1_000)).toBe(false);
    expect(checkpointDue(old, NOW, NOW - CHECKPOINT_EVERY_MS)).toBe(true);
    // A clock that went back is no reason to wait.
    expect(checkpointDue(old, NOW, NOW + 5 * MIN)).toBe(true);
  });
});

describe('a settled checkpoint', () => {
  it('is one written two minutes ago or more', () => {
    expect(SETTLED_MS).toBe(2 * MIN);
    expect(isSettled(cp(1, NOW - SETTLED_MS + 1), NOW)).toBe(false);
    expect(isSettled(cp(1, NOW - SETTLED_MS), NOW)).toBe(true);
  });

  it('is never one the phone cannot date, or one dated after now', () => {
    expect(isSettled(cp(1, null), NOW)).toBe(false);
    expect(isSettled(cp(1, NOW + 10 * MIN), NOW)).toBe(false);
  });
});

describe('the checkpoints let go of', () => {
  it('none while none is settled', () => {
    expect(toLetGo([cp(3, NOW - MIN), cp(2, NOW - 90_000), cp(1, NOW - 100_000)], NOW)).toEqual([]);
  });

  it('only the ones older than the newest settled one', () => {
    const list = [cp(5, NOW), cp(4, NOW - MIN), cp(3, NOW - 2 * MIN), cp(2, NOW - 3 * MIN), cp(1, NOW - 4 * MIN)];
    expect(toLetGo(list, NOW).map((c) => c.order)).toEqual([2, 1]);
  });

  it('never because of one this session does not know to be whole: it may be torn', () => {
    const list = [cp(3, NOW - 5 * MIN, false), cp(2, NOW - 6 * MIN), cp(1, NOW - 7 * MIN, false)];
    // 3 is settled but not known whole: 2, known and settled, is the one that counts.
    expect(toLetGo(list, NOW).map((c) => c.order)).toEqual([1]);
    expect(toLetGo([cp(2, NOW - 5 * MIN, false), cp(1, NOW - 6 * MIN, false)], NOW)).toEqual([]);
  });

  it('keeps the newest settled one itself, and every one newer', () => {
    const list = [cp(3, NOW), cp(2, NOW - 2 * MIN), cp(1, NOW - 3 * MIN)];
    const kept = list.filter((c) => !toLetGo(list, NOW).includes(c)).map((c) => c.order);
    expect(kept).toEqual([3, 2]);
  });
});
