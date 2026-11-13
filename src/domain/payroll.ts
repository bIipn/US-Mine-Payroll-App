import { addDays, startOfDay, ymd } from '../util/format';
import { CA_RULES, MEAL_FLAGS, shiftFlags, shiftTotals, type TimeRules } from './time';
import type { Employee, Shift, ShiftFlag } from './types';

/**
 * Payroll hours.
 *
 * Every figure here is in hundredths of an hour (1225 = 12.25 hours), worked
 * out the way the crew fills in a paper timesheet: time on site as a decimal,
 * minus lunch as a decimal. Keeping whole hundredths means the daily lines, the
 * weekly totals and the Excel export always add up to the cent of an hour.
 */

export interface DayLine {
  /** Local calendar day, start of day in ms. */
  dayStart: number;
  shifts: Shift[];
  firstIn?: number;
  lastOut?: number;
  /** A shift on this day is still on the clock. */
  open: boolean;
  /** Time on site before lunch comes off. */
  gross: number;
  lunch: number;
  paid: number;
  reg: number;
  ot: number;
  dt: number;
  flags: ShiftFlag[];
}

export interface PayrollTotals {
  gross: number;
  lunch: number;
  paid: number;
  reg: number;
  ot: number;
  dt: number;
  daysWorked: number;
  /** Lunch flags that may carry a meal premium. For review, never auto-paid. */
  mealFlags: number;
  /** Shifts that cannot be paid until a supervisor fixes them. */
  needsFix: number;
  flagCounts: Partial<Record<ShiftFlag, number>>;
}

export interface WeekPayroll extends PayrollTotals {
  weekStart: number;
  days: DayLine[];
}

export interface EmployeePayroll extends PayrollTotals {
  employee: Employee;
  weeks: WeekPayroll[];
}

const emptyTotals = (): PayrollTotals => ({
  gross: 0,
  lunch: 0,
  paid: 0,
  reg: 0,
  ot: 0,
  dt: 0,
  daysWorked: 0,
  mealFlags: 0,
  needsFix: 0,
  flagCounts: {},
});

/**
 * One employee's workweek.
 *
 * Hours land on the day the shift started. Overtime follows California rules:
 *   - over 8 hours in a day is time-and-a-half, over 12 is double time
 *   - on the seventh straight day worked in the workweek, the first 8 hours are
 *     time-and-a-half and anything past 8 is double time
 *   - straight-time hours past 40 in the week become time-and-a-half
 * A shift that was never clocked out is left out of the totals and counted in
 * `needsFix` until a supervisor sets its end time.
 */
export function computeWeek(
  shifts: Shift[],
  weekStart: number,
  now: number,
  rules: TimeRules = CA_RULES,
): WeekPayroll {
  const start = startOfDay(weekStart);
  const dayIndex = new Map<string, number>();
  const days: DayLine[] = [];
  for (let i = 0; i < 7; i++) {
    const dayStart = addDays(start, i);
    dayIndex.set(ymd(dayStart), i);
    days.push({ dayStart, shifts: [], open: false, gross: 0, lunch: 0, paid: 0, reg: 0, ot: 0, dt: 0, flags: [] });
  }

  const totals = emptyTotals();

  for (const shift of [...shifts].sort((a, b) => a.clockIn.at - b.clockIn.at)) {
    const index = dayIndex.get(ymd(shift.clockIn.at));
    if (index == null) continue;
    const day = days[index];
    const flags = shiftFlags(shift, now, rules);
    day.shifts.push(shift);
    for (const flag of flags) {
      if (!day.flags.includes(flag)) day.flags.push(flag);
      totals.flagCounts[flag] = (totals.flagCounts[flag] ?? 0) + 1;
      if (MEAL_FLAGS.includes(flag)) totals.mealFlags += 1;
    }
    day.firstIn = day.firstIn == null ? shift.clockIn.at : Math.min(day.firstIn, shift.clockIn.at);
    if (flags.includes('missing_out')) {
      totals.needsFix += 1;
      continue;
    }
    const t = shiftTotals(shift, now);
    day.gross += t.gross;
    day.lunch += t.lunch;
    day.paid += t.paid;
    if (shift.clockOut) {
      day.lastOut = day.lastOut == null ? shift.clockOut.at : Math.max(day.lastOut, shift.clockOut.at);
    } else {
      day.open = true;
    }
  }

  const workedAllSeven = days.every((d) => d.paid > 0);
  let straightSoFar = 0;

  days.forEach((day, i) => {
    const worked = day.paid;
    let reg: number;
    let ot: number;
    let dt: number;
    if (i === 6 && workedAllSeven) {
      reg = 0;
      ot = Math.min(worked, rules.dailyOvertimeAfter);
      dt = Math.max(0, worked - rules.dailyOvertimeAfter);
    } else {
      reg = Math.min(worked, rules.dailyOvertimeAfter);
      ot = Math.min(Math.max(0, worked - rules.dailyOvertimeAfter), rules.dailyDoubleAfter - rules.dailyOvertimeAfter);
      dt = Math.max(0, worked - rules.dailyDoubleAfter);
    }
    const overWeekly = Math.max(0, straightSoFar + reg - rules.weeklyOvertimeAfter);
    reg -= overWeekly;
    ot += overWeekly;
    straightSoFar += reg;

    day.reg = reg;
    day.ot = ot;
    day.dt = dt;
    totals.reg += reg;
    totals.ot += ot;
    totals.dt += dt;
    totals.gross += day.gross;
    totals.lunch += day.lunch;
    totals.paid += worked;
    if (day.shifts.length > 0) totals.daysWorked += 1;
  });

  return { weekStart: start, days, ...totals };
}

function addTotals(into: PayrollTotals, from: PayrollTotals) {
  into.gross += from.gross;
  into.lunch += from.lunch;
  into.paid += from.paid;
  into.reg += from.reg;
  into.ot += from.ot;
  into.dt += from.dt;
  into.daysWorked += from.daysWorked;
  into.mealFlags += from.mealFlags;
  into.needsFix += from.needsFix;
  for (const key of Object.keys(from.flagCounts) as ShiftFlag[]) {
    into.flagCounts[key] = (into.flagCounts[key] ?? 0) + (from.flagCounts[key] ?? 0);
  }
}

/** A pay period of one or more whole workweeks, for every employee given. */
export function computePayroll(
  employees: Employee[],
  shifts: Shift[],
  periodStart: number,
  weeks: number,
  now: number,
  rules: TimeRules = CA_RULES,
): EmployeePayroll[] {
  const byEmployee = new Map<string, Shift[]>();
  for (const shift of shifts) {
    const list = byEmployee.get(shift.employeeId);
    if (list) list.push(shift);
    else byEmployee.set(shift.employeeId, [shift]);
  }
  return employees.map((employee) => {
    const own = byEmployee.get(employee.id) ?? [];
    const totals = emptyTotals();
    const weekRows: WeekPayroll[] = [];
    for (let w = 0; w < weeks; w++) {
      const week = computeWeek(own, addDays(periodStart, w * 7), now, rules);
      weekRows.push(week);
      addTotals(totals, week);
    }
    return { employee, weeks: weekRows, ...totals };
  });
}

export function sumPayroll(rows: PayrollTotals[]): PayrollTotals {
  const totals = emptyTotals();
  for (const row of rows) addTotals(totals, row);
  return totals;
}
