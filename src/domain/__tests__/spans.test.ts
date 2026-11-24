import { ymd } from '../../util/format';
import type { PaySchedule } from '../payPeriod';
import { isCurrentSpan, spanLabel, spanOf, stepSpan, viewsFor } from '../spans';

const d = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();
const TWICE_A_MONTH: PaySchedule = { frequency: 'semimonthly', payday: { dayOfMonth: [20, 5] }, ifBankClosed: 'before' };
const days = (span: { start: number; lastDay: number }) => [ymd(span.start), ymd(span.lastDay)];

describe('the ways hours can be shown', () => {
  it('offers pay periods only when the company has set them', () => {
    expect(viewsFor(TWICE_A_MONTH)).toEqual(['period', 'week', 'month']);
    expect(viewsFor(null)).toEqual(['week', 'month']);
  });
});

describe('spanOf', () => {
  const options = { pay: TWICE_A_MONTH, weekStartsOn: 0 };

  it('finds the pay period, with its pay date', () => {
    const span = spanOf('period', d(2026, 11, 18), options);
    expect(days(span)).toEqual(['2026-11-16', '2026-11-30']);
    expect(ymd(span.payDate!)).toBe('2026-12-04');
  });

  it('finds the workweek from the day it starts on', () => {
    expect(days(spanOf('week', d(2026, 11, 18), options))).toEqual(['2026-11-15', '2026-11-21']);
    expect(days(spanOf('week', d(2026, 11, 18), { ...options, weekStartsOn: 1 }))).toEqual(['2026-11-16', '2026-11-22']);
  });

  it('finds the calendar month, with no pay date', () => {
    const span = spanOf('month', d(2026, 11, 18), options);
    expect(days(span)).toEqual(['2026-11-01', '2026-11-30']);
    expect(span.payDate).toBeUndefined();
  });

  it('falls back to the workweek when a pay period is asked for and the company has none', () => {
    expect(spanOf('period', d(2026, 11, 18), { pay: null, weekStartsOn: 0 }).kind).toBe('week');
  });
});

describe('stepSpan', () => {
  const options = { pay: TWICE_A_MONTH, weekStartsOn: 0 };

  it('steps each kind forward and back', () => {
    const period = spanOf('period', d(2026, 11, 18), options);
    expect(days(stepSpan(period, 1, options))).toEqual(['2026-12-01', '2026-12-15']);
    const week = spanOf('week', d(2026, 11, 18), options);
    expect(days(stepSpan(week, -1, options))).toEqual(['2026-11-08', '2026-11-14']);
    const month = spanOf('month', d(2026, 12, 18), options);
    expect(days(stepSpan(month, 1, options))).toEqual(['2027-01-01', '2027-01-31']);
  });
});

describe('isCurrentSpan', () => {
  it('is true for the span that holds now, and for one after it', () => {
    const options = { pay: TWICE_A_MONTH, weekStartsOn: 0 };
    const now = d(2026, 11, 18);
    expect(isCurrentSpan(spanOf('month', now, options), now, options)).toBe(true);
    expect(isCurrentSpan(spanOf('month', d(2026, 10, 2), options), now, options)).toBe(false);
  });
});

describe('spanLabel', () => {
  it('names a month by its name and anything else by its days', () => {
    const options = { pay: TWICE_A_MONTH, weekStartsOn: 0 };
    expect(spanLabel(spanOf('month', d(2026, 11, 18), options))).toBe('November 2026');
    expect(spanLabel(spanOf('week', d(2026, 11, 18), options))).toBe('Nov 15 – Nov 21');
  });
});
