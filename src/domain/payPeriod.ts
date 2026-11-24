import { addDays, startOfDay, ymd } from '../util/format';

/**
 * Pay periods, as the company sets them.
 *
 * A company pays every week, every two weeks, twice a month (the 1st to the
 * 15th and the 16th to the end of the month) or once a month. Its pay date is
 * so many days after a period's last day, or a day of the month. When a pay
 * date lands on a weekend or a bank holiday the company decides whether it
 * moves to the banking day before, to the banking day after, or stays.
 *
 * A company that has not set a schedule has no pay periods: hours are shown by
 * the workweek and by the month instead. Hours are always before taxes.
 */

export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export type Payday =
  /** So many days after a period's last day. 0 pays on the last day. */
  | { daysAfter: number }
  /**
   * The next of this day of the month on or after a period's last day. Twice a
   * month can give two: the first half's, then the second half's. A day past
   * the end of a short month means that month's last day.
   */
  | { dayOfMonth: number[] };

export type IfBankClosed = 'before' | 'after' | 'stay';

export interface PaySchedule {
  frequency: PayFrequency;
  /** Every week and every two weeks: the first day of any one period, YYYY-MM-DD. */
  firstDay?: string;
  payday: Payday;
  /** What happens to a pay date that lands on a day the bank is closed. */
  ifBankClosed: IfBankClosed;
}

export interface PayPeriod {
  /** First day of the period, at the start of the day. */
  start: number;
  /** The start of the day after the last day, so `start <= t < end`. */
  end: number;
  /** The last day of the period, at the start of the day. */
  lastDay: number;
  payDate: number;
  /** The pay date before any move for a weekend or holiday. */
  scheduledPayDate: number;
  /** Why the pay date moved, when it did. */
  movedBecause?: string;
}

/** A calendar month: the 1st to the start of the next month. */
export interface Month {
  start: number;
  end: number;
  lastDay: number;
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

/** 1st, 2nd, 3rd, 4th, 11th, 21st. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const end = teen ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${end}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FREQUENCIES: PayFrequency[] = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

/** A YYYY-MM-DD date at the start of that day, or undefined when it is not a real date. */
function parseDay(text: string | undefined): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? '');
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date.getTime() : undefined;
}

const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();

/** What is wrong with a schedule, or undefined when it can be worked out. */
export function checkPaySchedule(schedule: PaySchedule): string | undefined {
  if (!FREQUENCIES.includes(schedule.frequency)) return 'Say how often the company pays.';
  const byWeek = schedule.frequency === 'weekly' || schedule.frequency === 'biweekly';
  if (byWeek && parseDay(schedule.firstDay) === undefined) {
    return 'Give the first day of any one pay period as a date, like 2026-11-01.';
  }
  const payday = schedule.payday;
  if ('daysAfter' in payday) {
    if (!Number.isInteger(payday.daysAfter) || payday.daysAfter < 0 || payday.daysAfter > 60) {
      return 'The days after a period ends must be a whole number from 0 to 60.';
    }
  } else if ('dayOfMonth' in payday && Array.isArray(payday.dayOfMonth)) {
    if (byWeek) return 'A pay period by the week is paid so many days after it ends: give the days after.';
    if (payday.dayOfMonth.length === 0) return 'Give the day of the month the company pays.';
    if (schedule.frequency === 'monthly' && payday.dayOfMonth.length > 1) return 'Once a month is paid on one day of the month.';
    if (payday.dayOfMonth.length > 2) return 'Twice a month is paid on one or two days of the month.';
    if (payday.dayOfMonth.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) {
      return 'A day of the month must be from 1 to 31.';
    }
  } else {
    return 'Say when the company pays.';
  }
  if (!['before', 'after', 'stay'].includes(schedule.ifBankClosed)) {
    return 'Say what happens to a pay date the bank is closed.';
  }
  return undefined;
}

/** The schedule in a sentence, for the settings screen. */
export function describePaySchedule(schedule: PaySchedule): string {
  const payday = schedule.payday;
  const after = (days: number) => (days === 0 ? 'paid on the last day' : `paid ${days} ${days === 1 ? 'day' : 'days'} after the last day`);
  const onDay = (day: number) => `the ${ordinal(day)}${day > 28 ? ' (or the last day of a shorter month)' : ''}`;
  let line: string;
  if (schedule.frequency === 'weekly' || schedule.frequency === 'biweekly') {
    const first = new Date(parseDay(schedule.firstDay) ?? 0).getDay();
    const span = `from ${DAY_NAMES[first]} to ${DAY_NAMES[(first + 6) % 7]}`;
    const how = schedule.frequency === 'weekly' ? 'Every week' : 'Every two weeks';
    line = `${how}, ${span}: ${'daysAfter' in payday ? after(payday.daysAfter) : ''}.`;
  } else if (schedule.frequency === 'semimonthly') {
    if ('dayOfMonth' in payday && payday.dayOfMonth.length === 2) {
      const [first, second] = payday.dayOfMonth;
      line = `Twice a month: the 1st to the 15th is paid on ${onDay(first)}, the 16th to the end of the month on ${onDay(second)}.`;
    } else {
      const when = 'dayOfMonth' in payday ? `paid on ${onDay(payday.dayOfMonth[0])}` : after(payday.daysAfter);
      line = `Twice a month, the 1st to the 15th and the 16th to the end of the month: ${when}.`;
    }
  } else {
    line = `Once a month: ${'dayOfMonth' in payday ? `paid on ${onDay(payday.dayOfMonth[0])}` : after(payday.daysAfter)}.`;
  }
  if (schedule.ifBankClosed === 'stay') return line;
  return `${line} A pay date the bank is closed moves to the banking day ${schedule.ifBankClosed}.`;
}

/** The scheduled pay date of a period that ends on `lastDay`. `second` is the second half of a month. */
function scheduledPayDateFor(schedule: PaySchedule, lastDay: number, second: boolean): number {
  const payday = schedule.payday;
  if ('daysAfter' in payday) return addDays(lastDay, payday.daysAfter);
  const days = payday.dayOfMonth;
  const want = second && days.length > 1 ? days[1] : days[0];
  const last = new Date(lastDay);
  let year = last.getFullYear();
  let month = last.getMonth();
  for (;;) {
    const candidate = at(year, month, Math.min(want, daysInMonth(year, month)));
    if (candidate >= lastDay) return candidate;
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
}

function build(schedule: PaySchedule, start: number, end: number, second = false): PayPeriod {
  const lastDay = addDays(end, -1);
  const scheduledPayDate = scheduledPayDateFor(schedule, lastDay, second);
  const closed = bankClosedReason(scheduledPayDate);
  let payDate = scheduledPayDate;
  if (closed && schedule.ifBankClosed !== 'stay') {
    const step = schedule.ifBankClosed === 'before' ? -1 : 1;
    while (bankClosedReason(payDate)) payDate = addDays(payDate, step);
  }
  return {
    start,
    end,
    lastDay,
    payDate,
    scheduledPayDate,
    movedBecause: payDate !== scheduledPayDate ? `The ${ordinal(new Date(scheduledPayDate).getDate())} is ${closed}` : undefined,
  };
}

/** The pay period a moment falls in, under the company's schedule. */
export function payPeriodOf(ms: number, schedule: PaySchedule): PayPeriod {
  const day = new Date(startOfDay(ms));
  const year = day.getFullYear();
  const month = day.getMonth();
  switch (schedule.frequency) {
    case 'weekly':
    case 'biweekly': {
      const length = schedule.frequency === 'weekly' ? 7 : 14;
      const anchor = parseDay(schedule.firstDay) ?? startOfDay(ms);
      // Whole calendar days, so a change of the clocks never drifts a period.
      const days = Math.round((day.getTime() - anchor) / 86_400_000);
      const start = addDays(anchor, Math.floor(days / length) * length);
      return build(schedule, start, addDays(start, length));
    }
    case 'semimonthly':
      return day.getDate() <= 15
        ? build(schedule, at(year, month, 1), at(year, month, 16))
        : build(schedule, at(year, month, 16), at(year, month + 1, 1), true);
    default:
      return build(schedule, at(year, month, 1), at(year, month + 1, 1));
  }
}

export function nextPayPeriod(period: PayPeriod, schedule: PaySchedule): PayPeriod {
  return payPeriodOf(period.end, schedule);
}

export function previousPayPeriod(period: PayPeriod, schedule: PaySchedule): PayPeriod {
  return payPeriodOf(addDays(period.start, -1), schedule);
}

/** The next pay date on or after today, and the period it pays. */
export function nextPayday(now: number, schedule: PaySchedule): { payDate: number; period: PayPeriod } {
  const today = startOfDay(now);
  // A period can be paid well after it ends: go back to one already paid...
  let period = previousPayPeriod(payPeriodOf(now, schedule), schedule);
  while (period.payDate >= today) period = previousPayPeriod(period, schedule);
  // ...then forward to the first one paid today or later.
  while (period.payDate < today) period = nextPayPeriod(period, schedule);
  return { payDate: period.payDate, period };
}

/** The calendar month a moment falls in. */
export function monthOf(ms: number): Month {
  const day = new Date(ms);
  const start = at(day.getFullYear(), day.getMonth(), 1);
  const end = at(day.getFullYear(), day.getMonth() + 1, 1);
  return { start, end, lastDay: addDays(end, -1) };
}

export function nextMonth(month: Month): Month {
  return monthOf(month.end);
}

export function previousMonth(month: Month): Month {
  return monthOf(addDays(month.start, -1));
}
