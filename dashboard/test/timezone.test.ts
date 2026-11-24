import { describe, expect, it } from 'vitest';

import { offsetIn, sameClock } from '../src/lib/timezone';

describe('time zones', () => {
  it('reads a zone’s offset at a moment', () => {
    expect(offsetIn('America/Los_Angeles', Date.UTC(2026, 0, 15, 12))).toBe(-480);
    expect(offsetIn('America/Los_Angeles', Date.UTC(2026, 6, 15, 12))).toBe(-420);
    expect(offsetIn('Not/A_Zone', Date.UTC(2026, 0, 15))).toBeUndefined();
  });

  it('counts two names for the same clock as the same, and Arizona apart from Denver', () => {
    expect(sameClock('America/Los_Angeles', 'US/Pacific', 2026)).toBe(true);
    expect(sameClock('America/Denver', 'America/Phoenix', 2026)).toBe(false);
    expect(sameClock('America/Denver', 'America/Boise', 2026)).toBe(true);
  });
});
