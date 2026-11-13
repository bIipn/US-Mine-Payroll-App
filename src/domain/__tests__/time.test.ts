import { fmtHM, fmtHrs, HOUR, MIN, minuteDecimal, toHundredths } from '../../util/format';
import { CA_RULES, canEndLunch, lunchReminders, mealStatus, shiftFlags, shiftTotals } from '../time';
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

  it('deducts the actual lunch length when it runs past 30 minutes', () => {
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
    const eating = shift({ lunches: [{ start: { at: at(10) } }] });
    expect(shiftTotals(eating, at(10, 20))).toMatchObject({ grossMin: 260, lunchMin: 20, paidMin: 240, onLunch: true });
    const resting = shift({ breaks: [{ start: at(8) }] });
    expect(shiftTotals(resting, at(8, 5)).onBreak).toBe(true);
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
  it('tracks the 30-minute minimum while at lunch', () => {
    const eating = shift({ lunches: [{ start: { at: at(10) } }] });
    const status = mealStatus(eating, at(10, 12));
    expect(status).toMatchObject({ state: 'at_lunch', lunchElapsedMs: 12 * MIN, lunchRemainingMs: 18 * MIN });
    expect(canEndLunch(eating, at(10, 29))).toBe(false);
    expect(canEndLunch(eating, at(10, 30))).toBe(true);
  });
  it('is taken once a lunch is finished', () => {
    const done = shift({ lunches: [{ start: { at: at(10) }, end: { at: at(10, 30) } }] });
    expect(mealStatus(done, at(12)).state).toBe('taken');
    expect(canEndLunch(done, at(12))).toBe(false);
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
});
