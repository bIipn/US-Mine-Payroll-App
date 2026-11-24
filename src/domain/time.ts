import { fmtTime, HOUR, MIN, toHundredths } from '../util/format';
import type { GeoStamp, Lunch, NoLocation, Punch, Shift, ShiftFlag } from './types';

/**
 * Timekeeping rules. Overtime and meal periods follow the state the company
 * is in (`rulesFor` in stateRules.ts). California's are below: Labor Code §512
 * for meal periods, and §510 / IWC Wage Order 16 for overtime. Where a state
 * has no rule of its own, federal law (the FLSA) is what applies.
 */

/** A lunch is 30 minutes, unpaid, in every state: the company's practice, never shorter than a state allows. */
export const LUNCH_MS = 30 * MIN;

export interface MealRules {
  /** A meal period is owed on a shift of this much work or more. */
  owedAfterMs: number;
  /** The meal must start before this much work has passed, when the law sets a time. */
  startByMs: number | null;
  /** The shortest meal period the law accepts. Null where it says only "a reasonable period". */
  minMs: number | null;
  /** Shifts no longer than this may waive the meal by mutual consent. */
  waiverMaxMs: number | null;
  /** Work beyond this needs a second meal period. */
  secondAfterMs: number | null;
}

export interface TimeRules {
  /** Whose rules these are: "California", "federal law (FLSA)". */
  name: string;
  /** Null where the law requires no meal period. */
  meal: MealRules | null;
  /** An open shift older than this is treated as a forgotten clock-out. */
  missingOutAfterMs: number;
  /** Overtime thresholds, in hundredths of an hour (800 = 8.00 hours). Null where there is none by the day. */
  dailyOvertimeAfter: number | null;
  dailyDoubleAfter: number | null;
  weeklyOvertimeAfter: number;
  /**
   * A seventh-day rule: when all seven days of a workweek are worked, the seventh is all premium time,
   * time-and-a-half up to `doubleAfter` hundredths and double time past it (California: 8.00; Kentucky: never).
   */
  seventhDay: { doubleAfter: number | null } | null;
  /** A state rule the app cannot apply, said plainly for the Company screen. */
  note?: string;
}

export const CA_RULES: TimeRules = {
  name: 'California',
  meal: { owedAfterMs: 5 * HOUR, startByMs: 5 * HOUR, minMs: 30 * MIN, waiverMaxMs: 6 * HOUR, secondAfterMs: 10 * HOUR },
  missingOutAfterMs: 16 * HOUR,
  dailyOvertimeAfter: 800,
  dailyDoubleAfter: 1200,
  weeklyOvertimeAfter: 4000,
  seventhDay: { doubleAfter: 800 },
};

/** The FLSA alone: time-and-a-half past 40 hours in a workweek, no daily overtime, no meal period required. */
export const FEDERAL_RULES: TimeRules = {
  name: 'federal law (FLSA)',
  meal: null,
  missingOutAfterMs: 16 * HOUR,
  dailyOvertimeAfter: null,
  dailyDoubleAfter: null,
  weeklyOvertimeAfter: 4000,
  seventhDay: null,
};

const hrs = (hundredths: number) => `${hundredths / 100}`;
const hoursOf = (ms: number) => `${Math.round((ms / HOUR) * 100) / 100}`;
const ORDINAL_HOURS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** "the fifth hour" for 5 hours; "5.5 hours" past a whole number. */
export function deadlineWords(ms: number): string {
  const whole = ms / HOUR;
  return Number.isInteger(whole) && ORDINAL_HOURS[whole] ? `the ${ORDINAL_HOURS[whole]} hour` : `${hoursOf(ms)} hours`;
}

/** When a meal period is owed under these rules, in one sentence. */
export function mealSummary(rules: TimeRules): string {
  const meal = rules.meal;
  if (!meal) return 'No meal period is required by law. A lunch taken is 30 minutes, unpaid.';
  const length = meal.minMs != null ? `A ${Math.round(meal.minMs / MIN)}-minute meal period` : 'A lunch period';
  const second = meal.secondAfterMs != null ? `, and a second is owed past ${hoursOf(meal.secondAfterMs)} hours` : '';
  if (meal.startByMs != null) {
    const words = deadlineWords(meal.startByMs);
    const by = words.startsWith('the ') ? `the end of ${words}` : words;
    return `${length} has to start before ${by} of work${second}.`;
  }
  return `${length} is owed on a shift of ${hoursOf(meal.owedAfterMs)} hours or more${second}.`;
}

/** How overtime is figured under these rules, in one sentence. */
export function overtimeSummary(rules: TimeRules): string {
  const whose = rules.name === FEDERAL_RULES.name ? rules.name : `${rules.name} rules`;
  const weekly = hrs(rules.weeklyOvertimeAfter);
  if (rules.dailyOvertimeAfter == null) {
    const seventh = rules.seventhDay ? ', and every hour of a seventh day worked in the workweek' : '';
    return `Overtime follows ${whose}: over ${weekly} hours in a workweek is OT${seventh}. There is no daily overtime.`;
  }
  const double = rules.dailyDoubleAfter != null ? `, over ${hrs(rules.dailyDoubleAfter)} a day is DT` : '';
  const seventh = rules.seventhDay ? ', with the seventh-day rule' : '';
  return `Overtime follows ${whose}: over ${hrs(rules.dailyOvertimeAfter)} hours a day or ${weekly} straight-time hours in a workweek is OT${double}${seventh}.`;
}

/** Punches count to the minute, the way a wall time clock does. */
export const floorMin = (ms: number) => Math.floor(ms / MIN) * MIN;

/**
 * A punch at `at`, with where the phone was or why it gave no location: never
 * both. With neither, no location was read for it at all.
 */
export function punchAt(at: number, where?: GeoStamp | NoLocation): Punch {
  if (where === undefined) return { at };
  return typeof where === 'string' ? { at, noLocation: where } : { at, geo: where };
}

/**
 * A lunch, from the one tap that starts it. Nobody punches back in: the lunch
 * ends by itself when the 30-minute meal period is up and the person is back on
 * the clock. The end is written down at the start so the record is complete.
 */
export function startedLunch(start: Punch): Lunch {
  return { start, end: { at: start.at + LUNCH_MS, auto: true } };
}

/**
 * When a lunch is over. A record with no end time still ends when the meal
 * period is up, so a bad record can never leave someone stuck at lunch.
 */
export function lunchEndAt(lunch: Lunch): number {
  return lunch.end?.at ?? lunch.start.at + LUNCH_MS;
}

/**
 * The time a person was back on the clock from a lunch, once that time has
 * come. Until then there is nothing to show: the end of a lunch is written down
 * when it starts, but it has not happened yet.
 */
export function backFromLunchAt(lunch: Lunch | undefined, now: number): number | undefined {
  if (!lunch) return undefined;
  const end = lunchEndAt(lunch);
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
  /** The moment lunch has to start before, when the state's law sets one (California: the end of the fifth hour). */
  deadlineAt: number | null;
  /** Time left to start lunch (0 once overdue or taken). */
  remainingMs: number;
  /** While at lunch: time already taken, and time left until it ends by itself. */
  lunchElapsedMs: number;
  lunchRemainingMs: number;
  /** While at lunch: the moment the person goes back on the clock. */
  lunchEndsAt?: number;
  /** 0–1 share of the window before the deadline used up. */
  progress: number;
}

/** Where an open shift stands against the state's meal deadline, when it has one. */
export function mealStatus(shift: Shift, now: number, rules: TimeRules = CA_RULES): MealStatus {
  const startBy = rules.meal?.startByMs ?? null;
  const deadlineAt = startBy == null ? null : shift.clockIn.at + startBy;
  const first = shift.lunches[0];
  const current = shift.lunches[shift.lunches.length - 1];
  const base = { deadlineAt, remainingMs: 0, lunchElapsedMs: 0, lunchRemainingMs: 0, progress: 1 };

  if (current) {
    const lunchEndsAt = lunchEndAt(current);
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
  if (deadlineAt == null || startBy == null) return { ...base, state: 'not_due', progress: 0 };

  const remainingMs = deadlineAt - now;
  const progress = Math.min(1, Math.max(0, (now - shift.clockIn.at) / startBy));
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
    // No meal rule can be judged until a supervisor sets the end, but what the punches say still stands.
    return ['missing_out', ...punchFlags(shift)];
  }

  const meal = rules.meal;
  if (meal) {
    if (!first) {
      const waived = shift.mealNote === 'waived_short_shift' && meal.waiverMaxMs != null && grossMs <= meal.waiverMaxMs;
      if (grossMs >= meal.owedAfterMs && !waived) flags.push('no_lunch');
    } else if (meal.startByMs != null && floorMin(first.start.at) - startMin >= meal.startByMs) {
      flags.push('late_lunch');
    }

    const min = meal.minMs;
    const short = min != null && shift.lunches.some((l) => l.end && floorMin(l.end.at) - floorMin(l.start.at) < min);
    if (short) flags.push('short_lunch');

    if (meal.secondAfterMs != null && totals.paidMin * MIN > meal.secondAfterMs && shift.lunches.length < 2) {
      flags.push('second_meal');
    }
  }
  if (shift.clockOut?.geo && !shift.clockOut.geo.inside) flags.push('offsite_out');
  return [...flags, ...punchFlags(shift)];
}

/** What a shift's punches say, whether or not it was ever clocked out: corrected, simulated, or clocked in with no location. */
function punchFlags(shift: Shift): ShiftFlag[] {
  const flags: ShiftFlag[] = [];
  if (shift.edits?.length) flags.push('edited');
  const punches = [shift.clockIn, shift.clockOut, ...shift.lunches.flatMap((l) => [l.start, l.end])];
  if (punches.some((p) => p?.geo?.mocked)) flags.push('mock_gps');
  // Only a clock-in is checked against the boundary, so only a clock-in with no location is one to review.
  if (shift.clockIn.noLocation) flags.push('no_location');
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
  no_location: 'No location',
};

/** What a flag means, by the state's own times. */
export function flagHelp(flag: ShiftFlag, rules: TimeRules): string {
  const meal = rules.meal;
  switch (flag) {
    case 'late_lunch':
      return meal?.startByMs != null ? `Lunch started after the end of ${deadlineWords(meal.startByMs)} of work.` : 'Lunch started late.';
    case 'no_lunch':
      return `Worked ${hoursOf(meal?.owedAfterMs ?? 0)} hours or more with no lunch on record.`;
    case 'short_lunch':
      return `A lunch shorter than ${Math.round((meal?.minMs ?? LUNCH_MS) / MIN)} minutes was recorded.`;
    case 'second_meal':
      return `More than ${hoursOf(meal?.secondAfterMs ?? 0)} hours worked with only one meal period.`;
    case 'offsite_out':
      return 'The clock-out location was outside the mine boundary.';
    case 'missing_out':
      return 'The shift was never clocked out. A supervisor needs to set the end time.';
    case 'edited':
      return 'A supervisor changed one or more punch times.';
    case 'mock_gps':
      return 'The phone reported a simulated location for a punch.';
    case 'no_location':
      return 'The phone gave no location when this shift was clocked in (location off, approximate only, or no fix), so the clock-in was not checked against the mine boundary. Nothing is paid or docked for it.';
  }
}

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
 * 15 minutes before the state's meal deadline, then once more when it passes.
 * None where the state sets no time a meal must start by.
 */
export function lunchReminders(clockInAt: number, rules: TimeRules = CA_RULES): LunchReminder[] {
  const startBy = rules.meal?.startByMs;
  if (startBy == null) return [];
  const deadline = clockInAt + startBy;
  const ends = deadlineWords(startBy);
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
      body: `Wrap up and start your lunch before ${ends.replace('the ', 'your ')} ends.`,
    },
    {
      id: 'lunch-15',
      at: deadline - 15 * MIN,
      title: 'Start lunch now',
      body: `15 minutes left before ${ends.replace('the ', 'your ')} ends. Tap Start lunch.`,
    },
    {
      id: 'lunch-0',
      at: deadline,
      title: 'Lunch is overdue',
      body: `${ends.replace('the ', 'Your ')} has ended with no lunch on record. Start lunch and tell your supervisor.`,
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
  if (current && now < lunchEndAt(current)) {
    return { schedule: [lunchOverReminder(lunchEndAt(current))], cancel: DEADLINE_IDS };
  }
  if (current || !remindersOn) return nothing;
  const schedule = lunchReminders(shift.clockIn.at, rules);
  // Where the state sets no deadline there is nothing to schedule, so clear any a phone still holds
  // from before the company's state changed: scheduling never replaces what is not scheduled again.
  return { schedule, cancel: schedule.length ? [LUNCH_OVER_ID] : [LUNCH_OVER_ID, ...DEADLINE_IDS] };
}
