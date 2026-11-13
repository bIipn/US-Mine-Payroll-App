import { fmtHM, fmtHrs, HOUR, MIN, minuteDecimal, toHundredths } from '../../util/format';
import {
  backFromLunchAt,
  CA_RULES,
  lunchEndAt,
  lunchOverReminder,
  lunchReminders,
  mealStatus,
  reminderPlan,
  shiftFlags,
  shiftTotals,
  startedLunch,
} from '../time';
import type { GeoStamp, Shift } from '../types';

const at = (h: number, m = 0, day = 9) => new Date(2026, 10, day, h, m, 0).getTime();
const geo = (inside: boolean, extra: Partial<GeoStamp> = {}): GeoStamp => ({
  lat: 38.334, lng: -120.945, accuracyM: 8, distanceM: inside ? 60 : 2300, inside, source: 'gps', ...extra,
});

const shift = (partial: Partial<Shift> = {}): Shift => ({
  id: 's1', employeeId: 'e1', clockIn: { at: at(6) }, lunches: [], breaks: [], ...partial,
});

describe('shiftTotals', () => {
  it('pays clock-in to clock-out minus the unpaid lunch', () => {
    const s = shift({
      clockOut: { at: at(14, 30) },
      lunches: [{ start: { at: at(10, 30) }, end: { at: at(11, 0) } }],
    });
    expect(shiftTotals(s, at(20))).toMatchObject({ grossMin: 510, lunchMin: 30, paidMin: 480, open: false });
  });

  it('deducts the recorded length when a lunch was corrected to run past 30 minutes', () => {
    const s = shift({
      clockOut: { at: at(15) },
      lunches: [{ start: { at: at(10) }, end: { at: at(10, 47) } }],
    });
    expect(shiftTotals(s, at(20)).paidMin).toBe(9 * 60 - 47);
  });

  it('never deducts paid rest breaks', () => {
    const s = shift({ clockOut: { at: at(10) }, breaks: [{ start: at(8), end: at(8, 10) }] });
    expect(shiftTotals(s, at(20)).paidMin).toBe(240);
  });

  it('counts to the minute and ignores seconds', () => {
    const s = shift({ clockIn: { at: at(6) + 59_000 }, clockOut: { at: at(14) + 1_000 } });
    expect(shiftTotals(s, at(20)).paidMin).toBe(480);
  });

  it('runs an open shift up to now and reports lunch and break state', () => {
    const working = shift();
    expect(shiftTotals(working, at(9, 15))).toMatchObject({ paidMin: 195, open: true, onLunch: false });
    const eating = shift({ lunches: [startedLunch({ at: at(10) })] });
    expect(shiftTotals(eating, at(10, 20))).toMatchObject({ grossMin: 260, lunchMin: 20, paidMin: 240, onLunch: true });
    const resting = shift({ breaks: [{ start: at(8) }] });
    expect(shiftTotals(resting, at(8, 5)).onBreak).toBe(true);
  });
});

describe('automatic lunch', () => {
  it('sets a lunch to end by itself 30 minutes after it starts', () => {
    expect(startedLunch({ at: at(11), geo: geo(true) })).toEqual({
      start: { at: at(11), geo: geo(true) },
      end: { at: at(11, 30), auto: true },
    });
  });

  it('puts the person back on the clock when the 30 minutes are up', () => {
    const s = shift({ lunches: [startedLunch({ at: at(10) })] });
    expect(shiftTotals(s, at(10, 29))).toMatchObject({ onLunch: true, lunchMin: 29, paidMin: 240 });
    expect(shiftTotals(s, at(10, 30))).toMatchObject({ onLunch: false, lunchMin: 30, paidMin: 240 });
    expect(shiftTotals(s, at(12))).toMatchObject({ onLunch: false, lunchMin: 30, paidMin: 330 });
    expect(mealStatus(s, at(10, 29)).state).toBe('at_lunch');
    expect(mealStatus(s, at(10, 30)).state).toBe('taken');
  });

  it('never leaves anyone stuck at lunch when a record has no end time', () => {
    const s = shift({ lunches: [{ start: { at: at(10) } }] });
    expect(lunchEndAt(s.lunches[0])).toBe(at(10, 30));
    expect(shiftTotals(s, at(10, 20)).onLunch).toBe(true);
    expect(shiftTotals(s, at(11))).toMatchObject({ onLunch: false, lunchMin: 30 });
    expect(mealStatus(s, at(11)).state).toBe('taken');
  });

  it('gives the time back on the clock only once that time has come', () => {
    const lunch = startedLunch({ at: at(11) });
    expect(backFromLunchAt(lunch, at(11, 29))).toBeUndefined();
    expect(backFromLunchAt(lunch, at(11, 30))).toBe(at(11, 30));
    expect(backFromLunchAt(undefined, at(12))).toBeUndefined();
  });

  it('comes off the day as exactly 0.50 and is never flagged as short', () => {
    // Started 37 seconds past the minute: the end carries the same seconds, so it is still 30 minutes.
    const s = shift({ clockOut: { at: at(14, 30) }, lunches: [startedLunch({ at: at(10, 30) + 37_000 })] });
    expect(shiftTotals(s, at(20)).lunch).toBe(50);
    expect(shiftFlags(s, at(20))).toEqual([]);
  });
});

describe('timesheet decimals', () => {
  it('converts minutes the way the timesheet chart does', () => {
    const chart: [number, string][] = [
      [5, '.08'], [10, '.17'], [15, '.25'], [20, '.33'], [25, '.42'], [30, '.50'],
      [35, '.58'], [40, '.67'], [45, '.75'], [50, '.83'], [55, '.92'], [60, '1.00'],
    ];
    for (const [minutes, text] of chart) expect(minuteDecimal(minutes)).toBe(text);
    expect(fmtHrs(toHundredths(12 * 60 + 45))).toBe('12.75');
  });

  it('works the crew example: 6:15 AM to 7:00 PM, 30-minute lunch, 12.25 paid', () => {
    const s = shift({
      clockIn: { at: at(6, 15) },
      clockOut: { at: at(19, 0) },
      lunches: [{ start: { at: at(11) }, end: { at: at(11, 30) } }],
    });
    const t = shiftTotals(s, at(22));
    expect(fmtHM(t.grossMin)).toBe('12h 45m');
    expect([fmtHrs(t.gross), fmtHrs(t.lunch), fmtHrs(t.paid)]).toEqual(['12.75', '0.50', '12.25']);
  });

  it('takes a longer lunch off as its own decimal', () => {
    const s = shift({ clockOut: { at: at(14, 20) }, lunches: [{ start: { at: at(10) }, end: { at: at(10, 35) } }] });
    const t = shiftTotals(s, at(22));
    expect([fmtHrs(t.gross), fmtHrs(t.lunch), fmtHrs(t.paid)]).toEqual(['8.33', '0.58', '7.75']);
  });
});

describe('mealStatus', () => {
  const s = shift();
  it('sets the deadline at the end of the fifth hour', () => {
    expect(mealStatus(s, at(7)).deadlineAt).toBe(at(11));
  });
  it.each([
    [at(9, 59), 'not_due'],
    [at(10, 0), 'soon'],
    [at(10, 29), 'soon'],
    [at(10, 30), 'urgent'],
    [at(10, 59), 'urgent'],
    [at(11, 0), 'overdue'],
    [at(12, 0), 'overdue'],
  ])('at %d is %s', (now, state) => {
    expect(mealStatus(s, now as number).state).toBe(state);
  });
  it('reports time left to start lunch', () => {
    expect(mealStatus(s, at(10, 15)).remainingMs).toBe(45 * MIN);
    expect(mealStatus(s, at(11, 30)).remainingMs).toBe(0);
  });
  it('counts down to the automatic end while at lunch', () => {
    const eating = shift({ lunches: [startedLunch({ at: at(10) })] });
    expect(mealStatus(eating, at(10, 12))).toMatchObject({
      state: 'at_lunch',
      lunchElapsedMs: 12 * MIN,
      lunchRemainingMs: 18 * MIN,
      lunchEndsAt: at(10, 30),
    });
  });
  it('never shows more time left than the lunch is long', () => {
    // The screen's clock ticks once a second, so it can be a moment behind the tap that started lunch.
    const eating = shift({ lunches: [startedLunch({ at: at(10) })] });
    expect(mealStatus(eating, at(10) - 600)).toMatchObject({
      state: 'at_lunch',
      lunchElapsedMs: 0,
      lunchRemainingMs: 30 * MIN,
    });
  });
  it('is taken once a lunch is finished', () => {
    const done = shift({ lunches: [{ start: { at: at(10) }, end: { at: at(10, 30) } }] });
    expect(mealStatus(done, at(12)).state).toBe('taken');
  });
});

describe('shiftFlags', () => {
  const closed = (partial: Partial<Shift>) => shiftFlags(shift({ clockOut: { at: at(14, 30) }, ...partial }), at(20));

  it('is clean for a normal day', () => {
    expect(closed({ lunches: [{ start: { at: at(10, 30) }, end: { at: at(11) } }] })).toEqual([]);
  });
  it('flags a lunch that starts at or after the five-hour mark', () => {
    expect(closed({ lunches: [{ start: { at: at(10, 59) }, end: { at: at(11, 29) } }] })).toEqual([]);
    expect(closed({ lunches: [{ start: { at: at(11, 0) }, end: { at: at(11, 30) } }] })).toEqual(['late_lunch']);
  });
  it('flags a full shift with no lunch', () => {
    expect(closed({})).toEqual(['no_lunch']);
    expect(closed({ mealNote: 'worked_through' })).toEqual(['no_lunch']);
  });
  it('does not flag short shifts under five hours', () => {
    expect(shiftFlags(shift({ clockOut: { at: at(10, 45) } }), at(20))).toEqual([]);
  });
  it('accepts a waiver only on shifts of six hours or less', () => {
    expect(shiftFlags(shift({ clockOut: { at: at(11, 45) }, mealNote: 'waived_short_shift' }), at(20))).toEqual([]);
    expect(shiftFlags(shift({ clockOut: { at: at(11, 45) } }), at(20))).toEqual(['no_lunch']);
    expect(shiftFlags(shift({ clockOut: { at: at(13) }, mealNote: 'waived_short_shift' }), at(20))).toEqual(['no_lunch']);
  });
  it('flags an open shift once the fifth hour passes with no lunch', () => {
    expect(shiftFlags(shift(), at(10, 59))).toEqual([]);
    expect(shiftFlags(shift(), at(11, 0))).toEqual(['no_lunch']);
  });
  it('flags short lunches, long days, off-site clock-outs, edits and spoofed GPS', () => {
    expect(closed({ lunches: [{ start: { at: at(10) }, end: { at: at(10, 20) } }] })).toEqual(['short_lunch']);
    const long = shift({ clockOut: { at: at(17) }, lunches: [{ start: { at: at(10) }, end: { at: at(10, 30) } }] });
    expect(shiftFlags(long, at(20))).toEqual(['second_meal']);
    const lunch = [{ start: { at: at(10) }, end: { at: at(10, 30) } }];
    expect(closed({ lunches: lunch, clockOut: { at: at(14, 30), geo: geo(false) } })).toEqual(['offsite_out']);
    expect(closed({ lunches: lunch, clockOut: { at: at(14, 30), geo: geo(true) } })).toEqual([]);
    expect(
      closed({ lunches: lunch, edits: [{ at: at(15), byEmployeeId: 'sup', field: 'clockOut', reason: 'forgot' }] }),
    ).toEqual(['edited']);
    expect(closed({ lunches: lunch, clockIn: { at: at(6), geo: geo(true, { mocked: true }) } })).toEqual(['mock_gps']);
  });
  it('treats a shift open for more than 16 hours as a missing clock-out', () => {
    expect(shiftFlags(shift(), at(6) + 16 * HOUR + MIN)).toEqual(['missing_out']);
  });
});

describe('lunchReminders', () => {
  it('fires 60, 30 and 15 minutes before the fifth hour ends, then at the deadline', () => {
    const reminders = lunchReminders(at(6));
    expect(reminders.map((r) => r.at)).toEqual([at(10), at(10, 30), at(10, 45), at(11)]);
    expect(reminders.map((r) => r.id)).toEqual(['lunch-60', 'lunch-30', 'lunch-15', 'lunch-0']);
    expect(CA_RULES.mealMinMs).toBe(30 * MIN);
  });

  it('asks the person to start lunch, not to clock out for it', () => {
    expect(lunchReminders(at(6)).map((r) => r.body).join(' ')).not.toMatch(/clock out/i);
  });
});

describe('lunchOverReminder', () => {
  it('tells the person they are back on the clock, at the moment lunch ends', () => {
    expect(lunchOverReminder(at(11, 30))).toEqual({
      id: 'lunch-end',
      at: at(11, 30),
      title: 'Lunch is over',
      body: 'You are back on the clock as of 11:30 AM.',
    });
  });
});

describe('reminderPlan', () => {
  const DEADLINE_IDS = ['lunch-60', 'lunch-30', 'lunch-15', 'lunch-0'];
  const ids = (plan: { schedule: { id: string }[] }) => plan.schedule.map((r) => r.id);

  it('schedules nothing and clears everything when off the clock', () => {
    expect(reminderPlan(undefined, true, at(9))).toEqual({ schedule: [], cancel: [...DEADLINE_IDS, 'lunch-end'] });
    const done = shift({ clockOut: { at: at(14) }, lunches: [startedLunch({ at: at(10) })] });
    expect(reminderPlan(done, true, at(15))).toEqual({ schedule: [], cancel: [...DEADLINE_IDS, 'lunch-end'] });
  });

  it('reminds about the lunch deadline until lunch starts, when reminders are on', () => {
    expect(ids(reminderPlan(shift(), true, at(7)))).toEqual(DEADLINE_IDS);
    expect(reminderPlan(shift(), false, at(7))).toEqual({ schedule: [], cancel: [...DEADLINE_IDS, 'lunch-end'] });
  });

  it('always sends the lunch-is-over notice, even with deadline reminders turned off', () => {
    const eating = shift({ lunches: [startedLunch({ at: at(10) })] });
    for (const remindersOn of [true, false]) {
      expect(reminderPlan(eating, remindersOn, at(10, 5))).toEqual({
        schedule: [lunchOverReminder(at(10, 30))],
        cancel: DEADLINE_IDS,
      });
    }
  });

  it('has nothing left to send once lunch is over', () => {
    const back = shift({ lunches: [startedLunch({ at: at(10) })] });
    expect(reminderPlan(back, true, at(10, 30))).toEqual({ schedule: [], cancel: [...DEADLINE_IDS, 'lunch-end'] });
  });
});
