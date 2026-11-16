import { HOUR, MIN } from '../../util/format';
import { computeWeek } from '../payroll';
import { rulesFor } from '../stateRules';
import {
  CA_RULES,
  FEDERAL_RULES,
  flagHelp,
  LUNCH_MS,
  mealSummary,
  lunchEndAt,
  mealStatus,
  overtimeSummary,
  reminderPlan,
  shiftFlags,
  startedLunch,
  type TimeRules,
} from '../time';
import type { Shift } from '../types';

// Sunday Nov 8 2026 starts the workweek used in these tests.
const WEEK = new Date(2026, 10, 8).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const NOW = at(30, 12);

/** A closed shift starting at 6:00 and paying exactly `paidHours`, with or without a 30-minute lunch at 10:00. */
function worked(day: number, paidHours: number, lunch = true): Shift {
  return {
    id: `s${day}-${paidHours}`,
    employeeId: 'e1',
    clockIn: { at: at(day, 6) },
    clockOut: { at: at(day, 6) + paidHours * HOUR + (lunch ? 30 * MIN : 0) },
    lunches: lunch ? [{ start: { at: at(day, 10) }, end: { at: at(day, 10, 30) } }] : [],
    breaks: [],
  };
}
const split = (day: { reg: number; ot: number; dt: number }) => [day.reg / 100, day.ot / 100, day.dt / 100];

/** Daily overtime past 8 hours and no double time, with no meal law: the shape of a state like Alaska. */
const DAILY_EIGHT: TimeRules = { ...FEDERAL_RULES, name: 'Daily eight', dailyOvertimeAfter: 800 };
/** A meal owed on a shift of 7.5 hours or more, with no time it must start by. */
const LONG_SHIFT_MEAL: TimeRules = {
  ...FEDERAL_RULES,
  name: 'Long-shift meal',
  meal: { owedAfterMs: 7.5 * HOUR, startByMs: null, minMs: 30 * MIN, waiverMaxMs: null, secondAfterMs: null },
};

describe('rulesFor', () => {
  it('gives California its own rules', () => {
    expect(rulesFor('CA')).toBe(CA_RULES);
  });

  it('falls back to federal law when no state is set', () => {
    expect(rulesFor('')).toBe(FEDERAL_RULES);
  });

  it('gives federal law in a state with no overtime or meal rules of its own', () => {
    expect(rulesFor('TX')).toBe(FEDERAL_RULES);
  });
});

describe('federal law: overtime past 40 hours a week, nothing by the day', () => {
  it('pays a long day as straight time while the week stays under 40', () => {
    const week = computeWeek([worked(9, 12), worked(10, 13.5)], WEEK, NOW, FEDERAL_RULES);
    expect(split(week.days[1])).toEqual([12, 0, 0]);
    expect(split(week.days[2])).toEqual([13.5, 0, 0]);
  });

  it('pays the hours past 40 in the workweek as overtime, and never double time', () => {
    const week = computeWeek([9, 10, 11, 12].map((d) => worked(d, 12)), WEEK, NOW, FEDERAL_RULES);
    expect(split(week)).toEqual([40, 8, 0]);
  });

  it('has no seventh-day premium', () => {
    const week = computeWeek([8, 9, 10, 11, 12, 13, 14].map((d) => worked(d, 5, false)), WEEK, NOW, FEDERAL_RULES);
    expect(split(week.days[6])).toEqual([5, 0, 0]);
  });

  it('flags no lunch, since no meal period is required', () => {
    expect(shiftFlags(worked(9, 11, false), NOW, FEDERAL_RULES)).toEqual([]);
  });

  it('sets no lunch deadline and sends no lunch-deadline reminders', () => {
    const open: Shift = { ...worked(9, 3, false), clockOut: undefined };
    const meal = mealStatus(open, at(9, 10), FEDERAL_RULES);
    expect(meal.deadlineAt).toBeNull();
    expect(meal.state).toBe('not_due');
    expect(mealStatus(open, at(9, 14), FEDERAL_RULES).state).toBe('not_due');
    expect(reminderPlan(open, true, at(9, 7), FEDERAL_RULES).schedule).toEqual([]);
  });

  it('still tells the person when a lunch they took is over', () => {
    const lunching: Shift = { ...worked(9, 3, false), clockOut: undefined, lunches: [startedLunch({ at: at(9, 10) })] };
    expect(reminderPlan(lunching, true, at(9, 10, 5), FEDERAL_RULES).schedule.map((r) => r.id)).toEqual(['lunch-end']);
  });
});

describe('daily overtime with no double time', () => {
  it('pays past 8 a day as overtime, all the way up', () => {
    const week = computeWeek([worked(9, 13.5)], WEEK, NOW, DAILY_EIGHT);
    expect(split(week.days[1])).toEqual([8, 5.5, 0]);
  });

  it('does not count daily overtime again toward the 40', () => {
    const week = computeWeek([9, 10, 11, 12, 13].map((d) => worked(d, 10)), WEEK, NOW, DAILY_EIGHT);
    expect(split(week)).toEqual([40, 10, 0]);
  });
});

describe('a meal owed only on a long shift', () => {
  it('flags no lunch on a shift of 7.5 hours or more, and not on a shorter one', () => {
    expect(shiftFlags(worked(9, 8, false), NOW, LONG_SHIFT_MEAL)).toContain('no_lunch');
    expect(shiftFlags(worked(9, 7, false), NOW, LONG_SHIFT_MEAL)).not.toContain('no_lunch');
  });

  it('never calls a lunch late when the law sets no time to start it by', () => {
    const shift: Shift = { ...worked(9, 9), lunches: [{ start: { at: at(9, 13) }, end: { at: at(9, 13, 30) } }] };
    expect(shiftFlags(shift, NOW, LONG_SHIFT_MEAL)).not.toContain('late_lunch');
  });

  it('counts down to nothing', () => {
    const open: Shift = { ...worked(9, 3, false), clockOut: undefined };
    expect(mealStatus(open, at(9, 8), LONG_SHIFT_MEAL).deadlineAt).toBeNull();
  });
});

describe('California, unchanged', () => {
  it('still counts down to the end of the fifth hour', () => {
    const open: Shift = { ...worked(9, 3, false), clockOut: undefined };
    expect(mealStatus(open, at(9, 8), CA_RULES).deadlineAt).toBe(at(9, 11));
  });
});

describe('a lunch is 30 minutes in every state', () => {
  it('ends by itself after 30 minutes, whatever the state’s shortest meal period', () => {
    expect(LUNCH_MS).toBe(30 * MIN);
    const lunch = startedLunch({ at: at(9, 10) });
    expect(lunchEndAt(lunch)).toBe(at(9, 10, 30));
  });
});

describe('the rules in words', () => {
  it('says how overtime is figured under each', () => {
    expect(overtimeSummary(CA_RULES)).toBe(
      'Overtime follows California rules: over 8 hours a day or 40 straight-time hours in a workweek is OT, over 12 a day is DT, with the seventh-day rule.',
    );
    expect(overtimeSummary(FEDERAL_RULES)).toBe('Overtime follows federal law (FLSA): over 40 hours in a workweek is OT. There is no daily overtime.');
    expect(overtimeSummary(DAILY_EIGHT)).toBe('Overtime follows Daily eight rules: over 8 hours a day or 40 straight-time hours in a workweek is OT.');
  });

  it('says when a meal period is owed under each', () => {
    expect(mealSummary(CA_RULES)).toBe('A 30-minute meal period has to start before the end of the fifth hour of work, and a second is owed past 10 hours.');
    expect(mealSummary(FEDERAL_RULES)).toBe('No meal period is required by law. A lunch taken is 30 minutes, unpaid.');
    expect(mealSummary(LONG_SHIFT_MEAL)).toBe('A 30-minute meal period is owed on a shift of 7.5 hours or more.');
  });

  it('explains a lunch flag by the state’s own times', () => {
    expect(flagHelp('late_lunch', CA_RULES)).toBe('Lunch started after the end of the fifth hour of work.');
    expect(flagHelp('no_lunch', CA_RULES)).toBe('Worked 5 hours or more with no lunch on record.');
    expect(flagHelp('no_lunch', LONG_SHIFT_MEAL)).toBe('Worked 7.5 hours or more with no lunch on record.');
    expect(flagHelp('second_meal', CA_RULES)).toBe('More than 10 hours worked with only one meal period.');
    expect(flagHelp('missing_out', FEDERAL_RULES)).toBe('The shift was never clocked out. A supervisor needs to set the end time.');
  });
});
