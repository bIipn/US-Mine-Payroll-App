import { addDays, startOfDay } from '@app/util/format';

/**
 * Date ranges for the exports. A range is the first day up to, not including,
 * the day after the last day. The PDF for an inspector covers up to 12 months:
 * an exam record is kept for a year (30 CFR 56.18002(d)), so a year is the
 * longest an inspector needs.
 */

export type Preset = 'today' | '7' | '30' | '365';

export const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '365', label: 'Last 12 months' },
];

export interface DayRange {
  from: number;
  /** The start of the day after the last day. */
  to: number;
}

/** The same days the app's safety log offers: today, or that many days ending today. */
export function presetRange(preset: Preset, now: number): DayRange {
  const to = addDays(startOfDay(now), 1);
  return { from: addDays(to, preset === 'today' ? -1 : -Number(preset)), to };
}

/** A YYYY-MM-DD date at the start of that day here, or undefined when it is not a real date. */
export function parseDay(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = new Date(y, m, d);
  return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date.getTime() : undefined;
}

/** The same day of the month, so many months on; the last day of a shorter month when there is no such day. */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last)).getTime();
}

/** A range typed as two dates, both days included, or what is wrong with it and which of the two to change. */
export function typedRange(fromText: string, toText: string, maxMonths = 12): DayRange | { error: string; field: 'from' | 'to' } {
  const from = parseDay(fromText);
  const last = parseDay(toText);
  if (from === undefined) return { error: 'Give the first day as a date.', field: 'from' };
  if (last === undefined) return { error: 'Give the last day as a date.', field: 'to' };
  if (last < from) return { error: 'The last day comes before the first day. Swap them.', field: 'to' };
  const to = addDays(last, 1);
  if (to > addMonths(from, maxMonths)) {
    return { error: `This covers up to ${maxMonths} months. Pick a first day no more than ${maxMonths} months before the last day.`, field: 'from' };
  }
  return { from, to };
}
