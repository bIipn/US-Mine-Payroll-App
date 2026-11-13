import { addDays, startOfDay, startOfWeek, ymd } from '../util/format';
import { CA_RULES, MEAL_FLAGS, shiftFlags, shiftTotals, type TimeRules } from './time';
import type { Employee, LeaveEntry, Shift, ShiftFlag } from './types';

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

export interface RangePayroll extends PayrollTotals {
  start: number;
  /** Start of the day after the last day. */
  end: number;
  days: DayLine[];
  /** Paid leave in the range, in hundredths of an hour. */
  holiday: number;
  pto: number;
  sick: number;
  /** Everything on the check: hours worked plus paid leave. */
  total: number;
  leave: LeaveEntry[];
}

export interface EmployeePayroll extends RangePayroll {
  employee: Employee;
}

export interface PayrollOptions {
  rules?: TimeRules;
  /** 0 = Sunday. */
  weekStartsOn?: number;
}

/**
 * One employee's hours for any run of days, such as a pay period.
 *
 * Overtime is always worked out on whole workweeks first, then the days that
 * fall inside the range are added up. A pay period that starts on a Wednesday
 * still counts Monday and Tuesday toward that week's 40 hours.
 *
 * Paid leave (holiday, PTO, sick) is added to the total but is never counted as
 * hours worked, so it cannot push a week into overtime.
 */
export function computeRange(
  shifts: Shift[],
  leave: LeaveEntry[],
  start: number,
  end: number,
  now: number,
  options: PayrollOptions = {},
): RangePayroll {
  const rules = options.rules ?? CA_RULES;
  const from = startOfDay(start);
  const to = startOfDay(end);

  const days: DayLine[] = [];
  for (let week = startOfWeek(from, options.weekStartsOn ?? 0); week < to; week = addDays(week, 7)) {
    for (const day of computeWeek(shifts, week, now, rules).days) {
      if (day.dayStart >= from && day.dayStart < to) days.push(day);
    }
  }

  const totals = emptyTotals();
  for (const day of days) {
    totals.gross += day.gross;
    totals.lunch += day.lunch;
    totals.paid += day.paid;
    totals.reg += day.reg;
    totals.ot += day.ot;
    totals.dt += day.dt;
    if (day.shifts.length > 0) totals.daysWorked += 1;
    for (const shift of day.shifts) {
      for (const flag of shiftFlags(shift, now, rules)) {
        totals.flagCounts[flag] = (totals.flagCounts[flag] ?? 0) + 1;
        if (MEAL_FLAGS.includes(flag)) totals.mealFlags += 1;
        if (flag === 'missing_out') totals.needsFix += 1;
      }
    }
  }

  const inRange = leave.filter((entry) => entry.day >= from && entry.day < to).sort((a, b) => a.day - b.day);
  const sum = (type: LeaveEntry['type']) =>
    inRange.reduce((hours, entry) => (entry.type === type ? hours + entry.hours : hours), 0);
  const holiday = sum('holiday');
  const pto = sum('pto');
  const sick = sum('sick');

  return {
    ...totals,
    start: from,
    end: to,
    days,
    holiday,
    pto,
    sick,
    total: totals.paid + holiday + pto + sick,
    leave: inRange,
  };
}

/** Hours for every employee given, over any run of days. */
export function computePayroll(
  employees: Employee[],
  shifts: Shift[],
  leave: LeaveEntry[],
  start: number,
  end: number,
  now: number,
  options: PayrollOptions = {},
): EmployeePayroll[] {
  const shiftsOf = new Map<string, Shift[]>();
  for (const shift of shifts) {
    const list = shiftsOf.get(shift.employeeId);
    if (list) list.push(shift);
    else shiftsOf.set(shift.employeeId, [shift]);
  }
  const leaveOf = new Map<string, LeaveEntry[]>();
  for (const entry of leave) {
    const list = leaveOf.get(entry.employeeId);
    if (list) list.push(entry);
    else leaveOf.set(entry.employeeId, [entry]);
  }
  return employees.map((employee) => ({
    employee,
    ...computeRange(shiftsOf.get(employee.id) ?? [], leaveOf.get(employee.id) ?? [], start, end, now, options),
  }));
}

export interface PayrollSum extends PayrollTotals {
  holiday: number;
  pto: number;
  sick: number;
  total: number;
}

export function sumPayroll(rows: RangePayroll[]): PayrollSum {
  const totals = emptyTotals();
  let holiday = 0;
  let pto = 0;
  let sick = 0;
  for (const row of rows) {
    addTotals(totals, row);
    holiday += row.holiday;
    pto += row.pto;
    sick += row.sick;
  }
  return { ...totals, holiday, pto, sick, total: totals.paid + holiday + pto + sick };
}

// ---- Gross pay estimate ------------------------------------------------------------------

export type EarningCode = 'ST' | 'OT' | 'DT' | 'Holiday' | 'PTO' | 'Sick';

export interface PayLine {
  code: EarningCode;
  label: string;
  /** Hundredths of an hour. */
  hours: number;
  /** The rate for this line. Time-and-a-half on an odd-cent rate ends in half a cent. */
  rateCents: number;
  /** Whole cents. */
  amountCents: number;
}

type EarningField = 'reg' | 'ot' | 'dt' | 'holiday' | 'pto' | 'sick';

/** Earning lines in the order they appear on the pay stub, each with its pay multiple as a fraction. */
const EARNINGS: { code: EarningCode; label: string; field: EarningField; times: [number, number] }[] = [
  { code: 'ST', label: 'Straight time', field: 'reg', times: [1, 1] },
  { code: 'OT', label: 'Overtime', field: 'ot', times: [3, 2] },
  { code: 'DT', label: 'Double time', field: 'dt', times: [2, 1] },
  { code: 'Holiday', label: 'Holiday', field: 'holiday', times: [1, 1] },
  { code: 'PTO', label: 'PTO', field: 'pto', times: [1, 1] },
  { code: 'Sick', label: 'Sick', field: 'sick', times: [1, 1] },
];

/**
 * Gross pay for a set of hours at one hourly rate: straight time at the rate,
 * overtime at 1.5 times, double time at 2 times, and paid leave at the rate.
 * Each line is rounded to the cent, the way a pay stub shows it. It is an
 * estimate before taxes and deductions; the pay stub is the official figure.
 */
export function estimateGross(
  hours: Record<EarningField, number>,
  rateCents: number,
): { lines: PayLine[]; grossCents: number } {
  const lines: PayLine[] = [];
  for (const earning of EARNINGS) {
    const worked = hours[earning.field];
    if (worked <= 0) continue;
    const [up, down] = earning.times;
    lines.push({
      code: earning.code,
      label: earning.label,
      hours: worked,
      rateCents: (rateCents * up) / down,
      amountCents: Math.round((worked * rateCents * up) / (100 * down)),
    });
  }
  return { lines, grossCents: lines.reduce((sum, line) => sum + line.amountCents, 0) };
}
