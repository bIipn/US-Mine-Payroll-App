import { addDays, startOfDay, ymd } from '../util/format';

/**
 * Pay periods.
 *
 * U.S. Mine pays twice a month: the 1st through the 15th is paid on the 20th,
 * and the 16th through the end of the month is paid on the 5th of the next
 * month. When a pay date lands on a weekend or a bank holiday it moves to the
 * last banking day before it.
 */

export const PAY_SCHEDULE = {
  /** Day of the month the 1st-15th is paid. */
  firstHalfPaidOn: 20,
  /** Day of the following month the 16th-end is paid. */
  secondHalfPaidOn: 5,
} as const;

export interface PayPeriod {
  /** First day of the period, at the start of the day. */
  start: number;
  /** The start of the day after the last day, so `start <= t < end`. */
  end: number;
  /** The last day of the period, at the start of the day. */
  lastDay: number;
  /** 1 = the 1st to the 15th. 2 = the 16th to the end of the month. */
  half: 1 | 2;
  payDate: number;
  /** The 5th or the 20th, before any move for a weekend or holiday. */
  scheduledPayDate: number;
  /** Why the pay date moved, when it did. */
  movedBecause?: string;
}

const at = (year: number, month: number, day: number) => new Date(year, month, day).getTime();

/** The nth (1-based) given weekday of a month. `weekday` 0 = Sunday. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(year, month, 1).getDay();
  return at(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}

function lastWeekday(year: number, month: number, weekday: number): number {
  const last = new Date(year, month + 1, 0);
  return at(year, month, last.getDate() - ((last.getDay() - weekday + 7) % 7));
}

const holidayCache = new Map<number, Map<string, string>>();

/**
 * Federal Reserve bank holidays for a year, keyed by date (YYYY-MM-DD).
 * A holiday on a Sunday is also observed on the Monday after. A holiday on a
 * Saturday is not moved: banks are open the Friday before.
 */
export function bankHolidays(year: number): Map<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const list: [number, string][] = [
    [at(year, 0, 1), "New Year's Day"],
    [nthWeekday(year, 0, 1, 3), 'Martin Luther King Jr. Day'],
    [nthWeekday(year, 1, 1, 3), "Presidents' Day"],
    [lastWeekday(year, 4, 1), 'Memorial Day'],
    [at(year, 5, 19), 'Juneteenth'],
    [at(year, 6, 4), 'Independence Day'],
    [nthWeekday(year, 8, 1, 1), 'Labor Day'],
    [nthWeekday(year, 9, 1, 2), 'Columbus Day'],
    [at(year, 10, 11), 'Veterans Day'],
    [nthWeekday(year, 10, 4, 4), 'Thanksgiving'],
    [at(year, 11, 25), 'Christmas Day'],
  ];
  const map = new Map<string, string>();
  for (const [day, name] of list) map.set(ymd(day), name);
  holidayCache.set(year, map);
  return map;
}

/** The reason banks are closed on this day, or undefined when they are open. */
export function bankClosedReason(ms: number): string | undefined {
  const day = new Date(startOfDay(ms));
  if (day.getDay() === 6) return 'a Saturday';
  if (day.getDay() === 0) return 'a Sunday';
  const holiday = bankHolidays(day.getFullYear()).get(ymd(day.getTime()));
  if (holiday) return holiday;
  // A Sunday holiday is observed on the Monday.
  if (day.getDay() === 1) {
    const sunday = addDays(day.getTime(), -1);
    const observed = bankHolidays(new Date(sunday).getFullYear()).get(ymd(sunday));
    if (observed) return `${observed} (observed)`;
  }
  return undefined;
}

function build(year: number, month: number, half: 1 | 2): PayPeriod {
  const start = half === 1 ? at(year, month, 1) : at(year, month, 16);
  const end = half === 1 ? at(year, month, 16) : at(year, month + 1, 1);
  const scheduledPayDate =
    half === 1 ? at(year, month, PAY_SCHEDULE.firstHalfPaidOn) : at(year, month + 1, PAY_SCHEDULE.secondHalfPaidOn);

  let payDate = scheduledPayDate;
  const movedBecause = bankClosedReason(scheduledPayDate);
  while (bankClosedReason(payDate)) payDate = addDays(payDate, -1);

  return {
    start,
    end,
    lastDay: addDays(end, -1),
    half,
    payDate,
    scheduledPayDate,
    movedBecause: movedBecause ? `The ${new Date(scheduledPayDate).getDate()}th is ${movedBecause}` : undefined,
  };
}

/** The pay period a moment falls in. */
export function payPeriodOf(ms: number): PayPeriod {
  const day = new Date(ms);
  return build(day.getFullYear(), day.getMonth(), day.getDate() <= 15 ? 1 : 2);
}

export function nextPayPeriod(period: PayPeriod): PayPeriod {
  return payPeriodOf(period.end);
}

export function previousPayPeriod(period: PayPeriod): PayPeriod {
  return payPeriodOf(addDays(period.start, -1));
}

/** The next pay date on or after today, and the period it pays. */
export function nextPayday(now: number): { payDate: number; period: PayPeriod } {
  const today = startOfDay(now);
  let period = previousPayPeriod(payPeriodOf(now));
  // A pay date can move earlier, so walk forward until one is today or later.
  while (period.payDate < today) period = nextPayPeriod(period);
  return { payDate: period.payDate, period };
}
