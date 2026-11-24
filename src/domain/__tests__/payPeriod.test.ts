import { ymd } from '../../util/format';
import {
  bankHolidays,
  checkPaySchedule,
  describePaySchedule,
  monthOf,
  nextMonth,
  nextPayday,
  nextPayPeriod,
  ordinal,
  payPeriodOf,
  previousMonth,
  previousPayPeriod,
  type PaySchedule,
} from '../payPeriod';

const d = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();

/** The 1st to the 15th paid on the 20th, the 16th to the end paid on the 5th, moved back off a closed bank. */
const TWICE_A_MONTH: PaySchedule = { frequency: 'semimonthly', payday: { dayOfMonth: [20, 5] }, ifBankClosed: 'before' };

/** [first day, last day, pay date] of the period that contains the given date. */
const dates = (year: number, month: number, day: number, schedule: PaySchedule = TWICE_A_MONTH) => {
  const p = payPeriodOf(d(year, month, day), schedule);
  return [ymd(p.start), ymd(p.lastDay), ymd(p.payDate)];
};

describe('twice a month, paid the 20th and the 5th', () => {
  it('runs the 16th to the end of the month and pays on the 5th', () => {
    expect(dates(2026, 10, 20)).toEqual(['2026-10-16', '2026-10-31', '2026-11-05']);
    expect(dates(2026, 10, 16)).toEqual(['2026-10-16', '2026-10-31', '2026-11-05']);
    expect(dates(2026, 10, 31)).toEqual(['2026-10-16', '2026-10-31', '2026-11-05']);
  });

  it('runs the 1st to the 15th and pays on the 20th', () => {
    expect(dates(2026, 11, 1)).toEqual(['2026-11-01', '2026-11-15', '2026-11-20']);
    expect(dates(2026, 11, 15)).toEqual(['2026-11-01', '2026-11-15', '2026-11-20']);
  });

  it('ends on the real last day of a short month and of a leap February', () => {
    expect(dates(2026, 2, 20)).toEqual(['2026-02-16', '2026-02-28', '2026-03-05']);
    expect(dates(2028, 2, 29).slice(0, 2)).toEqual(['2028-02-16', '2028-02-29']);
  });

  it('rolls over the year: the second half of December is paid on January 5th', () => {
    expect(dates(2026, 12, 31)).toEqual(['2026-12-16', '2026-12-31', '2027-01-05']);
  });

  it('counts the whole last day as part of the period', () => {
    const p = payPeriodOf(d(2026, 10, 31, 23), TWICE_A_MONTH);
    expect(ymd(p.start)).toBe('2026-10-16');
    expect(d(2026, 10, 31, 23)).toBeLessThan(p.end);
    expect(ymd(p.end)).toBe('2026-11-01');
  });

  it('steps to the next and the previous period', () => {
    const p = payPeriodOf(d(2026, 11, 3), TWICE_A_MONTH);
    expect(ymd(nextPayPeriod(p, TWICE_A_MONTH).start)).toBe('2026-11-16');
    expect(ymd(previousPayPeriod(p, TWICE_A_MONTH).start)).toBe('2026-10-16');
    expect(ymd(previousPayPeriod(payPeriodOf(d(2027, 1, 4), TWICE_A_MONTH), TWICE_A_MONTH).start)).toBe('2026-12-16');
  });

  it('pays both halves on one day of the month when only one is given', () => {
    const one: PaySchedule = { ...TWICE_A_MONTH, payday: { dayOfMonth: [25] } };
    expect(dates(2026, 10, 3, one)).toEqual(['2026-10-01', '2026-10-15', '2026-10-23']); // the 25th is a Sunday
    expect(dates(2026, 10, 20, one)).toEqual(['2026-10-16', '2026-10-31', '2026-11-25']);
  });
});

describe('every week and every two weeks', () => {
  const WEEKLY: PaySchedule = { frequency: 'weekly', firstDay: '2026-11-01', payday: { daysAfter: 6 }, ifBankClosed: 'before' };
  const BIWEEKLY: PaySchedule = { frequency: 'biweekly', firstDay: '2026-11-01', payday: { daysAfter: 6 }, ifBankClosed: 'before' };

  it('runs seven days from the first day given, and pays the Friday after a Sunday-to-Saturday week', () => {
    expect(dates(2026, 11, 4, WEEKLY)).toEqual(['2026-11-01', '2026-11-07', '2026-11-13']);
    expect(dates(2026, 11, 8, WEEKLY)).toEqual(['2026-11-08', '2026-11-14', '2026-11-20']);
  });

  it('runs fourteen days for every two weeks, before the first day given as well as after it', () => {
    expect(dates(2026, 11, 14, BIWEEKLY)).toEqual(['2026-11-01', '2026-11-14', '2026-11-20']);
    expect(dates(2026, 11, 15, BIWEEKLY)).toEqual(['2026-11-15', '2026-11-28', '2026-12-04']);
    expect(dates(2026, 10, 31, BIWEEKLY)).toEqual(['2026-10-18', '2026-10-31', '2026-11-06']);
  });

  it('keeps whole calendar days across a change of the clocks', () => {
    // US clocks go back on Sunday, November 1 2026, and forward on Sunday, March 14 2027.
    expect(dates(2027, 3, 16, BIWEEKLY)).toEqual(['2027-03-07', '2027-03-20', '2027-03-26']);
  });

  it('steps a week or two weeks at a time', () => {
    const p = payPeriodOf(d(2026, 11, 4), BIWEEKLY);
    expect(ymd(nextPayPeriod(p, BIWEEKLY).start)).toBe('2026-11-15');
    expect(ymd(previousPayPeriod(p, BIWEEKLY).start)).toBe('2026-10-18');
  });
});

describe('once a month', () => {
  it('runs the 1st to the last day and pays on the next given day of the month', () => {
    const monthly: PaySchedule = { frequency: 'monthly', payday: { dayOfMonth: [5] }, ifBankClosed: 'before' };
    expect(dates(2026, 10, 9, monthly)).toEqual(['2026-10-01', '2026-10-31', '2026-11-05']);
  });

  it('pays on the last day of a short month when the day asked for is past its end', () => {
    const lastDay: PaySchedule = { frequency: 'monthly', payday: { dayOfMonth: [31] }, ifBankClosed: 'stay' };
    expect(dates(2026, 9, 9, lastDay)).toEqual(['2026-09-01', '2026-09-30', '2026-09-30']);
    expect(dates(2026, 10, 9, lastDay)).toEqual(['2026-10-01', '2026-10-31', '2026-10-31']);
  });

  it('pays so many days after the last day', () => {
    const after: PaySchedule = { frequency: 'monthly', payday: { daysAfter: 10 }, ifBankClosed: 'before' };
    expect(dates(2026, 4, 9, after)).toEqual(['2026-04-01', '2026-04-30', '2026-05-08']); // the 10th is a Sunday
  });
});

describe('pay dates that land on a day the bank is closed', () => {
  it('moves a Saturday pay date to the Friday before', () => {
    const p = payPeriodOf(d(2026, 11, 20), TWICE_A_MONTH); // Nov 16-30, scheduled Sat Dec 5
    expect([ymd(p.scheduledPayDate), ymd(p.payDate)]).toEqual(['2026-12-05', '2026-12-04']);
    expect(p.movedBecause).toBe('The 5th is a Saturday');
  });

  it('moves a Sunday pay date to the Friday before', () => {
    const p = payPeriodOf(d(2026, 12, 3), TWICE_A_MONTH); // Dec 1-15, scheduled Sun Dec 20
    expect(ymd(p.payDate)).toBe('2026-12-18');
    expect(p.movedBecause).toMatch(/Sunday/);
  });

  it('moves a pay date off a bank holiday', () => {
    const mlk = payPeriodOf(d(2025, 1, 10), TWICE_A_MONTH); // scheduled Mon Jan 20 2025, Martin Luther King Jr. Day
    expect(ymd(mlk.payDate)).toBe('2025-01-17');
    expect(mlk.movedBecause).toMatch(/Martin Luther King/);
    const labor = payPeriodOf(d(2022, 8, 20), TWICE_A_MONTH); // scheduled Mon Sep 5 2022, Labor Day
    expect(ymd(labor.payDate)).toBe('2022-09-02');
  });

  it('treats the Monday after a Sunday holiday as closed too', () => {
    // July 4 2027 is a Sunday, so banks close Monday July 5.
    expect(ymd(payPeriodOf(d(2027, 6, 20), TWICE_A_MONTH).payDate)).toBe('2027-07-02');
  });

  it('leaves a weekday pay date alone', () => {
    const p = payPeriodOf(d(2026, 10, 20), TWICE_A_MONTH); // scheduled Thu Nov 5
    expect([ymd(p.scheduledPayDate), ymd(p.payDate)]).toEqual(['2026-11-05', '2026-11-05']);
    expect(p.movedBecause).toBeUndefined();
  });

  it('moves the pay date to the next banking day when the company pays after', () => {
    const after: PaySchedule = { ...TWICE_A_MONTH, ifBankClosed: 'after' };
    const p = payPeriodOf(d(2026, 11, 20), after); // scheduled Sat Dec 5
    expect(ymd(p.payDate)).toBe('2026-12-07');
    expect(p.movedBecause).toBe('The 5th is a Saturday');
  });

  it('keeps the pay date where it is when the company says so', () => {
    const stay: PaySchedule = { ...TWICE_A_MONTH, ifBankClosed: 'stay' };
    const p = payPeriodOf(d(2026, 11, 20), stay);
    expect(ymd(p.payDate)).toBe('2026-12-05');
    expect(p.movedBecause).toBeUndefined();
  });

  it('names the day with the right ending', () => {
    const first: PaySchedule = { frequency: 'monthly', payday: { dayOfMonth: [1] }, ifBankClosed: 'before' };
    expect(payPeriodOf(d(2026, 10, 9), first).movedBecause).toBe('The 1st is a Sunday'); // Nov 1 2026
    const third: PaySchedule = { frequency: 'monthly', payday: { dayOfMonth: [3] }, ifBankClosed: 'before' };
    expect(payPeriodOf(d(2026, 9, 9), third).movedBecause).toBe('The 3rd is a Saturday'); // Oct 3 2026
  });
});

describe('ordinal', () => {
  it('writes 1st, 2nd, 3rd, 4th and the teens', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st',
    ]);
  });
});

describe('bank holidays', () => {
  it('lists the 2026 holidays on the right dates', () => {
    expect([...bankHolidays(2026).keys()].sort()).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-04',
      '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
    ]);
  });
});

describe('nextPayday', () => {
  it('is the 5th while last period is still waiting to be paid', () => {
    const next = nextPayday(d(2026, 11, 3), TWICE_A_MONTH);
    expect([ymd(next.payDate), ymd(next.period.start)]).toEqual(['2026-11-05', '2026-10-16']);
  });
  it('still shows today on payday itself', () => {
    expect(ymd(nextPayday(d(2026, 11, 5, 18), TWICE_A_MONTH).payDate)).toBe('2026-11-05');
  });
  it('moves on to the 20th the day after', () => {
    const next = nextPayday(d(2026, 11, 6), TWICE_A_MONTH);
    expect([ymd(next.payDate), ymd(next.period.start)]).toEqual(['2026-11-20', '2026-11-01']);
  });
  it('follows a moved pay date', () => {
    expect(ymd(nextPayday(d(2026, 12, 4), TWICE_A_MONTH).payDate)).toBe('2026-12-04');
    expect(ymd(nextPayday(d(2026, 12, 5), TWICE_A_MONTH).payDate)).toBe('2026-12-18');
  });
  it('finds a payday that falls two periods on, as one paid long after it ends can', () => {
    const late: PaySchedule = { frequency: 'weekly', firstDay: '2026-11-01', payday: { daysAfter: 13 }, ifBankClosed: 'stay' };
    // Nov 1-7 is paid Fri Nov 20, Nov 8-14 on Fri Nov 27.
    const next = nextPayday(d(2026, 11, 18), late);
    expect([ymd(next.payDate), ymd(next.period.start)]).toEqual(['2026-11-20', '2026-11-01']);
  });
});

describe('describePaySchedule', () => {
  it('says the schedule in a sentence', () => {
    expect(describePaySchedule(TWICE_A_MONTH)).toBe(
      'Twice a month: the 1st to the 15th is paid on the 20th, the 16th to the end of the month on the 5th. A pay date the bank is closed moves to the banking day before.',
    );
    expect(
      describePaySchedule({ frequency: 'biweekly', firstDay: '2026-11-01', payday: { daysAfter: 6 }, ifBankClosed: 'stay' }),
    ).toBe('Every two weeks, from Sunday to Saturday: paid 6 days after the last day.');
    expect(describePaySchedule({ frequency: 'monthly', payday: { daysAfter: 0 }, ifBankClosed: 'after' })).toBe(
      'Once a month: paid on the last day. A pay date the bank is closed moves to the banking day after.',
    );
    expect(describePaySchedule({ frequency: 'weekly', firstDay: '2026-11-02', payday: { daysAfter: 1 }, ifBankClosed: 'stay' })).toBe(
      'Every week, from Monday to Sunday: paid 1 day after the last day.',
    );
  });
});

describe('checkPaySchedule', () => {
  it('passes a whole schedule', () => {
    expect(checkPaySchedule(TWICE_A_MONTH)).toBeUndefined();
    expect(checkPaySchedule({ frequency: 'weekly', firstDay: '2026-11-01', payday: { daysAfter: 6 }, ifBankClosed: 'before' })).toBeUndefined();
  });

  it('turns back one that cannot be worked out', () => {
    expect(checkPaySchedule({ frequency: 'weekly', payday: { daysAfter: 6 }, ifBankClosed: 'before' })).toMatch(/first day/);
    expect(checkPaySchedule({ frequency: 'weekly', firstDay: '2026-13-01', payday: { daysAfter: 6 }, ifBankClosed: 'before' })).toMatch(/first day/);
    expect(checkPaySchedule({ frequency: 'weekly', firstDay: '2026-11-01', payday: { dayOfMonth: [5] }, ifBankClosed: 'before' })).toMatch(/days after/);
    expect(checkPaySchedule({ ...TWICE_A_MONTH, payday: { dayOfMonth: [0] } })).toMatch(/1 to 31/);
    expect(checkPaySchedule({ ...TWICE_A_MONTH, payday: { dayOfMonth: [20, 5, 9] } })).toMatch(/two/);
    expect(checkPaySchedule({ frequency: 'monthly', payday: { dayOfMonth: [5, 20] }, ifBankClosed: 'before' })).toMatch(/one day/);
    expect(checkPaySchedule({ ...TWICE_A_MONTH, payday: { daysAfter: -1 } })).toMatch(/0 to 60/);
    expect(checkPaySchedule({ ...TWICE_A_MONTH, payday: { daysAfter: 2.5 } })).toMatch(/0 to 60/);
    expect(checkPaySchedule({ ...TWICE_A_MONTH, frequency: 'daily' as never })).toMatch(/how often/);
    expect(checkPaySchedule({ ...TWICE_A_MONTH, ifBankClosed: 'never' as never })).toMatch(/bank/);
  });
});

describe('months', () => {
  it('runs from the 1st to the start of the next month', () => {
    const m = monthOf(d(2026, 2, 14));
    expect([ymd(m.start), ymd(m.lastDay), ymd(m.end)]).toEqual(['2026-02-01', '2026-02-28', '2026-03-01']);
  });
  it('steps across the year', () => {
    expect(ymd(nextMonth(monthOf(d(2026, 12, 9))).start)).toBe('2027-01-01');
    expect(ymd(previousMonth(monthOf(d(2027, 1, 9))).start)).toBe('2026-12-01');
  });
});
