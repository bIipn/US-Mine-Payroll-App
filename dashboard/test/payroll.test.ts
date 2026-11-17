import { describe, expect, it } from 'vitest';

import { SAMPLE_COMPANY } from '@app/domain/company';
import { computePayroll } from '@app/domain/payroll';
import { rulesFor } from '@app/domain/stateRules';
import { inspectorReport } from '@app/services/inspectorReport';
import { payrollHoursFile, payrollReport } from '@app/services/reports';
import { buildDemoData } from '@app/store/seed';

import { currentSpan, hoursFileData, payrollFor, payrollViews, reportRange, safetyFileData, step } from '../src/lib/payroll';
import { shapeRecords } from '../src/lib/records';
import { addDays, startOfDay } from '@app/util/format';

import type { RecordRow } from '../src/lib/server';
import { seedRows } from './fixtures';

const NOW = new Date(2026, 10, 16, 14, 30).getTime();
const shaped = shapeRecords(seedRows(NOW, buildDemoData(NOW)));

describe('payrollFor', () => {
  it('gives the same figures as the app’s computePayroll, for the people still on the app’s roster', () => {
    const span = currentSpan('period', NOW, shaped);
    const table = payrollFor(shaped, span, NOW);
    const people = shaped.data.employees.filter((e) => e.active).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
    expect(table.rows).toEqual(computePayroll(people, shaped.data.shifts, shaped.data.leave, span.start, span.end, NOW, { weekStartsOn: 0, rules: rulesFor('CA') }));
    expect(table.totals.total).toBe(table.rows.reduce((sum, r) => sum + r.total, 0));
    expect(table.totals.total).toBeGreaterThan(0);
  });

  it('follows the company’s state: Nevada has no daily overtime', () => {
    const nv = { ...shaped, company: { ...shaped.company, state: 'NV' } };
    const span = currentSpan('week', NOW, nv);
    const ca = payrollFor(shaped, span, NOW).totals;
    const there = payrollFor(nv, span, NOW).totals;
    expect(there.paid).toBe(ca.paid);
    expect(there.dt).toBe(0);
  });

  it('counts the people with hours to pay and no payroll ID', () => {
    const span = currentSpan('period', NOW, shaped);
    const table = payrollFor(shaped, span, NOW);
    expect(table.missingPayrollIds).toBe(table.rows.filter((r) => r.total > 0 && !r.employee.payrollId).length);
  });
});

describe('people off the roster, and people with no employee record', () => {
  const start = startOfDay(NOW);
  const row = (kind: string, id: string, data: unknown, by = 'user-x'): RecordRow => ({
    kind, id, rev: 'r1', data, deleted: false, created_by: by, updated_by: by,
    created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
  });
  const shift = (id: string, employeeId: string) =>
    row('shift', id, { employeeId, clockIn: { at: start + 6 * 3_600_000 }, clockOut: { at: start + 14 * 3_600_000 }, lunches: [], breaks: [] });
  const records = [
    row('settings', 'company', { company: { name: 'Test Pit A', state: 'NV', pay: null }, workweekStartsOn: 0 }),
    row('employee', 'e1', { firstName: 'Sam', lastName: 'Ortiz', role: 'employee', active: true, payrollId: '101' }),
    row('employee', 'e2', { firstName: 'Pete', lastName: 'Lawson', role: 'employee', active: false, payrollId: '102' }),
    shift('s1', 'e1'),
    shift('s2', 'e2'),
    shift('s3', 'e3'),
    row('exam', 'x1', { employeeId: 'e3', area: 'Crusher', shift: 'day', sheetId: 'crusher', startedAt: start + 6 * 3_600_000, submittedAt: start + 6.5 * 3_600_000, rows: [], conditions: [] }),
  ];
  const span = { start, end: addDays(start, 1) };

  it('lists someone taken off the app’s roster who has hours in the span, as neither the table nor the files count them', () => {
    const shaped = shapeRecords(records);
    const table = payrollFor(shaped, span, NOW);
    expect(table.rows.map((r) => r.employee.id)).toEqual(['e1', 'e3']);
    expect(table.offRoster.map((r) => [r.employee.id, r.total])).toEqual([['e2', 800]]);
  });

  it('keeps the hours of someone with no employee record in the table and the workbook, and out of the hours file', () => {
    const shaped = shapeRecords(records);
    const table = payrollFor(shaped, span, NOW);
    expect(table.heldBack.map((r) => r.employee.id)).toEqual(['e3']);
    // They have no payroll ID, but they are not in the file, so they are not counted as missing one.
    expect(table.missingPayrollIds).toBe(0);
    const csv = new TextDecoder().decode(payrollHoursFile(hoursFileData(shaped), span, 'period', NOW).bytes);
    expect(csv).toMatch(/^101,Ortiz,Sam,/m);
    expect(csv).not.toMatch(/Unknown|e3/);
    // The safety files print them as the app prints someone it does not know.
    const pdf = Buffer.from(inspectorReport(safetyFileData(shaped), start, span.end, NOW).bytes).toString('latin1');
    expect(pdf).toMatch(/Unknown/);
    expect(pdf).not.toMatch(/ID e3/);
  });
});

describe('spans', () => {
  it('offers the pay period only when the company has one', () => {
    expect(payrollViews(shaped)).toEqual(['period', 'week', 'month']);
    expect(payrollViews({ company: { ...SAMPLE_COMPANY, pay: null } })).toEqual(['week', 'month']);
  });

  it('steps a pay period back and forth, and hands its pay date to the Excel export', () => {
    const period = currentSpan('period', NOW, shaped);
    // The sample company pays twice a month: the 1st to the 15th, then the 16th to the end.
    expect(new Date(period.start).getDate()).toBe(16);
    const before = step(period, -1, shaped);
    expect(new Date(before.start).getDate()).toBe(1);
    expect(step(before, 1, shaped).start).toBe(period.start);
    expect(reportRange(before)).toEqual({ start: before.start, end: before.end, payDate: before.payDate });
    const week = currentSpan('week', NOW, shaped);
    expect(reportRange(week)).toEqual({ start: week.start, end: week.end });
    // The workbook is the app's own, made from the same range.
    expect(payrollReport(shaped.data, reportRange(before), NOW).name).toMatch(/^Sample-Mining-Co-Payroll_2026-11-01_to_2026-11-15\.xlsx$/);
  });
});
