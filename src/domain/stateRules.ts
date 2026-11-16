import { HOUR, MIN } from '../util/format';
import { CA_RULES, FEDERAL_RULES, type MealRules, type TimeRules } from './time';

/**
 * The hours rules for the state a company is in.
 *
 * Every state, and the District of Columbia, was checked on 16 November 2026
 * against its own statute, rule or labor department, and the finding checked
 * again independently. A state listed here has overtime or meal-period rules of
 * its own beyond federal law; every other state works under federal law (the
 * FLSA): time-and-a-half past 40 hours in a workweek, nothing by the day, and no
 * meal period required.
 *
 * How a state's meal law is read into MealRules:
 *   owedAfterMs  the length of shift on which the meal is owed (no lunch on a
 *                longer one is flagged)
 *   startByMs    only where the law sets a time the meal must start by, counted
 *                from clock-in; it drives the countdown, the reminders and the
 *                late-lunch flag. Where the law sets only a window that depends
 *                on how long the shift will be, there is none.
 *   minMs        the shortest meal the law accepts; a lunch in the app is 30
 *                minutes everywhere
 *   secondAfterMs where the law owes a second meal on a long shift
 * The rules are a field aid for review, not legal advice: flags are never paid
 * or docked automatically, and a collective bargaining agreement or a written
 * agreement can change several of them.
 */

const meal = (owedAfterHours: number, startByHours: number | null, minMinutes: number | null, secondAfterHours: number | null = null): MealRules => ({
  owedAfterMs: owedAfterHours * HOUR,
  startByMs: startByHours == null ? null : startByHours * HOUR,
  minMs: minMinutes == null ? null : minMinutes * MIN,
  waiverMaxMs: null,
  secondAfterMs: secondAfterHours == null ? null : secondAfterHours * HOUR,
});

/** A state that follows federal overtime and has a meal law of its own. */
const withMeal = (name: string, rules: MealRules, note?: string): TimeRules => ({ ...FEDERAL_RULES, name, meal: rules, ...(note ? { note } : {}) });

const STATE_RULES: Record<string, TimeRules> = {
  // AS 23.10.060: 1.5x past 8 hours a day and past 40 a week; daily overtime is not counted again toward the 40.
  AK: { ...FEDERAL_RULES, name: 'Alaska', dailyOvertimeAfter: 800 },
  // Labor Code 510 and 512, IWC Wage Order 16.
  CA: CA_RULES,
  // COMPS Order #40 (7 CCR 1103-1), rules 4.1.1 and 5.1: 1.5x past 12 hours a day or 40 a week;
  // a 30-minute meal when a shift exceeds 5 hours, placed where practical, with no fixed latest start.
  CO: { ...FEDERAL_RULES, name: 'Colorado', dailyOvertimeAfter: 1200, meal: meal(5, null, 30) },
  // Conn. Gen. Stat. 31-51ii: 30 minutes on 7.5 or more consecutive hours, after the first 2 and before the last 2.
  CT: withMeal('Connecticut', meal(7.5, null, 30)),
  // 19 Del. C. 707: 30 minutes on 7.5 or more consecutive hours, after the first 2 and before the last 2.
  DE: withMeal('Delaware', meal(7.5, null, 30)),
  // 820 ILCS 140/3: 20 minutes on 7.5 continuous hours, beginning no later than 5 hours in;
  // another 20 for every further 4.5 hours.
  IL: withMeal('Illinois', meal(7.5, 5, 20, 12)),
  // KRS 337.355: a reasonable lunch period, no sooner than the 3rd nor later than the 5th hour of the shift.
  // KRS 337.050(1): time and a half for the time worked on the seventh day of a seven-day workweek.
  KY: { ...withMeal('Kentucky', meal(5, 5, null)), seventhDay: { doubleAfter: null } },
  // M.G.L. c.149 s.100: no one works more than 6 hours in a day without a 30-minute interval for a meal.
  MA: withMeal('Massachusetts', meal(6, 6, 30)),
  // 26 MRSA 601: no more than 6 consecutive hours without the opportunity of 30 consecutive minutes.
  ME: withMeal('Maine', meal(6, 6, 30)),
  // Minn. Stat. 177.254 as amended from 1 January 2026: 30 minutes on 6 or more consecutive hours.
  MN: withMeal('Minnesota', meal(6, null, 30)),
  // N.D. Admin. Code 46-02-07-02(5): 30 minutes in each shift over 5 hours with two or more on duty.
  ND: withMeal('North Dakota', meal(5, null, 30)),
  // Neb. Rev. Stat. 48-212: 30 consecutive minutes for lunch in each eight-hour shift, but only in an
  // assembling plant, workshop or mechanical establishment; nothing settles whether that reaches a mine.
  NE: {
    ...FEDERAL_RULES,
    name: 'Nebraska',
    note: 'Nebraska owes 30 minutes for lunch in each eight-hour shift in an assembling plant, workshop or mechanical establishment. Whether that reaches a mine is not settled, so the app does not apply it.',
  },
  // RSA 275:30-a: no more than 5 consecutive hours without a half-hour lunch or eating period.
  NH: withMeal('New Hampshire', meal(5, 5, 30)),
  // NRS 608.019: a 30-minute meal within a continuous 8 hours. NRS 608.018's daily overtime past 8 hours
  // covers only those paid under 1.5 times the minimum wage, which the app cannot know.
  NV: withMeal(
    'Nevada',
    meal(8, 8, 30),
    'Nevada also owes daily overtime past 8 hours to anyone paid less than 1.5 times the minimum wage. The app does not know pay rates, so it does not apply it.',
  ),
  // Labor Law 162: meal windows set by the clock (a noonday meal between 11 a.m. and 2 p.m. on a shift
  // of more than 6 hours that spans it, and a second between 5 and 7 p.m. on a long day).
  NY: withMeal(
    'New York',
    meal(6, null, 30),
    'New York sets its meal windows by the clock: a noonday meal between 11 a.m. and 2 p.m., and another between 5 and 7 p.m. on a long day. The app flags only a shift of 6 hours or more with no lunch.',
  ),
  // OAR 839-020-0050: 30 minutes on a work period of 6 hours or more; past 7 hours it starts after the
  // 3rd hour and ends before the 6th begins (so by 4.5 hours); a second from 14 hours.
  // A manufacturing establishment also owes daily overtime past 10 hours (ORS 653.265); whether a mine's
  // crushing or screening plant is one has not been ruled on.
  OR: withMeal(
    'Oregon',
    meal(6, 4.5, 30, 14),
    'Oregon owes daily overtime past 10 hours in a manufacturing establishment. Whether a mine’s crushing or screening plant counts is not settled, so the app does not apply it.',
  ),
  // R.I. Gen. Laws 28-3-14: 20 minutes within a 6-hour shift, 30 within an 8-hour shift.
  // R.I. Gen. Laws 25-3-3: time and a half for Sunday and holiday work in many businesses, with exceptions not all confirmed.
  RI: withMeal(
    'Rhode Island',
    meal(6, null, 20),
    'Rhode Island owes 30 minutes, not 20, within an 8-hour shift. Many businesses there also pay time and a half for Sunday and holiday work; the app does not apply that.',
  ),
  // Fla. Stat. 448.01: extra pay past 10 hours a day for manual labor unless a written contract sets other hours; no rate.
  FL: {
    ...FEDERAL_RULES,
    name: 'Florida',
    note: 'Florida law gives manual laborers extra pay for work past 10 hours a day unless a written contract sets other hours. It sets no rate, so the app does not apply it.',
  },
  // Tenn. Code Ann. 50-2-103(h): a 30-minute unpaid break if scheduled to work 6 hours consecutively.
  TN: withMeal('Tennessee', meal(6, null, 30)),
  // 21 V.S.A. 304: reasonable opportunities to eat, with no length or time set.
  VT: { ...FEDERAL_RULES, name: 'Vermont', note: 'Vermont requires reasonable opportunities to eat during work, but sets no meal period, so the app sets no meal rule.' },
  // WAC 296-126-092: 30 minutes starting between the 2nd and the 5th hour on a shift over 5 hours,
  // and no more than 5 consecutive hours without one, so a second on a long shift.
  WA: withMeal('Washington', meal(5, 5, 30, 10)),
  // W. Va. Code 21-3-10a: at least 20 minutes during a workday of 6 or more hours, at times the employer sets.
  WV: withMeal('West Virginia', meal(6, null, 20)),
};

export function rulesFor(state: string): TimeRules {
  return STATE_RULES[state] ?? FEDERAL_RULES;
}
