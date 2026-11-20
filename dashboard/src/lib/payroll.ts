import { computePayroll, sumPayroll, type EmployeePayroll, type PayrollSum } from '@app/domain/payroll';
import { spanOf, stepSpan, viewsFor, type Span, type SpanKind, type SpanOptions } from '@app/domain/spans';
import { rulesFor } from '@app/domain/stateRules';
import type { Employee } from '@app/domain/types';
import type { ReportRange } from '@app/services/reports';

import type { Shaped } from './records';

/**
 * Hours for the office, worked out the way the app works them: the company's
 * state rules, overtime over whole workweeks, and only the people still on the
 * app's roster, exactly as the Excel payroll export does. No hourly rate is
 * ever read or shown here.
 */

export function spanOptions(shaped: Pick<Shaped, 'company' | 'workweekStartsOn'>): SpanOptions {
  return { pay: shaped.company.pay, weekStartsOn: shaped.workweekStartsOn };
}

/** The kinds of span the company's hours can be shown by: its pay period first, when it has one. */
export function payrollViews(shaped: Pick<Shaped, 'company'>): SpanKind[] {
  return viewsFor(shaped.company.pay);
}

export function currentSpan(kind: SpanKind, at: number, shaped: Pick<Shaped, 'company' | 'workweekStartsOn'>): Span {
  return spanOf(kind, at, spanOptions(shaped));
}

export function step(span: Span, direction: 1 | -1, shaped: Pick<Shaped, 'company' | 'workweekStartsOn'>): Span {
  return stepSpan(span, direction, spanOptions(shaped));
}

export interface PayrollTable {
  rows: EmployeePayroll[];
  totals: PayrollSum;
  /** People with hours to pay and no payroll ID, which the hours file needs. */
  missingPayrollIds: number;
  /**
   * People taken off the app's roster who have hours in the span. Like the
   * phones, the table and the files leave them out; the page lists them, so the
   * hours for a last check are not dropped without a word.
   */
  offRoster: EmployeePayroll[];
  /**
   * People with hours and no employee record yet. They are in the table and
   * the workbook, but the hours file, which a payroll system imports, leaves
   * them out rather than send a name the app's roster does not have. Added on
   * the Roster page, they keep these hours.
   */
  heldBack: EmployeePayroll[];
}

const byName = (a: Employee, b: Employee) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);
const hasHours = (r: EmployeePayroll) => r.total > 0 || r.needsFix > 0;

export function payrollFor(
  shaped: Pick<Shaped, 'data' | 'company' | 'workweekStartsOn'> & Partial<Pick<Shaped, 'placeholders'>>,
  span: Pick<Span, 'start' | 'end'>,
  now: number,
): PayrollTable {
  const options = { weekStartsOn: shaped.workweekStartsOn, rules: rulesFor(shaped.company.state) };
  const figure = (people: Employee[]) => computePayroll(people, shaped.data.shifts, shaped.data.leave, span.start, span.end, now, options);
  const rows = figure(shaped.data.employees.filter((e) => e.active).sort(byName));
  const placeholders = shaped.placeholders ?? new Set<string>();
  return {
    rows,
    totals: sumPayroll(rows),
    missingPayrollIds: rows.filter((r) => r.total > 0 && !r.employee.payrollId && !placeholders.has(r.employee.id)).length,
    offRoster: figure(shaped.data.employees.filter((e) => !e.active && !placeholders.has(e.id)).sort(byName)).filter(hasHours),
    heldBack: rows.filter((r) => placeholders.has(r.employee.id) && hasHours(r)),
  };
}

/** The records the hours file is made from: everyone with an employee record in the app’s roster. */
export function hoursFileData(shaped: Pick<Shaped, 'data' | 'placeholders'>): Shaped['data'] {
  return { ...shaped.data, employees: shaped.data.employees.filter((e) => !shaped.placeholders.has(e.id)) };
}

/**
 * The records the safety files are made from. Someone no record names reads
 * "Unknown" in them, as in the app's own; a placeholder kept only so their hours
 * count in payroll is left out of these, which hold no hours.
 */
export function safetyFileData(shaped: Pick<Shaped, 'data' | 'unnamed'>): Shaped['data'] {
  return { ...shaped.data, employees: shaped.data.employees.filter((e) => !shaped.unnamed.has(e.id)) };
}

/** A span as the range the Excel and CSV exports take; a pay period carries its pay date. */
export function reportRange(span: Span): ReportRange {
  return { start: span.start, end: span.end, ...(span.kind === 'period' && span.payDate ? { payDate: span.payDate } : null) };
}
