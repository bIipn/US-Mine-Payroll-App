import { HOUR, MIN } from '../../util/format';
import { STATES } from '../company';
import { computeWeek } from '../payroll';
import type { Shift } from '../types';
import { rulesFor } from '../stateRules';
import { CA_RULES, FEDERAL_RULES, mealSummary, overtimeSummary } from '../time';

describe('the hours rules of each state', () => {
  it('has rules for every state, its own or federal law', () => {
    for (const code of Object.keys(STATES)) {
      const rules = rulesFor(code);
      expect(rules.weeklyOvertimeAfter).toBe(4000);
      if (rules.meal) {
        expect(rules.meal.owedAfterMs).toBeGreaterThan(0);
        if (rules.meal.startByMs != null) expect(rules.meal.startByMs).toBeLessThanOrEqual(8 * HOUR);
      }
    }
  });

  it('keeps California as it was', () => {
    expect(rulesFor('CA')).toBe(CA_RULES);
  });

  it('pays daily overtime past 8 hours in Alaska, and past 12 in Colorado, with no double time', () => {
    expect([rulesFor('AK').dailyOvertimeAfter, rulesFor('AK').dailyDoubleAfter]).toEqual([800, null]);
    expect([rulesFor('CO').dailyOvertimeAfter, rulesFor('CO').dailyDoubleAfter]).toEqual([1200, null]);
  });

  it('gives the seventh-day rule to California and Kentucky only', () => {
    expect(Object.keys(STATES).filter((code) => rulesFor(code).seventhDay)).toEqual(['CA', 'KY']);
  });

  it('pays every hour of a seventh straight day as overtime in Kentucky, with no double time', () => {
    // Sunday Nov 8 2026 starts the workweek; seven 6-hour days, no lunch.
    const day = (d: number): Shift => ({
      id: `s${d}`, employeeId: 'e1', clockIn: { at: new Date(2026, 10, d, 6).getTime() },
      clockOut: { at: new Date(2026, 10, d, 16).getTime() }, lunches: [], breaks: [],
    });
    const week = computeWeek([8, 9, 10, 11, 12, 13, 14].map(day), new Date(2026, 10, 8).getTime(), new Date(2026, 10, 30).getTime(), rulesFor('KY'));
    const seventh = week.days[6];
    expect([seventh.reg, seventh.ot, seventh.dt]).toEqual([0, 1000, 0]);
    // The six days before: 60 hours, of which 40 straight and 20 overtime. The seventh is all overtime.
    expect([week.reg, week.ot, week.dt]).toEqual([4000, 3000, 0]);
  });

  it('owes a meal on a long shift with no time it must start by, where the law sets none', () => {
    expect(rulesFor('CO').meal).toMatchObject({ owedAfterMs: 5 * HOUR, startByMs: null, minMs: 30 * MIN });
    expect(rulesFor('CT').meal).toMatchObject({ owedAfterMs: 7.5 * HOUR, startByMs: null });
    expect(rulesFor('DE').meal).toMatchObject({ owedAfterMs: 7.5 * HOUR, startByMs: null });
    expect(rulesFor('MN').meal).toMatchObject({ owedAfterMs: 6 * HOUR, startByMs: null });
    expect(rulesFor('WV').meal).toMatchObject({ owedAfterMs: 6 * HOUR, startByMs: null, minMs: 20 * MIN });
  });

  it('counts down where the law sets the time a meal must start by', () => {
    expect(rulesFor('IL').meal).toMatchObject({ owedAfterMs: 7.5 * HOUR, startByMs: 5 * HOUR, minMs: 20 * MIN, secondAfterMs: 12 * HOUR });
    expect(rulesFor('OR').meal).toMatchObject({ owedAfterMs: 6 * HOUR, startByMs: 4.5 * HOUR, secondAfterMs: 14 * HOUR });
    expect(rulesFor('WA').meal).toMatchObject({ owedAfterMs: 5 * HOUR, startByMs: 5 * HOUR });
    expect(rulesFor('NV').meal).toMatchObject({ owedAfterMs: 8 * HOUR, startByMs: 8 * HOUR });
    expect(rulesFor('KY').meal).toMatchObject({ startByMs: 5 * HOUR, minMs: null });
  });

  it('does not apply Nebraska\'s lunch law, which may not reach a mine, and says so', () => {
    expect(rulesFor('NE').meal).toBeNull();
    expect(rulesFor('NE').note).toMatch(/mine/);
  });

  it('works under federal law in a state with no rules of its own, and in Vermont, which sets no meal period to count', () => {
    expect(rulesFor('TX')).toBe(FEDERAL_RULES);
    expect(rulesFor('VT').meal).toBeNull();
    expect(rulesFor('VT').dailyOvertimeAfter).toBeNull();
  });

  it('says what the app cannot apply, where a state rule depends on something it does not know', () => {
    expect(rulesFor('NV').dailyOvertimeAfter).toBeNull();
    expect(rulesFor('NV').note).toMatch(/1\.5 times the minimum wage/);
    expect(rulesFor('NY').note).toMatch(/by the clock/);
    expect(rulesFor('VT').note).toMatch(/reasonable opportunit/);
    expect(rulesFor('RI').note).toMatch(/Sunday/);
    expect(rulesFor('OR').note).toMatch(/10 hours/);
    expect(rulesFor('FL').note).toMatch(/10 hours/);
    expect(rulesFor('TX').note).toBeUndefined();
  });

  it('puts each state in two plain sentences', () => {
    expect(overtimeSummary(rulesFor('AK'))).toBe('Overtime follows Alaska rules: over 8 hours a day or 40 straight-time hours in a workweek is OT.');
    expect(mealSummary(rulesFor('CO'))).toBe('A 30-minute meal period is owed on a shift of 5 hours or more.');
    expect(mealSummary(rulesFor('IL'))).toBe('A 20-minute meal period has to start before the end of the fifth hour of work, and a second is owed past 12 hours.');
    expect(mealSummary(rulesFor('OR'))).toBe('A 30-minute meal period has to start before 4.5 hours of work, and a second is owed past 14 hours.');
    expect(mealSummary(rulesFor('KY'))).toBe('A lunch period has to start before the end of the fifth hour of work.');
    expect(overtimeSummary(rulesFor('KY'))).toBe('Overtime follows Kentucky rules: over 40 hours in a workweek is OT, and every hour of a seventh day worked in the workweek. There is no daily overtime.');
    expect(overtimeSummary(rulesFor('CA'))).toBe('Overtime follows California rules: over 8 hours a day or 40 straight-time hours in a workweek is OT, over 12 a day is DT, with the seventh-day rule.');
  });
});
