import { HOUR, MIN, toHundredths } from '../util/format';
import type { Shift, ShiftFlag } from './types';

/**
 * Timekeeping rules. Defaults follow California law for meal periods
 * (Labor Code §512) and overtime (Labor Code §510 / IWC Wage Order 16).
 */
export interface TimeRules {
  /** A first meal must start before this much work has passed. */
  mealDeadlineMs: number;
  /** Minimum length of an unpaid meal period. */
  mealMinMs: number;
  /** Shifts no longer than this may waive the meal by mutual consent. */
  mealWaiverMaxMs: number;
  /** Work beyond this needs a second meal period. */
  secondMealAfterMs: number;
  /** An open shift older than this is treated as a forgotten clock-out. */
  missingOutAfterMs: number;
  /** Overtime thresholds, in hundredths of an hour (800 = 8.00 hours). */
  dailyOvertimeAfter: number;
  dailyDoubleAfter: number;
  weeklyOvertimeAfter: number;
}

export const CA_RULES: TimeRules = {
  mealDeadlineMs: 5 * HOUR,
  mealMinMs: 30 * MIN,
  mealWaiverMaxMs: 6 * HOUR,
  secondMealAfterMs: 10 * HOUR,
  missingOutAfterMs: 16 * HOUR,
  dailyOvertimeAfter: 800,
  dailyDoubleAfter: 1200,
  weeklyOvertimeAfter: 4000,
};

/** Punches count to the minute, the way a wall time clock does. */
export const floorMin = (ms: number) => Math.floor(ms / MIN) * MIN;

export interface ShiftTotals {
  /** Clock-in to clock-out (or now), in minutes. */
  grossMin: number;
  /** Unpaid lunch, in minutes. */
  lunchMin: number;
  /** Gross minus lunch, in minutes. */
  paidMin: number;
  /**
   * The same three figures the way they go on the timesheet, in hundredths of
   * an hour: time on site converted to a decimal, lunch converted to a decimal,
   * and paid = on site minus lunch. 6:15 AM to 7:00 PM with a 30-minute lunch
   * is 12h 45m -> 12.75, minus 0.50 = 12.25.
   */
  gross: number;
  lunch: number;
  paid: number;
  open: boolean;
  onLunch: boolean;
  onBreak: boolean;
}

export function shiftTotals(shift: Shift, now: number): ShiftTotals {
  const start = floorMin(shift.clockIn.at);
  const end = Math.max(start, floorMin(shift.clockOut?.at ?? now));
  let lunchMs = 0;
  for (const lunch of shift.lunches) {
    const ls = Math.max(start, floorMin(lunch.start.at));
    const le = Math.min(end, floorMin(lunch.end?.at ?? now));
    lunchMs += Math.max(0, le - ls);
  }
  const grossMin = (end - start) / MIN;
  const lunchMin = lunchMs / MIN;
  const lastLunch = shift.lunches[shift.lunches.length - 1];
  const lastBreak = shift.breaks[shift.breaks.length - 1];
  const gross = toHundredths(grossMin);
  const lunch = toHundredths(lunchMin);
  return {
    grossMin,
    lunchMin,
    paidMin: Math.max(0, grossMin - lunchMin),
    gross,
    lunch,
    paid: Math.max(0, gross - lunch),
    open: !shift.clockOut,
    onLunch: !shift.clockOut && !!lastLunch && !lastLunch.end,
    onBreak: !shift.clockOut && !!lastBreak && !lastBreak.end,
  };
}

export type MealState =
  /** More than an hour of margin left. */
  | 'not_due'
  /** Inside the last hour. */
  | 'soon'
  /** Inside the last 30 minutes. */
  | 'urgent'
  /** Fifth hour ended with no meal started. */
  | 'overdue'
  | 'at_lunch'
  | 'taken';

export interface MealStatus {
  state: MealState;
  /** The moment the fifth hour of work ends. Lunch has to start before this. */
  deadlineAt: number;
  /** Time left to start lunch (0 once overdue or taken). */
  remainingMs: number;
  /** While at lunch: time already taken and time left until the 30-minute minimum. */
  lunchElapsedMs: number;
  lunchRemainingMs: number;
  /** 0–1 share of the five-hour window used up. */
  progress: number;
}

/** Where an open shift stands against the five-hour meal deadline. */
export function mealStatus(shift: Shift, now: number, rules: TimeRules = CA_RULES): MealStatus {
  const deadlineAt = shift.clockIn.at + rules.mealDeadlineMs;
  const first = shift.lunches[0];
  const current = shift.lunches[shift.lunches.length - 1];
  const base = { deadlineAt, remainingMs: 0, lunchElapsedMs: 0, lunchRemainingMs: 0, progress: 1 };

  if (current && !current.end) {
    const elapsed = Math.max(0, now - current.start.at);
    return {
      ...base,
      state: 'at_lunch',
      lunchElapsedMs: elapsed,
      lunchRemainingMs: Math.max(0, rules.mealMinMs - elapsed),
    };
  }
  if (first) return { ...base, state: 'taken' };

  const remainingMs = deadlineAt - now;
  const progress = Math.min(1, Math.max(0, (now - shift.clockIn.at) / rules.mealDeadlineMs));
  let state: MealState = 'not_due';
  if (remainingMs <= 0) state = 'overdue';
  else if (remainingMs <= 30 * MIN) state = 'urgent';
  else if (remainingMs <= HOUR) state = 'soon';
  return { ...base, state, remainingMs: Math.max(0, remainingMs), progress };
}

/** True once the 30-minute minimum has been taken and the lunch can be ended. */
export function canEndLunch(shift: Shift, now: number, rules: TimeRules = CA_RULES): boolean {
  const current = shift.lunches[shift.lunches.length - 1];
  if (!current || current.end) return false;
  return now - current.start.at >= rules.mealMinMs;
}

/** Things on a shift that payroll or safety should look at. */
export function shiftFlags(shift: Shift, now: number, rules: TimeRules = CA_RULES): ShiftFlag[] {
  const flags: ShiftFlag[] = [];
  const totals = shiftTotals(shift, now);
  const startMin = floorMin(shift.clockIn.at);
  const grossMs = totals.grossMin * MIN;
  const first = shift.lunches[0];

  if (!shift.clockOut && now - shift.clockIn.at > rules.missingOutAfterMs) {
    flags.push('missing_out');
    if (shift.edits?.length) flags.push('edited');
    return flags;
  }

  if (!first) {
    const waived = shift.mealNote === 'waived_short_shift' && grossMs <= rules.mealWaiverMaxMs;
    if (grossMs >= rules.mealDeadlineMs && !waived) flags.push('no_lunch');
  } else if (floorMin(first.start.at) - startMin >= rules.mealDeadlineMs) {
    flags.push('late_lunch');
  }

  const short = shift.lunches.some(
    (l) => l.end && floorMin(l.end.at) - floorMin(l.start.at) < rules.mealMinMs,
  );
  if (short) flags.push('short_lunch');

  if (totals.paidMin * MIN > rules.secondMealAfterMs && shift.lunches.length < 2) {
    flags.push('second_meal');
  }
  if (shift.clockOut?.geo && !shift.clockOut.geo.inside) flags.push('offsite_out');
  if (shift.edits?.length) flags.push('edited');

  const punches = [shift.clockIn, shift.clockOut, ...shift.lunches.flatMap((l) => [l.start, l.end])];
  if (punches.some((p) => p?.geo?.mocked)) flags.push('mock_gps');

  return flags;
}

export const MEAL_FLAGS: ShiftFlag[] = ['late_lunch', 'no_lunch', 'short_lunch', 'second_meal'];

export const FLAG_LABEL: Record<ShiftFlag, string> = {
  late_lunch: 'Late lunch',
  no_lunch: 'No lunch',
  short_lunch: 'Short lunch',
  second_meal: '2nd meal due',
  offsite_out: 'Clocked out off site',
  missing_out: 'Missing clock-out',
  edited: 'Edited',
  mock_gps: 'Simulated GPS',
};

export const FLAG_HELP: Record<ShiftFlag, string> = {
  late_lunch: 'Lunch started after the end of the fifth hour of work.',
  no_lunch: 'Worked five hours or more with no lunch on record.',
  short_lunch: 'A lunch shorter than 30 minutes was recorded.',
  second_meal: 'More than ten hours worked with only one meal period.',
  offsite_out: 'The clock-out location was outside the mine boundary.',
  missing_out: 'The shift was never clocked out. A supervisor needs to set the end time.',
  edited: 'A supervisor changed one or more punch times.',
  mock_gps: 'The phone reported a simulated location for a punch.',
};

export const MEAL_NOTE_LABEL = {
  forgot_punch: 'Took lunch, forgot to punch',
  worked_through: 'Worked through lunch',
  waived_short_shift: 'Short shift — lunch waived',
} as const;

export interface LunchReminder {
  id: string;
  at: number;
  title: string;
  body: string;
}

/**
 * Reminder schedule for a shift with no lunch yet: one hour, 30 minutes and
 * 15 minutes before the fifth hour ends, then once more when it does.
 */
export function lunchReminders(clockInAt: number, rules: TimeRules = CA_RULES): LunchReminder[] {
  const deadline = clockInAt + rules.mealDeadlineMs;
  return [
    {
      id: 'lunch-60',
      at: deadline - HOUR,
      title: 'Lunch within the hour',
      body: 'You have 1 hour left to start your 30-minute lunch.',
    },
    {
      id: 'lunch-30',
      at: deadline - 30 * MIN,
      title: '30 minutes to start lunch',
      body: 'Wrap up and start your lunch before your fifth hour ends.',
    },
    {
      id: 'lunch-15',
      at: deadline - 15 * MIN,
      title: 'Start lunch now',
      body: '15 minutes left before your fifth hour ends. Clock out for lunch.',
    },
    {
      id: 'lunch-0',
      at: deadline,
      title: 'Lunch is overdue',
      body: 'Your fifth hour has ended with no lunch on record. Start lunch and tell your supervisor.',
    },
  ];
}
