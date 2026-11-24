import { ymd } from '../../util/format';
import { computePayroll, computeRange, computeWeek, estimateGross, sumPayroll } from '../payroll';
import type { Employee, LeaveEntry, LeaveType, Shift } from '../types';

// Sunday Nov 8 2026 starts the workweek used in these tests.
const WEEK = new Date(2026, 10, 8).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const NOW = at(30, 12);

let n = 0;
/** A closed shift on `day` paying exactly `paidHours`, with a 30-minute lunch when long enough. */
function worked(day: number, paidHours: number, employeeId = 'e1'): Shift {
  const lunch = paidHours > 5;
  const outAt = at(day, 6) + paidHours * 3_600_000 + (lunch ? 30 * 60_000 : 0);
  return {
    id: `s${n++}`,
    employeeId,
    clockIn: { at: at(day, 6) },
    clockOut: { at: outAt },
    lunches: lunch ? [{ start: { at: at(day, 10) }, end: { at: at(day, 10, 30) } }] : [],
    breaks: [],
  };
}
/** Payroll figures are hundredths of an hour. */
const hours = (hundredths: number) => hundredths / 100;

describe('computeWeek', () => {
  it('pays a plain 40-hour week as all straight time', () => {
    const week = computeWeek([9, 10, 11, 12, 13].map((d) => worked(d, 8)), WEEK, NOW);
    expect([hours(week.reg), hours(week.ot), hours(week.dt)]).toEqual([40, 0, 0]);
    expect(week.daysWorked).toBe(5);
    expect(week.lunch).toBe(250);
    expect(week.mealFlags).toBe(0);
  });

  it('pays daily overtime past 8 hours and double time past 12', () => {
    const week = computeWeek([worked(9, 10), worked(10, 13.5)], WEEK, NOW);
    const [mon, tue] = [week.days[1], week.days[2]];
    expect([hours(mon.reg), hours(mon.ot), hours(mon.dt)]).toEqual([8, 2, 0]);
    expect([hours(tue.reg), hours(tue.ot), hours(tue.dt)]).toEqual([8, 4, 1.5]);
    expect(hours(week.paid)).toBe(23.5);
  });

  it('turns straight time past 40 hours in the week into overtime', () => {
    const week = computeWeek([9, 10, 11, 12, 13, 14].map((d) => worked(d, 8)), WEEK, NOW);
    expect([hours(week.reg), hours(week.ot), hours(week.dt)]).toEqual([40, 8, 0]);
    expect(hours(week.days[6].ot)).toBe(8);
  });

  it('does not count daily overtime twice toward the weekly 40', () => {
    // Five 10-hour days: 40 straight + 10 daily overtime, nothing extra from the weekly rule.
    const week = computeWeek([9, 10, 11, 12, 13].map((d) => worked(d, 10)), WEEK, NOW);
    expect([hours(week.reg), hours(week.ot), hours(week.dt)]).toEqual([40, 10, 0]);
  });

  it('applies the seventh-day rule only when all seven days were worked', () => {
    const seven = computeWeek([8, 9, 10, 11, 12, 13, 14].map((d) => worked(d, d === 14 ? 10 : 4)), WEEK, NOW);
    expect([hours(seven.days[6].reg), hours(seven.days[6].ot), hours(seven.days[6].dt)]).toEqual([0, 8, 2]);
    expect(hours(seven.reg)).toBe(24);

    const six = computeWeek([9, 10, 11, 12, 13, 14].map((d) => worked(d, d === 14 ? 10 : 4)), WEEK, NOW);
    expect([hours(six.days[6].reg), hours(six.days[6].ot), hours(six.days[6].dt)]).toEqual([8, 2, 0]);
  });

  it('ignores shifts from other weeks', () => {
    const week = computeWeek([worked(7, 8), worked(9, 8), worked(15, 8)], WEEK, NOW);
    expect(hours(week.paid)).toBe(8);
  });

  it('holds back a shift with no clock-out until it is fixed', () => {
    const open: Shift = { id: 'open', employeeId: 'e1', clockIn: { at: at(10, 6) }, lunches: [], breaks: [] };
    const week = computeWeek([worked(9, 8), open], WEEK, NOW);
    expect(hours(week.paid)).toBe(8);
    expect(week.needsFix).toBe(1);
    expect(week.days[2].flags).toEqual(['missing_out']);
  });

  it('counts a shift still on the clock up to now', () => {
    const open: Shift = { id: 'open', employeeId: 'e1', clockIn: { at: at(10, 6) }, lunches: [], breaks: [] };
    const week = computeWeek([open], WEEK, at(10, 9, 30));
    expect(hours(week.paid)).toBe(3.5);
    expect(week.days[2].open).toBe(true);
    expect(week.needsFix).toBe(0);
  });

  it('counts meal flags for review', () => {
    const noLunch: Shift = {
      id: 'nl', employeeId: 'e1', clockIn: { at: at(9, 6) }, clockOut: { at: at(9, 14) }, lunches: [], breaks: [],
    };
    const week = computeWeek([noLunch], WEEK, NOW);
    expect(week.mealFlags).toBe(1);
    expect(week.flagCounts.no_lunch).toBe(1);
    expect(hours(week.paid)).toBe(8);
  });
});

describe('timesheet decimals', () => {
  it('matches the crew timesheet example: 6:15 AM to 7:00 PM with a 30-minute lunch is 12.25', () => {
    const shift: Shift = {
      id: 'ex', employeeId: 'e1',
      clockIn: { at: at(9, 6, 15) }, clockOut: { at: at(9, 19, 0) },
      lunches: [{ start: { at: at(9, 11) }, end: { at: at(9, 11, 30) } }], breaks: [],
    };
    const day = computeWeek([shift], WEEK, NOW).days[1];
    expect([day.gross, day.lunch, day.paid]).toEqual([1275, 50, 1225]);
    expect([day.reg, day.ot, day.dt]).toEqual([800, 400, 25]);
  });

  it('adds the daily decimals so the week matches a hand-added timesheet', () => {
    // 6:00 to 2:50 with a 30-minute lunch is 8.83 - 0.50 = 8.33 a day.
    const day = (d: number): Shift => ({
      id: `d${d}`, employeeId: 'e1',
      clockIn: { at: at(d, 6) }, clockOut: { at: at(d, 14, 50) },
      lunches: [{ start: { at: at(d, 10) }, end: { at: at(d, 10, 30) } }], breaks: [],
    });
    const week = computeWeek([9, 10, 11, 12, 13].map(day), WEEK, NOW);
    expect(week.days[1].paid).toBe(833);
    expect(week.paid).toBe(5 * 833);
    expect(week.reg + week.ot + week.dt).toBe(week.paid);
    expect([week.reg, week.ot]).toEqual([4000, 165]);
  });
});

/** Pay periods used below: Nov 1-15 and Nov 16-30, 2026. */
const NOV_1 = at(1, 0);
const NOV_16 = at(16, 0);
const DEC_1 = new Date(2026, 11, 1).getTime();
const NO_LEAVE: LeaveEntry[] = [];
const entry = (day: number, type: LeaveType, hours: number, employeeId = 'e1'): LeaveEntry => ({
  id: `lv${day}${type}`, employeeId, day: at(day, 0), type, hours, enteredBy: 'sup', at: 0,
});

describe('computeRange', () => {
  it('lists every day of the range', () => {
    const range = computeRange([], NO_LEAVE, NOV_1, NOV_16, NOW);
    expect(range.days).toHaveLength(15);
    expect([ymd(range.days[0].dayStart), ymd(range.days[14].dayStart)]).toEqual(['2026-11-01', '2026-11-15']);
  });

  it('counts weekly overtime from the whole workweek when a pay period starts mid-week', () => {
    // Workweek Sun Nov 15 to Sat Nov 21. Eight hours a day Sunday through Friday is 48,
    // so Friday is overtime, even though Sunday the 15th falls in the earlier pay period.
    const shifts = [15, 16, 17, 18, 19, 20].map((d) => worked(d, 8));
    const first = computeRange(shifts, NO_LEAVE, NOV_1, NOV_16, NOW);
    const second = computeRange(shifts, NO_LEAVE, NOV_16, DEC_1, NOW);
    expect([first.reg, first.ot, first.paid]).toEqual([800, 0, 800]);
    expect([second.reg, second.ot, second.paid]).toEqual([3200, 800, 4000]);
  });

  it('keeps paid leave out of overtime and adds it to the total', () => {
    // Monday to Thursday worked, Friday PTO, Saturday worked: 40 hours worked, so no overtime.
    const shifts = [2, 3, 4, 5, 7].map((d) => worked(d, 8));
    const range = computeRange(shifts, [entry(6, 'pto', 800)], NOV_1, NOV_16, NOW);
    expect([range.reg, range.ot, range.dt]).toEqual([4000, 0, 0]);
    expect([range.holiday, range.pto, range.sick]).toEqual([0, 800, 0]);
    expect(range.total).toBe(4800);
    expect(range.leave).toHaveLength(1);
  });

  it('leaves out leave, days and flags that fall outside the range', () => {
    const noLunch = (d: number): Shift => ({
      id: `nl${d}`, employeeId: 'e1', clockIn: { at: at(d, 6) }, clockOut: { at: at(d, 14) }, lunches: [], breaks: [],
    });
    const range = computeRange(
      [noLunch(13), noLunch(17)],
      [entry(13, 'sick', 400), entry(17, 'sick', 800), entry(11, 'holiday', 800)],
      NOV_1, NOV_16, NOW,
    );
    expect([range.daysWorked, range.mealFlags, range.flagCounts.no_lunch]).toEqual([1, 1, 1]);
    expect([range.holiday, range.sick]).toEqual([800, 400]);
    expect(range.total).toBe(800 + 800 + 400);
  });

  it('counts a shift with no clock-out as needing a fix, not as hours', () => {
    const open: Shift = { id: 'open', employeeId: 'e1', clockIn: { at: at(10, 6) }, lunches: [], breaks: [] };
    const range = computeRange([worked(9, 8), open], NO_LEAVE, NOV_1, NOV_16, NOW);
    expect([range.paid, range.needsFix]).toEqual([800, 1]);
  });
});

describe('a clock-in with no location', () => {
  it('pays the same hours and overtime as the same shift clocked in with one: only the flag differs', () => {
    // Five 10-hour days: daily overtime every day.
    const shifts = [9, 10, 11, 12, 13].map((d) => worked(d, 10));
    const marked = shifts.map((s, i): Shift => (i === 1 ? { ...s, clockIn: { at: s.clockIn.at, noLocation: 'off' } } : s));
    const plain = computeRange(shifts, NO_LEAVE, NOV_1, NOV_16, NOW);
    const flagged = computeRange(marked, NO_LEAVE, NOV_1, NOV_16, NOW);
    const figures = (r: typeof plain) => [r.gross, r.lunch, r.paid, r.reg, r.ot, r.dt, r.total, r.daysWorked, r.mealFlags, r.needsFix];
    expect(figures(flagged)).toEqual(figures(plain));
    expect([plain.reg, plain.ot]).toEqual([4000, 1000]);
    expect(plain.flagCounts.no_location).toBeUndefined();
    expect(flagged.flagCounts.no_location).toBe(1);
    // Day by day, the hours agree and the flag sits on the one day.
    expect(flagged.days.map((d) => [d.paid, d.reg, d.ot, d.dt])).toEqual(plain.days.map((d) => [d.paid, d.reg, d.ot, d.dt]));
    expect(flagged.days.filter((d) => d.flags.includes('no_location')).map((d) => ymd(d.dayStart))).toEqual(['2026-11-10']);
  });

  it('is still listed for review on a shift that is missing its clock-out, which counts no hours until it is fixed', () => {
    const open: Shift = { id: 'open', employeeId: 'e1', clockIn: { at: at(10, 6), noLocation: 'no_fix' }, lunches: [], breaks: [] };
    const range = computeRange([worked(9, 8), open], NO_LEAVE, NOV_1, NOV_16, NOW);
    expect(range.paid).toBe(800);
    expect(range.needsFix).toBe(1);
    expect(range.flagCounts).toEqual({ missing_out: 1, no_location: 1 });
    expect(range.days.find((d) => ymd(d.dayStart) === '2026-11-10')!.flags).toEqual(['missing_out', 'no_location']);
  });
});

describe('computePayroll', () => {
  const employees: Employee[] = [
    { id: 'e1', firstName: 'Ana', lastName: 'Diaz', role: 'employee', active: true },
    { id: 'e2', firstName: 'Bo', lastName: 'Lee', role: 'employee', active: true },
  ];

  it('totals a period for each employee, with overtime worked out week by week', () => {
    const shifts = [
      ...[9, 10, 11, 12, 13, 14].map((d) => worked(d, 8, 'e1')), // workweek of Nov 8: 40 + 8 overtime
      ...[16, 17, 18].map((d) => worked(d, 8, 'e1')), //             workweek of Nov 15: 24
      worked(9, 6, 'e2'),
    ];
    const leave = [entry(19, 'pto', 800, 'e1'), entry(11, 'holiday', 800, 'e2')];
    const rows = computePayroll(employees, shifts, leave, WEEK, at(22, 0), NOW);
    expect(rows.map((r) => [r.reg, r.ot, r.paid, r.pto, r.holiday, r.total])).toEqual([
      [6400, 800, 7200, 800, 0, 8000],
      [600, 0, 600, 0, 800, 1400],
    ]);
    const all = sumPayroll(rows);
    expect([all.paid, all.daysWorked, all.pto, all.holiday, all.total]).toEqual([7800, 10, 800, 800, 9400]);
  });
});

describe('estimateGross', () => {
  const hours = { reg: 0, ot: 0, dt: 0, holiday: 0, pto: 0, sick: 0 };

  it('pays overtime at time-and-a-half, double time at twice the rate, and leave at straight time', () => {
    const estimate = estimateGross({ ...hours, reg: 8000, ot: 1050, dt: 25, pto: 800 }, 3000);
    expect(estimate.lines.map((l) => [l.code, l.hours, l.rateCents, l.amountCents])).toEqual([
      ['ST', 8000, 3000, 240000],
      ['OT', 1050, 4500, 47250],
      ['DT', 25, 6000, 1500],
      ['PTO', 800, 3000, 24000],
    ]);
    expect(estimate.grossCents).toBe(312750);
  });

  it('rounds each line to the cent', () => {
    // 0.33 hours of overtime at $25.55 an hour is 0.33 x $38.325 = $12.64725
    expect(estimateGross({ ...hours, ot: 33 }, 2555).lines[0].amountCents).toBe(1265);
  });

  it('keeps a half-cent overtime rate exact, so the line multiplies out', () => {
    // $24.25 an hour is $36.375 at time-and-a-half: 10 hours come to $363.75, not 10 x $36.38.
    const [line] = estimateGross({ ...hours, ot: 1000 }, 2425).lines;
    expect(line.rateCents).toBe(3637.5);
    expect(line.amountCents).toBe(36375);
  });

  it('has no lines when there are no hours', () => {
    expect(estimateGross(hours, 3000)).toEqual({ lines: [], grossCents: 0 });
  });
});
