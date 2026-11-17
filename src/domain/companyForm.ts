import { ymd } from '../util/format';
import { keepsTime, type Company } from './company';
import type { IfBankClosed, PayFrequency, PaySchedule } from './payPeriod';
import { DEFAULT_PAY_CODES, type PayCodes } from './payrollCsv';

/**
 * The company details as a supervisor types them, and the company they make.
 * The app's Company screen and the office dashboard's Company page fill in the
 * same form and get the same company from it.
 */

export type Often = 'none' | PayFrequency;
export type PaidBy = 'dayOfMonth' | 'daysAfter';

export const OFTEN: { value: Often; label: string }[] = [
  { value: 'none', label: 'No pay periods' },
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'monthly', label: 'Once a month' },
];

export const PAID_BY: { value: PaidBy; label: string }[] = [
  { value: 'dayOfMonth', label: 'On a day of the month' },
  { value: 'daysAfter', label: 'Days after it ends' },
];

export const BANK: { value: IfBankClosed; label: string }[] = [
  { value: 'before', label: 'Banking day before' },
  { value: 'after', label: 'Banking day after' },
  { value: 'stay', label: 'Stays put' },
];

/** The six kinds of hours, two to a row. */
export const CODE_ROWS: { key: keyof PayCodes; label: string }[][] = [
  [{ key: 'regular', label: 'Straight time' }, { key: 'overtime', label: 'Overtime' }],
  [{ key: 'double', label: 'Double time' }, { key: 'holiday', label: 'Holiday' }],
  [{ key: 'pto', label: 'PTO' }, { key: 'sick', label: 'Sick' }],
];

/** The form's fields, all as typed, so a half-typed number is not lost. */
export interface CompanyDraft {
  name: string;
  state: string;
  place: string;
  mineId: string;
  /** Whether the crew keeps time in the app as well as the safety forms. */
  timeClock: boolean;
  /** The earning code for each kind of hours on the payroll hours file. */
  codes: PayCodes;
  often: Often;
  firstDay: string;
  paidBy: PaidBy;
  daysAfter: string;
  firstHalf: string;
  secondHalf: string;
  ifBankClosed: IfBankClosed;
}

/** The form as it opens on a company. `now` is only for the first day offered to a company with no weekly period yet. */
export function draftOf(company: Company, now: number = Date.now()): CompanyDraft {
  const pay = company.pay;
  const days = pay && 'dayOfMonth' in pay.payday ? pay.payday.dayOfMonth : [];
  return {
    name: company.name,
    state: company.state,
    place: company.place ?? '',
    mineId: company.mineId ?? '',
    timeClock: keepsTime(company),
    codes: company.payCodes ?? DEFAULT_PAY_CODES,
    often: pay?.frequency ?? 'none',
    firstDay: pay?.firstDay ?? ymd(now),
    paidBy: pay ? ('dayOfMonth' in pay.payday ? 'dayOfMonth' : 'daysAfter') : 'dayOfMonth',
    daysAfter: pay && 'daysAfter' in pay.payday ? String(pay.payday.daysAfter) : '5',
    firstHalf: days[0] != null ? String(days[0]) : '20',
    secondHalf: days[1] != null ? String(days[1]) : '5',
    ifBankClosed: pay?.ifBankClosed ?? 'before',
  };
}

const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);

/** How the form says a period is paid: a period by the week is always paid so many days after it ends. */
export function paidByOf(draft: Pick<CompanyDraft, 'often' | 'paidBy'>): PaidBy {
  return draft.often === 'weekly' || draft.often === 'biweekly' ? 'daysAfter' : draft.paidBy;
}

/** The pay schedule the form describes, or null for none. A number not typed yet is NaN, which `checkPaySchedule` turns down. */
export function scheduleOf(draft: CompanyDraft): PaySchedule | null {
  if (draft.often === 'none') return null;
  const byWeek = draft.often === 'weekly' || draft.often === 'biweekly';
  const payday =
    paidByOf(draft) === 'daysAfter'
      ? { daysAfter: whole(draft.daysAfter) }
      : { dayOfMonth: draft.often === 'semimonthly' ? [whole(draft.firstHalf), whole(draft.secondHalf)] : [whole(draft.firstHalf)] };
  return {
    frequency: draft.often,
    ...(byWeek ? { firstDay: draft.firstDay.trim() } : {}),
    payday,
    ifBankClosed: draft.ifBankClosed,
  };
}

export const sameCodes = (a: PayCodes, b: PayCodes) => (Object.keys(b) as (keyof PayCodes)[]).every((k) => a[k] === b[k]);

/** The earning codes as they are saved: closed up at the ends and in capitals. */
export function codesOf(draft: Pick<CompanyDraft, 'codes'>): PayCodes {
  return Object.fromEntries(Object.entries(draft.codes).map(([k, v]) => [k, v.trim().toUpperCase()])) as unknown as PayCodes;
}

/**
 * The company the form makes from the one it opened on. With no time clock the
 * pay periods are not shown, so what was saved stays as it was for when it is
 * turned back on. Earning codes that are the usual ones are not kept. The logo
 * and anything else the form does not show stay as they were.
 */
export function companyFromDraft(company: Company, draft: CompanyDraft): Company {
  const codes = codesOf(draft);
  return {
    ...company,
    name: draft.name,
    state: draft.state,
    place: draft.place,
    mineId: draft.mineId.trim(),
    pay: draft.timeClock ? scheduleOf(draft) : company.pay,
    timeClock: draft.timeClock ? undefined : false,
    payCodes: sameCodes(codes, DEFAULT_PAY_CODES) ? undefined : codes,
  };
}
