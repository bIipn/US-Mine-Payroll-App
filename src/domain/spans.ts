import { addDays, fmtRange, startOfWeek } from '../util/format';
import { monthOf, nextMonth, nextPayPeriod, payPeriodOf, previousMonth, previousPayPeriod, type PaySchedule } from './payPeriod';

/**
 * The runs of days hours are shown for: the company's pay period when it has
 * set one, the workweek overtime is figured on, and the calendar month.
 */
export type SpanKind = 'period' | 'week' | 'month';

export interface Span {
  kind: SpanKind;
  start: number;
  /** The start of the day after the last day. */
  end: number;
  lastDay: number;
  /** Pay periods only. */
  payDate?: number;
  scheduledPayDate?: number;
  movedBecause?: string;
}

export interface SpanOptions {
  pay: PaySchedule | null;
  /** 0 = Sunday. */
  weekStartsOn: number;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const SPAN_NAME: Record<SpanKind, string> = { period: 'Pay period', week: 'Workweek', month: 'Month' };

/** The kinds a company's hours can be shown by. A pay period only once the company has set one. */
export function viewsFor(pay: PaySchedule | null): SpanKind[] {
  return pay ? ['period', 'week', 'month'] : ['week', 'month'];
}

/** The span of a kind that a moment falls in. A pay period with no schedule set is the workweek. */
export function spanOf(kind: SpanKind, ms: number, options: SpanOptions): Span {
  if (kind === 'period' && options.pay) return { kind, ...payPeriodOf(ms, options.pay) };
  if (kind === 'month') return { kind, ...monthOf(ms) };
  const start = startOfWeek(ms, options.weekStartsOn);
  const end = addDays(start, 7);
  return { kind: 'week', start, end, lastDay: addDays(end, -1) };
}

export function stepSpan(span: Span, direction: 1 | -1, options: SpanOptions): Span {
  if (span.kind === 'period' && options.pay) {
    const step = direction === 1 ? nextPayPeriod : previousPayPeriod;
    return { kind: 'period', ...step({ ...span, payDate: span.payDate ?? 0, scheduledPayDate: span.scheduledPayDate ?? 0 }, options.pay) };
  }
  if (span.kind === 'month') return { kind: 'month', ...(direction === 1 ? nextMonth(span) : previousMonth(span)) };
  return spanOf('week', addDays(span.start, 7 * direction), options);
}

/** Whether a span is the one now falls in, or later: there is nothing after it to step to. */
export function isCurrentSpan(span: Span, now: number, options: SpanOptions): boolean {
  return span.start >= spanOf(span.kind, now, options).start;
}

/** "November 2026" for a month, "Nov 15 – Nov 21" for anything else. */
export function spanLabel(span: Span): string {
  if (span.kind === 'month') {
    const day = new Date(span.start);
    return `${MONTHS[day.getMonth()]} ${day.getFullYear()}`;
  }
  return fmtRange(span.start, span.lastDay);
}
