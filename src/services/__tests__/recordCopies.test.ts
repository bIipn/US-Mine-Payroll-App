/**
 * The rules for the copies of the records on Android (recordCopies.ts): each save is a copy of its own, named by its
 * place and by when it was written on the steady clock, and older copies go by these rules, so that a whole copy that
 * has had time to reach the disk is always there and a few copies at most. Both clocks are passed in, so these run on
 * made-up ones: the phone's clock, which can jump, and a steady one, which cannot and is the only one that says a copy
 * has reached the disk.
 */
import {
  afterEvery,
  BOOT_CLOCK_MS,
  bootClock,
  comparable,
  copyName,
  copyOf,
  forgottenBefore,
  fromEarlierBoot,
  isSettled,
  markerName,
  markerOf,
  MINUTE_MS,
  MOST_COPIES,
  newestFirst,
  nextOrder,
  placeName,
  readableAfter,
  SETTLED_MS,
  settledNewestFirst,
  settlesIn,
  SLEPT_MS,
  sleptBetween,
  toLetGo,
  type Copy,
  type CopyClock,
  type Letting,
} from '../recordCopies';

const KEY = 'us-mine-crew-records';
/** The phone's clock now, and the steady clock now: the phone has been on for about fourteen hours. */
const NOW = 1_800_000_000_000;
const STEADY = 50_000_000;
const MIN = 60_000;
const now = (wall = NOW, steady = STEADY) => ({ wall, steady });
/** This session first read the records a second ago, by a clock that counts from the phone's start. */
const START = { startedAt: STEADY - 1_000 };
/** The start of the app before it, in the same boot: it first read the records half an hour ago. */
const EARLIER = STEADY - 30 * MIN;

/**
 * A copy written `ago` ms before now by the steady clock, at the same time by the phone's clock unless `asleep` says
 * the phone slept that long since, or `wall` gives its date. By the start of the app before this one (EARLIER), in
 * this boot, unless `own` or `session` says otherwise; first seen by this session when it read the records.
 */
function at(
  order: number,
  ago: number,
  options: { own?: boolean; known?: boolean; asleep?: number; wall?: number | null; clock?: CopyClock; firstSeen?: number; session?: number | null } = {},
): Copy {
  const steady = STEADY - ago;
  const clock = options.clock === undefined ? 'boot' : options.clock;
  const wall = options.wall === undefined ? NOW - ago - (options.asleep ?? 0) : options.wall;
  const session = clock === null ? null : options.session !== undefined ? options.session : options.own ? START.startedAt : EARLIER;
  return {
    name: clock === null ? placeName(KEY, order) : copyName(KEY, order, steady, clock, session),
    order,
    steady: clock === null ? null : steady,
    clock,
    session,
    wall,
    firstSeen: options.firstSeen ?? (options.own ? steady : START.startedAt),
    own: options.own ?? false,
    known: options.known ?? options.own ?? false,
  };
}

const letting = (anchor: Copy | null, more: Partial<Letting> = {}): Letting => ({ now: now(), start: START, anchor, readable: 0, ...more });
const names = (copies: readonly Copy[]) => copies.map((c) => c.order).sort((a, b) => a - b);

describe('copy names', () => {
  it('name a copy by its key, its place, its steady time and the start of the app that wrote it, and read them back', () => {
    expect(copyName(KEY, NOW, 7_000_000.4, 'boot', 6_990_000.7)).toBe(`${KEY}.cp-${NOW}-b7000001-s6990000.json`);
    expect(copyOf(KEY, copyName(KEY, NOW, 7_000_000, 'boot', 6_990_000))).toEqual({ order: NOW, steady: 7_000_000, clock: 'boot', session: 6_990_000 });
    // A name with no start in it, as this build's first copies had: read the same, the start unknown.
    expect(copyName(KEY, NOW, 7_000_000.4, 'boot')).toBe(`${KEY}.cp-${NOW}-b7000001.json`);
    expect(copyOf(KEY, copyName(KEY, NOW, 7_000_000, 'boot'))).toEqual({ order: NOW, steady: 7_000_000, clock: 'boot' });
    expect(copyOf(KEY, copyName(KEY, NOW, 4_000, 'app'))).toEqual({ order: NOW, steady: 4_000, clock: 'app' });
    expect(copyOf(KEY, copyName(KEY, NOW, 9_000, 'earlier'))).toEqual({ order: NOW, steady: 9_000, clock: 'earlier' });
  });

  it('read the checkpoints and the copy before the last that earlier builds kept as copies with no steady time', () => {
    expect(copyOf(KEY, placeName(KEY, NOW))).toEqual({ order: NOW, steady: null, clock: null });
    expect(copyOf(KEY, `${KEY}.cp-${NOW}.json`)).toEqual({ order: NOW, steady: null, clock: null });
    expect(copyOf(KEY, `${KEY}.json.prev`)).toEqual({ order: 0, steady: null, clock: null });
  });

  it('take no other file for a copy: not another key’s, not the file or its copies, not a mark, not a name that is not one', () => {
    expect(copyOf(KEY, `us-mine-crew.cp-${NOW}.json`)).toBeNull();
    expect(copyOf('us-mine-crew', `${KEY}.cp-${NOW}.json`)).toBeNull();
    for (const end of ['', '.next', '.part']) expect(copyOf(KEY, `${KEY}.json${end}`)).toBeNull();
    for (const name of [`${KEY}.cp-.json`, `${KEY}.cp-12a.json`, `${KEY}.cp-12-x5.json`, `${KEY}.cp-12-b.json`, `${KEY}.cp-12-b5-s.json`, `${KEY}.cp-12-s5.json`, `${KEY}.cp-12.json.part`, `${KEY}.cp-1e30.json`, 'export.xlsx']) {
      expect(copyOf(KEY, name)).toBeNull();
    }
    for (const how of ['clear', 'drop', 'undone'] as const) expect(copyOf(KEY, markerName(KEY, how, 5))).toBeNull();
  });

  it('put them newest first by their place, whatever their clocks say', () => {
    const list = [at(2, 0), at(9, 5 * MIN), at(0, 0)];
    expect(newestFirst(list).map((c) => c.order)).toEqual([9, 2, 0]);
  });

  it('give a new one a place after every other, even when the clock has gone back, and never before a clear or a drop', () => {
    expect(nextOrder([at(NOW - MIN, 0)], NOW)).toBe(NOW);
    expect(nextOrder([], NOW)).toBe(NOW);
    expect(nextOrder([at(NOW + 3 * MIN, 0)], NOW)).toBe(NOW + 3 * MIN + 1);
    expect(nextOrder([], NOW - 5 * MIN, NOW)).toBe(NOW);
    expect(afterEvery([at(4, 0), at(9, 0)])).toBe(10);
    expect(afterEvery([])).toBe(0);
  });
});

describe('the steady clock of another start', () => {
  it('counts from the phone’s start when it read BOOT_CLOCK_MS or more as the records were first read', () => {
    expect(bootClock({ startedAt: BOOT_CLOCK_MS })).toBe(true);
    expect(bootClock({ startedAt: BOOT_CLOCK_MS - 1 })).toBe(false);
  });

  it('is set beside this session’s for a copy written before this session started, in a boot clock, and for one this session wrote', () => {
    expect(comparable(at(1, 11 * MIN), START)).toBe(true);
    expect(comparable(at(1, 0, { own: true }), START)).toBe(true);
    // Not one written after this session started that it did not write: an earlier boot's.
    expect(comparable(at(1, 500), START)).toBe(false);
    // Not one by a clock that may count from the app's start, nor one with no time, nor one found to be from an earlier boot.
    for (const clock of ['app', null, 'earlier'] as const) expect(comparable(at(1, 11 * MIN, { clock }), START)).toBe(false);
    // Never by a session whose own clock may count from the app's start.
    expect(comparable(at(1, 11 * MIN), { startedAt: 2_000 })).toBe(false);
  });

  it('above now in a boot clock is an earlier boot’s, which a start of the phone put on the disk; never so for a clock from the app’s start', () => {
    const later = at(1, -5 * MIN);
    expect(fromEarlierBoot(later, now(), START)).toBe(true);
    expect(isSettled(later, now(), START)).toBe(true);
    expect(fromEarlierBoot(at(1, -5 * MIN, { clock: 'app' }), now(), START)).toBe(false);
    expect(fromEarlierBoot(later, now(), { startedAt: 2_000 })).toBe(false);
    expect(isSettled(later, now(), { startedAt: 2_000 })).toBe(false);
    // Once named so, whatever the clocks say.
    expect(isSettled(at(1, 0, { clock: 'earlier' }), now(), START)).toBe(true);
  });
});

describe('a settled copy', () => {
  it('is one written two minutes or more ago by the steady time in its name, from this session or an earlier one, under either clock', () => {
    expect(isSettled(at(1, SETTLED_MS), now(), START)).toBe(true);
    expect(isSettled(at(1, SETTLED_MS - 1), now(), START)).toBe(false);
    // A clock from the app's start: an earlier start's time is below this one's, so the awake time since is longer still.
    expect(isSettled(at(1, SETTLED_MS, { clock: 'app' }), now(), { startedAt: 0 })).toBe(true);
  });

  it('or one this session has held two minutes, whatever its name says', () => {
    expect(isSettled(at(1, 0, { clock: null, firstSeen: STEADY - SETTLED_MS }), now(), START)).toBe(true);
    expect(isSettled(at(1, 0, { clock: null, firstSeen: STEADY - SETTLED_MS + 1 }), now(), START)).toBe(false);
  });

  it('is never judged by the phone’s clock, which can jump: a copy written seconds ago and dated an hour ago is not settled', () => {
    expect(isSettled(at(1, 5_000, { wall: NOW - 60 * MIN }), now(), START)).toBe(false);
  });

  it('newest first, for the storage to take the anchor from: the newest it knows whole', () => {
    const copies = [at(1, 10 * MIN), at(2, 3 * MIN), at(3, MIN)];
    expect(settledNewestFirst(copies, now(), START).map((c) => c.order)).toEqual([2, 1]);
  });
});

describe('a sleep between two copies', () => {
  it('is the phone’s clock moving on SLEPT_MS or more beyond the steady one, as a sleep or a jump forward does', () => {
    const before = at(1, 20_000, { asleep: SLEPT_MS });
    expect(sleptBetween(before, at(2, 10_000, { own: true }), now(), START)).toBe(true);
    expect(sleptBetween(at(1, 20_000, { asleep: SLEPT_MS - 1 }), at(2, 10_000, { own: true }), now(), START)).toBe(false);
  });

  it('is not the phone’s clock going back: that hides a sleep only as far as it went back', () => {
    expect(sleptBetween(at(1, 20_000, { wall: NOW + 60 * MIN }), at(2, 10_000, { own: true }), now(), START)).toBe(false);
  });

  it('is taken for one when the steady clock cannot show the phone was awake: a time that cannot be set beside it, or no date', () => {
    expect(sleptBetween(at(1, 20_000, { clock: null }), at(2, 10_000, { own: true }), now(), START)).toBe(true);
    expect(sleptBetween(at(1, 20_000, { wall: null }), at(2, 10_000, { own: true }), now(), START)).toBe(true);
  });
});

describe('the copies let go of', () => {
  it('every one older than the anchor, and none while there is no anchor but what the other rules let go of', () => {
    const anchor = at(2, 3 * MIN, { known: true });
    const copies = [at(1, 5 * MIN), anchor, at(3, 0, { own: true })];
    expect(names(toLetGo(copies, letting(anchor)))).toEqual([1]);
    expect(names(toLetGo(copies, letting(null)))).toEqual([]);
  });

  it('of each minute of steady time newer than the anchor, all but the newest', () => {
    // STEADY is 20 s into a minute: 5 s and 15 s ago are in it, 25 s and 50 s ago in the one before.
    const copies = [at(1, 50_000), at(2, 25_000), at(3, 15_000, { own: true }), at(4, 5_000, { own: true })];
    expect(names(toLetGo(copies, letting(null)))).toEqual([1, 3]);
  });

  it('never the newest, nor one whose steady time cannot be set beside this session’s', () => {
    const copies = [at(1, 50_000, { clock: 'app' }), at(2, 45_000, { clock: null }), at(3, 40_000)];
    expect(names(toLetGo(copies, letting(null)))).toEqual([]);
  });

  it('never the copy before the latest sleep, though a newer one of its minute is kept', () => {
    // Asleep an hour after the copy at 15 s; awake since.
    const copies = [at(1, 15_000, { asleep: 60 * MIN }), at(2, 10_000, { own: true }), at(3, 5_000, { own: true })];
    expect(names(toLetGo(copies, letting(null)))).toEqual([2]);
  });

  it('the copies before earlier sleeps too, newest first, while no more than MOST_COPIES are kept in all, the anchor among them', () => {
    // A jump of the phone's clock forward looks like a sleep, so the latest pair may not be the latest sleep.
    const twice = [at(1, 18_000, { asleep: 120 * MIN }), at(2, 16_000, { asleep: 60 * MIN }), at(3, 5_000, { own: true })];
    expect(names(toLetGo(twice, letting(null)))).toEqual([]);
    // Five copies an hour's sleep apart in the last minute, then this session's: the oldest goes.
    const sleeps = [1, 2, 3, 4, 5].map((n) => at(n, 50_000 - n * 5_000, { asleep: (6 - n) * 60 * MIN }));
    const copies = [...sleeps, at(6, 5_000, { own: true })];
    expect(names(toLetGo(copies, letting(null)))).toEqual([1]);
    expect(copies.length - toLetGo(copies, letting(null)).length).toBe(MOST_COPIES);
  });

  it('the last copy of each start of the app before the next, while no more than MOST_COPIES are kept: the phone may have started between them, which the steady clock does not show', () => {
    // The phone started again after copy 2 and the next start read the steady clock past its time: by the steady clock
    // copy 2 is in a minute with copy 3, though it was written minutes of awake time before it.
    const copies = [at(1, 30_000, { session: EARLIER - MIN }), at(2, 25_000), at(3, 15_000, { own: true }), at(4, 5_000, { own: true })];
    expect(names(toLetGo(copies, letting(null)))).toEqual([3]);
    // With no start in their names, every pair may have one between them.
    const unnamed = [at(1, 30_000, { session: null }), at(2, 25_000, { session: null }), at(3, 5_000, { own: true })];
    expect(names(toLetGo(unnamed, letting(null)))).toEqual([]);
  });

  it('never, at a save, the copy it replaced when the phone’s clock says it was written a minute or more ago and not in the future', () => {
    const replaced = at(1, 15_000, { own: true, wall: NOW - MINUTE_MS });
    const copies = [replaced, at(2, 5_000, { own: true })];
    // Asleep or not by the steady clock, that one is the copy before the sleep anyway.
    expect(names(toLetGo(copies, letting(null, { replaced })))).toEqual([]);
    const lately = at(1, 15_000, { own: true, wall: NOW - 20_000 });
    expect(names(toLetGo([lately, at(2, 5_000, { own: true })], letting(null, { replaced: lately })))).toEqual([1]);
    const ahead = at(1, 15_000, { own: true, wall: NOW + MINUTE_MS });
    expect(names(toLetGo([ahead, at(2, 5_000, { own: true })], letting(null, { replaced: ahead })))).toEqual([1]);
  });

  it('every one from before a clear, which is never read again, whatever else would keep it', () => {
    const copies = [at(1, 50_000, { clock: null }), at(2, 40_000, { asleep: 60 * MIN }), at(10, 5_000, { own: true })];
    expect(names(toLetGo(copies, letting(null, { readable: 10 })))).toEqual([1, 2]);
  });

  it('after the phone’s clock jumps forward an hour, still only by the steady clock: one more is kept, none goes sooner', () => {
    const copies = [at(1, 70_000), at(2, 50_000), at(3, 45_000, { own: true }), at(4, 5_000, { own: true })];
    const jumped = { ...now(), wall: NOW + 60 * MIN };
    const gone = names(toLetGo(copies, { ...letting(null), now: jumped }));
    expect(gone).toEqual(names(toLetGo(copies, letting(null))).filter((order) => gone.includes(order)));
  });
});

describe('the timer that tidies with the app idle', () => {
  it('waits until the first copy that has not settled yet does, by the steady time in its name or since this session first saw it', () => {
    expect(settlesIn([at(1, 30_000), at(2, 10_000, { own: true })], now(), START)).toBe(SETTLED_MS - 30_000);
    expect(settlesIn([at(1, 0, { clock: null, firstSeen: STEADY - 100_000 })], now(), START)).toBe(20_000);
    expect(settlesIn([at(1, 5 * MIN)], now(), START)).toBeNull();
    expect(settlesIn([], now(), START)).toBeNull();
  });
});

describe('the marks of a clear, a drop and an undone drop', () => {
  it('name the first place a copy after it takes, and read it back', () => {
    expect(markerName(KEY, 'clear', NOW)).toBe(`${KEY}.cleared-${NOW}.json`);
    expect(markerName(KEY, 'drop', NOW)).toBe(`${KEY}.dropped-${NOW}.json`);
    expect(markerName(KEY, 'undone', NOW)).toBe(`${KEY}.undone-${NOW}.json`);
    for (const how of ['clear', 'drop', 'undone'] as const) expect(markerOf(KEY, markerName(KEY, how, NOW))).toEqual({ name: markerName(KEY, how, NOW), how, after: NOW });
  });

  it('a drop’s, and an undone drop’s, name whose account it took off, so that one a power cut undid can be made again', () => {
    expect(markerName(KEY, 'drop', NOW, 'acct_mqx81k2zp0a1b2c3d4e5')).toBe(`${KEY}.dropped-${NOW}-acct_mqx81k2zp0a1b2c3d4e5.json`);
    expect(markerOf(KEY, `${KEY}.dropped-${NOW}-acct_1.json`)).toEqual({ name: `${KEY}.dropped-${NOW}-acct_1.json`, how: 'drop', after: NOW, id: 'acct_1' });
    expect(markerOf(KEY, `${KEY}.undone-${NOW}-acct_1.json`)).toEqual({ name: `${KEY}.undone-${NOW}-acct_1.json`, how: 'undone', after: NOW, id: 'acct_1' });
    // An id a file name could not hold safely is left out; a clear takes everyone's, and names nobody.
    expect(markerName(KEY, 'drop', NOW, 'acct/../1')).toBe(`${KEY}.dropped-${NOW}.json`);
    expect(markerName(KEY, 'clear', NOW, 'acct_1')).toBe(`${KEY}.cleared-${NOW}.json`);
    expect(markerOf(KEY, `${KEY}.dropped-${NOW}-.json`)).toBeNull();
  });

  it('are no other file: not a copy, not the file, not another key’s', () => {
    for (const name of [copyName(KEY, NOW, 5, 'boot'), placeName(KEY, NOW), `${KEY}.json`, `us-mine-crew.cleared-${NOW}.json`, `${KEY}.cleared-.json`]) expect(markerOf(KEY, name)).toBeNull();
  });

  it('a read takes no copy from before a clear, and does take one from before a drop or an undone drop', () => {
    const marks = [markerOf(KEY, markerName(KEY, 'clear', 5))!, markerOf(KEY, markerName(KEY, 'drop', 9))!, markerOf(KEY, markerName(KEY, 'undone', 12))!];
    expect(readableAfter(marks)).toBe(5);
    expect(readableAfter([])).toBe(0);
  });

  it('a new copy takes a place past a clear or a drop, and not for an undone drop, which says only that the store is to make it again', () => {
    const marks = [markerOf(KEY, markerName(KEY, 'clear', 5))!, markerOf(KEY, markerName(KEY, 'drop', 9))!, markerOf(KEY, markerName(KEY, 'undone', 12))!];
    expect(forgottenBefore(marks)).toBe(9);
  });
});
