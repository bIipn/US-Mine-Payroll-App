import { fmtTime, HOUR, MIN, toHundredths } from '../util/format';
import type { Lunch, Punch, Shift, ShiftFlag } from './types';

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

/**
 * A lunch, from the one tap that starts it. Nobody punches back in: the lunch
 * ends by itself when the 30-minute meal period is up and the person is back on
 * the clock. The end is written down at the start so the record is complete.
 */
export function startedLunch(start: Punch, rules: TimeRules = CA_RULES): Lunch {
  return { start, end: { at: start.at + rules.mealMinMs, auto: true } };
}

/**
 * When a lunch is over. A record with no end time still ends when the meal
 * period is up, so a bad record can never leave someone stuck at lunch.
 */
export function lunchEndAt(lunch: Lunch, rules: TimeRules = CA_RULES): number {
  return lunch.end?.at ?? lunch.start.at + rules.mealMinMs;
}

/**
 * The time a person was back on the clock from a lunch, once that time has
 * come. Until then there is nothing to show: the end of a lunch is written down
 * when it starts, but it has not happened yet.
 */
export function backFromLunchAt(lunch: Lunch | undefined, now: number, rules: TimeRules = CA_RULES): number | undefined {
  if (!lunch) return undefined;
  const end = lunchEndAt(lunch, rules);
  return now >= end ? end : undefined;
}

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
    // While the person is still at lunch, only the part already taken has come off.
    const le = Math.min(end, floorMin(lunchEndAt(lunch)));
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
    onLunch: !shift.clockOut && !!lastLunch && now < lunchEndAt(lastLunch),
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
  /** While at lunch: time already taken, and time left until it ends by itself. */
  lunchElapsedMs: number;
  lunchRemainingMs: number;
  /** While at lunch: the moment the person goes back on the clock. */
  lunchEndsAt?: number;
  /** 0–1 share of the five-hour window used up. */
  progress: number;
}

/** Where an open shift stands against the five-hour meal deadline. */
export function mealStatus(shift: Shift, now: number, rules: TimeRules = CA_RULES): MealStatus {
  const deadlineAt = shift.clockIn.at + rules.mealDeadlineMs;
  const first = shift.lunches[0];
  const current = shift.lunches[shift.lunches.length - 1];
  const base = { deadlineAt, remainingMs: 0, lunchElapsedMs: 0, lunchRemainingMs: 0, progress: 1 };

  if (current) {
    const lunchEndsAt = lunchEndAt(current, rules);
    if (now < lunchEndsAt) {
      return {
        ...base,
        state: 'at_lunch',
        lunchElapsedMs: Math.max(0, now - current.start.at),
        // A screen clock that is a moment behind the tap must not show more than the whole lunch.
        lunchRemainingMs: Math.min(lunchEndsAt - now, lunchEndsAt - current.start.at),
        lunchEndsAt,
      };
    }
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
      body: '15 minutes left before your fifth hour ends. Tap Start lunch.',
    },
    {
      id: 'lunch-0',
      at: deadline,
      title: 'Lunch is overdue',
      body: 'Your fifth hour has ended with no lunch on record. Start lunch and tell your supervisor.',
    },
  ];
}

/** The notice sent when a lunch ends by itself and the person is back on the clock. */
export function lunchOverReminder(lunchEndsAt: number): LunchReminder {
  return {
    id: LUNCH_OVER_ID,
    at: lunchEndsAt,
    title: 'Lunch is over',
    body: `You are back on the clock as of ${fmtTime(lunchEndsAt)}.`,
  };
}

const LUNCH_OVER_ID = 'lunch-end';
const DEADLINE_IDS = ['lunch-60', 'lunch-30', 'lunch-15', 'lunch-0'];

/**
 * The notifications a shift should have waiting right now, and the ones to clear.
 *
 *   on the clock, no lunch yet  -> the lunch-deadline reminders, if the person has them turned on
 *   at lunch                    -> the lunch-is-over notice, always: it is how they
 *                                  learn they are back on the clock
 *   lunch done or off the clock -> nothing
 */
export function reminderPlan(
  shift: Shift | undefined,
  remindersOn: boolean,
  now: number,
  rules: TimeRules = CA_RULES,
): { schedule: LunchReminder[]; cancel: string[] } {
  const nothing = { schedule: [], cancel: [...DEADLINE_IDS, LUNCH_OVER_ID] };
  if (!shift || shift.clockOut) return nothing;
  const current = shift.lunches[shift.lunches.length - 1];
  if (current && now < lunchEndAt(current, rules)) {
    return { schedule: [lunchOverReminder(lunchEndAt(current, rules))], cancel: DEADLINE_IDS };
  }
  if (current || !remindersOn) return nothing;
  return { schedule: lunchReminders(shift.clockIn.at, rules), cancel: [LUNCH_OVER_ID] };
}
