import { checkCompany, savedCompany, type Company } from '../company';
import { BANK, CODE_ROWS, codesOf, companyFromDraft, draftOf, OFTEN, PAID_BY, paidByOf, sameCodes, scheduleOf } from '../companyForm';
import { checkPaySchedule } from '../payPeriod';
import { DEFAULT_PAY_CODES } from '../payrollCsv';

const NOW = new Date(2026, 10, 17, 9).getTime();

const company: Company = {
  name: 'Example Aggregates Co.',
  state: 'NV',
  place: 'Fallon, Nevada',
  mineId: '2601234',
  logo: { uri: 'https://example.com/logo.png' },
  pay: { frequency: 'semimonthly', payday: { dayOfMonth: [20, 5] }, ifBankClosed: 'before' },
};

describe('the company form', () => {
  it('opens on the company as it is', () => {
    expect(draftOf(company, NOW)).toEqual({
      name: 'Example Aggregates Co.',
      state: 'NV',
      place: 'Fallon, Nevada',
      mineId: '2601234',
      timeClock: true,
      codes: DEFAULT_PAY_CODES,
      often: 'semimonthly',
      firstDay: '2026-11-17',
      paidBy: 'dayOfMonth',
      daysAfter: '5',
      firstHalf: '20',
      secondHalf: '5',
      ifBankClosed: 'before',
    });
  });

  it('opens on a company with nothing set: no pay periods, the time clock on, the usual codes', () => {
    const draft = draftOf({ name: '', state: '', pay: null }, NOW);
    expect(draft).toMatchObject({ name: '', state: '', place: '', mineId: '', timeClock: true, often: 'none', codes: DEFAULT_PAY_CODES });
    expect(scheduleOf(draft)).toBeNull();
  });

  it('gives back the same company when nothing is changed', () => {
    expect(savedCompany(companyFromDraft(company, draftOf(company, NOW)))).toEqual({ ok: true, company });
    const weekly: Company = { name: 'A', state: 'CA', pay: { frequency: 'biweekly', firstDay: '2026-11-01', payday: { daysAfter: 5 }, ifBankClosed: 'after' } };
    expect(savedCompany(companyFromDraft(weekly, draftOf(weekly, NOW)))).toEqual({ ok: true, company: weekly });
    const safetyOnly: Company = { name: 'B', state: 'AZ', pay: null, timeClock: false, payCodes: { ...DEFAULT_PAY_CODES, regular: '01' } };
    expect(savedCompany(companyFromDraft(safetyOnly, draftOf(safetyOnly, NOW)))).toEqual({ ok: true, company: safetyOnly });
  });

  it('makes each kind of schedule from what is typed', () => {
    const draft = draftOf(company, NOW);
    expect(scheduleOf({ ...draft, often: 'weekly', firstDay: ' 2026-11-01 ', daysAfter: '6' })).toEqual({ frequency: 'weekly', firstDay: '2026-11-01', payday: { daysAfter: 6 }, ifBankClosed: 'before' });
    expect(scheduleOf({ ...draft, often: 'monthly', firstHalf: '31', ifBankClosed: 'stay' })).toEqual({ frequency: 'monthly', payday: { dayOfMonth: [31] }, ifBankClosed: 'stay' });
    expect(scheduleOf({ ...draft, often: 'semimonthly', paidBy: 'daysAfter', daysAfter: '0' })).toEqual({ frequency: 'semimonthly', payday: { daysAfter: 0 }, ifBankClosed: 'before' });
    expect(scheduleOf({ ...draft, often: 'none' })).toBeNull();
  });

  it('pays a period by the week so many days after it ends, whatever was chosen for a month', () => {
    expect(paidByOf({ often: 'biweekly', paidBy: 'dayOfMonth' })).toBe('daysAfter');
    expect(paidByOf({ often: 'monthly', paidBy: 'dayOfMonth' })).toBe('dayOfMonth');
    expect(paidByOf({ often: 'monthly', paidBy: 'daysAfter' })).toBe('daysAfter');
  });

  it('leaves a number not typed yet for the schedule check to turn down', () => {
    const draft = draftOf(company, NOW);
    const half = scheduleOf({ ...draft, firstHalf: '' });
    expect(half && checkPaySchedule(half)).toBe('A day of the month must be from 1 to 31.');
    const days = scheduleOf({ ...draft, often: 'weekly', daysAfter: 'five' });
    expect(days && checkPaySchedule(days)).toBe('The days after a period ends must be a whole number from 0 to 60.');
    const first = scheduleOf({ ...draft, often: 'weekly', firstDay: 'Nov 1' });
    expect(first && checkPaySchedule(first)).toBe('Give the first day of any one pay period as a date, like 2026-11-01.');
  });

  it('keeps the saved pay periods while the time clock is off, for when it is turned back on', () => {
    const draft = { ...draftOf(company, NOW), timeClock: false, often: 'none' as const };
    const next = companyFromDraft(company, draft);
    expect(next.timeClock).toBe(false);
    expect(next.pay).toEqual(company.pay);
  });

  it('keeps earning codes only when they are not the usual ones, in capitals', () => {
    const draft = draftOf(company, NOW);
    expect(companyFromDraft(company, draft).payCodes).toBeUndefined();
    const own = companyFromDraft(company, { ...draft, codes: { ...draft.codes, regular: ' 01 ', overtime: 'ot2' } });
    expect(own.payCodes).toEqual({ ...DEFAULT_PAY_CODES, regular: '01', overtime: 'OT2' });
    expect(codesOf({ codes: { ...DEFAULT_PAY_CODES, sick: ' sk ' } }).sick).toBe('SK');
    expect(sameCodes(DEFAULT_PAY_CODES, { ...DEFAULT_PAY_CODES })).toBe(true);
    expect(sameCodes({ ...DEFAULT_PAY_CODES, pto: 'VAC' }, DEFAULT_PAY_CODES)).toBe(false);
  });

  it('keeps the logo and anything else the form does not show', () => {
    const more = { ...company, extra: 'kept' } as Company;
    const next = companyFromDraft(more, { ...draftOf(more, NOW), name: 'Renamed Co.' });
    expect(next).toMatchObject({ name: 'Renamed Co.', logo: company.logo, extra: 'kept' });
  });

  it('offers every choice the schedule check knows, and all six kinds of hours', () => {
    expect(OFTEN.map((o) => o.value)).toEqual(['none', 'weekly', 'biweekly', 'semimonthly', 'monthly']);
    expect(PAID_BY.map((o) => o.value)).toEqual(['dayOfMonth', 'daysAfter']);
    expect(BANK.map((o) => o.value)).toEqual(['before', 'after', 'stay']);
    expect(CODE_ROWS.flat().map((c) => c.key).sort()).toEqual(Object.keys(DEFAULT_PAY_CODES).sort());
  });
});

describe('a company as it is saved', () => {
  it('closes up the name and the place, and writes the mine ID as its seven digits', () => {
    expect(savedCompany({ name: '  Example   Aggregates Co. ', state: 'NV', place: ' Fallon,   Nevada ', mineId: '26-01234', pay: null })).toEqual({
      ok: true,
      company: { name: 'Example Aggregates Co.', state: 'NV', place: 'Fallon, Nevada', mineId: '2601234', pay: null },
    });
  });

  it('keeps nothing that says nothing: no place, no mine ID, a time clock that is on, no codes of its own', () => {
    const saved = savedCompany({ name: 'A', state: 'CA', place: '   ', mineId: '', pay: null, timeClock: undefined, payCodes: undefined });
    expect(saved).toEqual({ ok: true, company: { name: 'A', state: 'CA', pay: null } });
    expect(saved.ok && Object.keys(saved.company).sort()).toEqual(['name', 'pay', 'state']);
  });

  it('keeps the time clock off, and codes of its own', () => {
    const codes = { ...DEFAULT_PAY_CODES, regular: '01' };
    expect(savedCompany({ name: 'A', state: 'CA', pay: null, timeClock: false, payCodes: codes })).toEqual({
      ok: true,
      company: { name: 'A', state: 'CA', pay: null, timeClock: false, payCodes: codes },
    });
  });

  it('says what is wrong, in the words of the company check', () => {
    expect(savedCompany({ name: '   ', state: 'CA', pay: null })).toEqual({ ok: false, error: 'Give the company’s name.' });
    expect(savedCompany({ name: 'A', state: '', pay: null })).toEqual({ ok: false, error: 'Choose the state the crew works in.' });
    expect(savedCompany({ name: 'A', state: 'CA', mineId: '12345', pay: null })).toEqual({ ok: false, error: 'An MSHA mine ID is seven digits, like 0400123.' });
    const twice = { ...DEFAULT_PAY_CODES, overtime: 'REG' };
    expect(savedCompany({ name: 'A', state: 'CA', pay: null, payCodes: twice })).toEqual({ ok: false, error: checkCompany({ name: 'A', state: 'CA', pay: null, payCodes: twice }) });
    expect(savedCompany({ name: 'A', state: 'CA', pay: { frequency: 'monthly', payday: { dayOfMonth: [40] }, ifBankClosed: 'before' } })).toEqual({
      ok: false,
      error: 'A day of the month must be from 1 to 31.',
    });
  });
});
