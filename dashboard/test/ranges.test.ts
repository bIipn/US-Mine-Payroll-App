import { describe, expect, it } from 'vitest';

import { addDays, startOfDay } from '@app/util/format';

import { addMonths, parseDay, presetRange, typedRange } from '../src/lib/ranges';

const NOW = new Date(2026, 10, 16, 14, 30).getTime();
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe('presetRange', () => {
  it('ends at the end of today, as the app’s safety log does', () => {
    const tomorrow = addDays(startOfDay(NOW), 1);
    expect(presetRange('today', NOW)).toEqual({ from: startOfDay(NOW), to: tomorrow });
    expect(presetRange('7', NOW)).toEqual({ from: day(2026, 11, 10), to: tomorrow });
    expect(presetRange('365', NOW)).toEqual({ from: day(2025, 11, 17), to: tomorrow });
  });
});

describe('typedRange', () => {
  it('takes both days, the last one included', () => {
    expect(typedRange('2026-11-01', '2026-11-15')).toEqual({ from: day(2026, 11, 1), to: day(2026, 11, 16) });
  });

  it('allows twelve months and not a day more', () => {
    expect(typedRange('2025-11-17', '2026-11-16')).toEqual({ from: day(2025, 11, 17), to: day(2026, 11, 17) });
    expect(typedRange('2025-11-16', '2026-11-16')).toEqual({
      error: 'This covers up to 12 months. Pick a first day no more than 12 months before the last day.',
      field: 'from',
    });
  });

  it('says what is wrong with a range it cannot use', () => {
    expect(typedRange('', '2026-11-16')).toEqual({ error: 'Give the first day as a date.', field: 'from' });
    expect(typedRange('2026-11-16', '2026-02-30')).toEqual({ error: 'Give the last day as a date.', field: 'to' });
    expect(typedRange('2026-11-16', '2026-11-01')).toEqual({ error: 'The last day comes before the first day. Swap them.', field: 'to' });
  });
});

describe('dates', () => {
  it('reads a date as the start of that day here, and steps months to the last day of a shorter one', () => {
    expect(parseDay('2026-02-29')).toBeUndefined();
    expect(parseDay('2028-02-29')).toBe(day(2028, 2, 29));
    expect(addMonths(day(2026, 1, 31), 1)).toBe(day(2026, 2, 28));
    expect(addMonths(day(2026, 3, 8), 12)).toBe(day(2027, 3, 8));
  });
});
