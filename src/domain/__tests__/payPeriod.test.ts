import { ymd } from '../../util/format';
import { bankHolidays, nextPayday, nextPayPeriod, payPeriodOf, previousPayPeriod } from '../payPeriod';

const d = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();
/** [first day, last day, pay date] of the period that contains the given date. */
const dates = (year: number, month: number, day: number) => {
  const p = payPeriodOf(d(year, month, day));
  return [ymd(p.start), ymd(p.lastDay), ymd(p.payDate)];
};

describe('pay periods', () => {
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
    const p = payPeriodOf(d(2026, 10, 31, 23));
    expect(ymd(p.start)).toBe('2026-10-16');
    expect(d(2026, 10, 31, 23)).toBeLessThan(p.end);
    expect(ymd(p.end)).toBe('2026-11-01');
  });

  it('steps to the next and the previous period', () => {
    const p = payPeriodOf(d(2026, 11, 3));
    expect(ymd(nextPayPeriod(p).start)).toBe('2026-11-16');
    expect(ymd(previousPayPeriod(p).start)).toBe('2026-10-16');
    expect(ymd(previousPayPeriod(payPeriodOf(d(2027, 1, 4))).start)).toBe('2026-12-16');
  });
});

describe('pay dates that land on a day the bank is closed', () => {
  it('moves a Saturday pay date to the Friday before', () => {
    const p = payPeriodOf(d(2026, 11, 20)); // Nov 16-30, scheduled Sat Dec 5
    expect([ymd(p.scheduledPayDate), ymd(p.payDate)]).toEqual(['2026-12-05', '2026-12-04']);
    expect(p.movedBecause).toMatch(/Saturday/);
  });

  it('moves a Sunday pay date to the Friday before', () => {
    const p = payPeriodOf(d(2026, 12, 3)); // Dec 1-15, scheduled Sun Dec 20
    expect(ymd(p.payDate)).toBe('2026-12-18');
    expect(p.movedBecause).toMatch(/Sunday/);
  });

  it('moves a pay date off a bank holiday', () => {
    const mlk = payPeriodOf(d(2025, 1, 10)); // scheduled Mon Jan 20 2025, Martin Luther King Jr. Day
    expect(ymd(mlk.payDate)).toBe('2025-01-17');
    expect(mlk.movedBecause).toMatch(/Martin Luther King/);
    const labor = payPeriodOf(d(2022, 8, 20)); // scheduled Mon Sep 5 2022, Labor Day
    expect(ymd(labor.payDate)).toBe('2022-09-02');
  });

  it('treats the Monday after a Sunday holiday as closed too', () => {
    // July 4 2027 is a Sunday, so banks close Monday July 5.
    expect(ymd(payPeriodOf(d(2027, 6, 20)).payDate)).toBe('2027-07-02');
  });

  it('leaves a weekday pay date alone', () => {
    const p = payPeriodOf(d(2026, 10, 20)); // scheduled Thu Nov 5
    expect([ymd(p.scheduledPayDate), ymd(p.payDate)]).toEqual(['2026-11-05', '2026-11-05']);
    expect(p.movedBecause).toBeUndefined();
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
    const next = nextPayday(d(2026, 11, 3));
    expect([ymd(next.payDate), ymd(next.period.start)]).toEqual(['2026-11-05', '2026-10-16']);
  });
  it('still shows today on payday itself', () => {
    expect(ymd(nextPayday(d(2026, 11, 5, 18)).payDate)).toBe('2026-11-05');
  });
  it('moves on to the 20th the day after', () => {
    const next = nextPayday(d(2026, 11, 6));
    expect([ymd(next.payDate), ymd(next.period.start)]).toEqual(['2026-11-20', '2026-11-01']);
  });
  it('follows a moved pay date', () => {
    expect(ymd(nextPayday(d(2026, 12, 4)).payDate)).toBe('2026-12-04');
    expect(ymd(nextPayday(d(2026, 12, 5)).payDate)).toBe('2026-12-18');
  });
});
