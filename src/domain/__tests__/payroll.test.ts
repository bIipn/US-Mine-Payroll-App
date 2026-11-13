import { computePayroll, computeWeek, sumPayroll } from '../payroll';
import type { Employee, Shift } from '../types';

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

describe('computePayroll', () => {
  const employees: Employee[] = [
    { id: 'e1', firstName: 'Ana', lastName: 'Diaz', role: 'employee', active: true },
    { id: 'e2', firstName: 'Bo', lastName: 'Lee', role: 'employee', active: true },
  ];

  it('totals a two-week period per employee with overtime worked out week by week', () => {
    const shifts = [
      ...[9, 10, 11, 12, 13, 14].map((d) => worked(d, 8, 'e1')), // week 1: 40 + 8 OT
      ...[16, 17, 18].map((d) => worked(d, 8, 'e1')), //             week 2: 24
      worked(9, 6, 'e2'),
    ];
    const rows = computePayroll(employees, shifts, WEEK, 2, NOW);
    expect(rows.map((r) => [hours(r.reg), hours(r.ot), hours(r.paid)])).toEqual([
      [64, 8, 72],
      [6, 0, 6],
    ]);
    expect(rows[0].weeks).toHaveLength(2);
    const all = sumPayroll(rows);
    expect(hours(all.paid)).toBe(78);
    expect(all.daysWorked).toBe(10);
  });
});
