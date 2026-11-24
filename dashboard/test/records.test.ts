import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { SAMPLE_COMPANY } from '@app/domain/company';
import { computePayroll } from '@app/domain/payroll';
import { rulesFor } from '@app/domain/stateRules';
import { inspectorReport } from '@app/services/inspectorReport';
import { payrollHoursFile, payrollReport, safetyReport, type ReportData } from '@app/services/reports';
import { buildDemoData } from '@app/store/seed';
import { addDays, startOfDay } from '@app/util/format';

import { nameOf, shapeRecords } from '../src/lib/records';
import type { RecordRow } from '../src/lib/server';
import { accountOf, rosterRow, seedRows } from './fixtures';

const NOW = new Date(2026, 10, 16, 14, 30).getTime();
const seed = buildDemoData(NOW);
const rows = seedRows(NOW, seed);

const asSent: ReportData = {
  employees: seed.employees,
  shifts: seed.shifts,
  leave: seed.leave,
  equipment: seed.equipment,
  inspections: seed.inspections,
  opLogs: seed.opLogs,
  exams: seed.exams,
  mrfs: seed.mrfs,
  settings: { company: SAMPLE_COMPANY, workweekStartsOn: 0 },
};

const at = (iso: string) => iso;

/**
 * What is inside a workbook, file by file. The zip itself stamps each file with
 * the time it was written, so two workbooks made a second apart differ there alone.
 */
const workbook = (bytes: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, file]) => [name, strFromU8(file)]));
const one = (over: Partial<RecordRow> & Pick<RecordRow, 'kind' | 'id' | 'data'>): RecordRow => ({
  rev: 'r1',
  deleted: false,
  created_by: 'user-x',
  updated_by: 'user-x',
  created_at: at('2026-11-16T15:00:00.000Z'),
  updated_at: at('2026-11-16T15:00:00.000Z'),
  ...over,
});

describe('shapeRecords', () => {
  it('gives back the records the phones sent, kind by kind', () => {
    const shaped = shapeRecords(rows);
    expect(shaped.skipped).toEqual([]);
    expect(shaped.data.employees).toEqual(seed.employees);
    expect(shaped.data.shifts).toEqual(seed.shifts);
    expect(shaped.data.leave).toEqual(seed.leave);
    expect(shaped.data.equipment).toEqual(seed.equipment);
    expect(shaped.data.inspections).toEqual(seed.inspections);
    expect(shaped.data.opLogs).toEqual(seed.opLogs);
    expect(shaped.data.exams).toEqual(seed.exams);
    expect(shaped.data.mrfs).toEqual(seed.mrfs);
    expect(shaped.areaSheets).toEqual(seed.areaSheets);
    expect(shaped.company).toEqual(SAMPLE_COMPANY);
    expect(shaped.workweekStartsOn).toBe(0);
    expect(shaped.placeholders.size).toBe(0);
    expect(shaped.counts.shift).toBe(seed.shifts.length);
    expect(shaped.counts.settings).toBe(1);
  });

  it('makes the same payroll, Excel workbooks, hours file and inspector PDF as the app makes from its own records', () => {
    const shaped = shapeRecords(rows);
    const start = startOfDay(addDays(NOW, -14));
    const end = addDays(startOfDay(NOW), 1);
    const options = { weekStartsOn: 0, rules: rulesFor('CA') };
    const active = (d: ReportData) => d.employees.filter((e) => e.active);
    expect(computePayroll(active(shaped.data), shaped.data.shifts, shaped.data.leave, start, end, NOW, options)).toEqual(
      computePayroll(active(asSent), asSent.shifts, asSent.leave, start, end, NOW, options),
    );
    expect(workbook(payrollReport(shaped.data, { start, end }, NOW).bytes)).toEqual(workbook(payrollReport(asSent, { start, end }, NOW).bytes));
    expect(workbook(safetyReport(shaped.data, start, end, NOW).bytes)).toEqual(workbook(safetyReport(asSent, start, end, NOW).bytes));
    expect(payrollHoursFile(shaped.data, { start, end }, 'day', NOW).bytes).toEqual(payrollHoursFile(asSent, { start, end }, 'day', NOW).bytes);
    expect(inspectorReport(shaped.data, start, end, NOW).bytes).toEqual(inspectorReport(asSent, start, end, NOW).bytes);
  });

  it('leaves out a record a phone took off, and keeps the newest version of one sent twice', () => {
    const shaped = shapeRecords([
      one({ kind: 'equipment', id: 'eq_1', data: { id: 'eq_1', unit: 'L-1', category: 'loader' } }),
      one({ kind: 'equipment', id: 'eq_1', data: { id: 'eq_1', unit: 'L-1 new', category: 'loader' }, updated_at: '2026-11-16T16:00:00.000Z' }),
      one({ kind: 'equipment', id: 'eq_2', data: null, deleted: true, updated_at: '2026-11-16T17:00:00.000Z', updated_by: 'user-y' }),
    ]);
    expect(shaped.data.equipment.map((e) => e.unit)).toEqual(['L-1 new']);
    expect(shaped.counts.equipment).toBe(1);
    // Taking a record off is still the newest thing to arrive.
    expect(shaped.lastArrived).toEqual({ at: Date.parse('2026-11-16T17:00:00.000Z'), by: 'user-y' });
  });

  it('sets aside a record that is not the shape the app writes, and says why', () => {
    const shaped = shapeRecords([
      one({ kind: 'shift', id: 's1', data: { id: 's1', employeeId: 'e1' } }),
      one({ kind: 'exam', id: 'x1', data: 'not a record' }),
      one({ kind: 'payRates', id: 'p', data: { e1: 2400 } }),
      one({ kind: 'shift', id: 's2', data: { employeeId: 'e1', clockIn: { at: NOW - 3_600_000 } } }),
    ]);
    expect(shaped.skipped).toEqual([
      { kind: 'shift', id: 's1', why: 'no person or clock-in time' },
      { kind: 'exam', id: 'x1', why: 'no record in it' },
      { kind: 'payRates', id: 'p', why: 'a kind of record this dashboard does not know' },
    ]);
    // A record with no id of its own takes the server's, and a shift with no lunches has none.
    expect(shaped.data.shifts).toEqual([{ id: 's2', employeeId: 'e1', clockIn: { at: NOW - 3_600_000 }, lunches: [], breaks: [] }]);
  });

  it('takes the company from the settings the phones sent, and from the company on the server when there are none', () => {
    const server = { id: 'c', name: 'Test Pit A', state: 'NV', timezone: 'America/Los_Angeles', logo_path: null, pay_period: null };
    expect(shapeRecords([], { company: server }).company).toEqual({ name: 'Test Pit A', state: 'NV', pay: null });
    expect(shapeRecords([], { company: server }).settingsFrom).toBe('server');

    const weekly = { frequency: 'weekly', firstDay: '2026-11-01', payday: { daysAfter: 5 }, ifBankClosed: 'before' };
    expect(shapeRecords([], { company: { ...server, pay_period: weekly } }).company.pay).toEqual(weekly);
    // A pay rule the app cannot work out is no pay rule.
    expect(shapeRecords([], { company: { ...server, pay_period: { frequency: 'weekly' } } }).company.pay).toBeNull();

    const fromPhone = shapeRecords(
      [one({ kind: 'settings', id: 'company', data: { company: { name: '', state: 'CA', pay: null, timeClock: false }, workweekStartsOn: 1 } })],
      { company: server },
    );
    // The phones' own settings, as they are: a name they left empty stays empty, so the files are named as the phones name them.
    expect(fromPhone.company).toEqual({ name: '', state: 'CA', pay: null, timeClock: false });
    expect(fromPhone.settingsFrom).toBe('phones');
    expect(fromPhone.workweekStartsOn).toBe(1);
  });

  it('keeps a state the phones left empty, so the office figures the hours under the same rules the phones do', () => {
    const server = { id: 'c', name: 'Test Pit A', state: 'CA', timezone: 'America/Los_Angeles', logo_path: null, pay_period: null };
    const start = startOfDay(NOW);
    // Eleven hours in a day: daily overtime in California, none under the federal rules.
    const long = { employeeId: 'e1', clockIn: { at: start + 5 * 3_600_000 }, clockOut: { at: start + 16 * 3_600_000 }, lunches: [], breaks: [] };
    const shaped = shapeRecords(
      [
        one({ kind: 'settings', id: 'company', data: { company: { name: '', state: '', pay: null }, workweekStartsOn: 0 } }),
        one({ kind: 'employee', id: 'e1', data: { firstName: 'Sam', lastName: 'Ortiz', role: 'employee', active: true } }),
        one({ kind: 'shift', id: 's1', data: long }),
      ],
      { company: server },
    );
    expect(shaped.company.state).toBe('');
    const options = { weekStartsOn: 0, rules: rulesFor(shaped.company.state) };
    const [row] = computePayroll(shaped.data.employees, shaped.data.shifts, [], start, addDays(start, 1), NOW, options);
    expect(row.ot).toBe(0);
    expect(row.reg).toBe(1100);
    // The files are the phones' too: no company name, so the workbook is named as a phone with none names it.
    expect(payrollReport(shaped.data, { start, end: addDays(start, 1) }, NOW).name).toMatch(/^Payroll_/);
  });

  it('names a person with no employee record from the sign-in roster row of the account that sent their records', () => {
    const shaped = shapeRecords(
      [
        one({ kind: 'shift', id: 's1', created_by: 'acct-1', data: { employeeId: 'e1', clockIn: { at: NOW - 7_200_000 }, clockOut: { at: NOW } } }),
        one({ kind: 'exam', id: 'x1', created_by: 'acct-1', data: { employeeId: 'e1', area: 'Crusher', shift: 'day', startedAt: NOW - 600_000, submittedAt: NOW, rows: [], conditions: [] } }),
        // Leave is entered by a supervisor, so the account that sent it says nothing about whose it is.
        one({ kind: 'leave', id: 'l1', created_by: 'acct-sup', data: { employeeId: 'e2', day: startOfDay(NOW), hours: 800, type: 'pto', enteredBy: 'e9', at: NOW } }),
        one({ kind: 'exam', id: 'x2', created_by: 'acct-3', data: { employeeId: 'e3', area: 'Crusher', shift: 'day', startedAt: NOW - 600_000, submittedAt: NOW, rows: [], conditions: [] } }),
        // A request history line that assigns it to someone with no employee record.
        one({ kind: 'mrf', id: 'm1', created_by: 'acct-1', data: { number: 1001, createdAt: NOW, status: 'open', requestedBy: 'e1', history: [{ at: NOW, by: 'e1', status: 'open', assignedTo: 'e4' }] } }),
      ],
      {
        roster: [
          rosterRow({ first_name: 'Riley J', last_name: 'Quinn', user_id: 'acct-1', title: 'Crusher' }),
          rosterRow({ first_name: 'Pat', last_name: 'Supervisor', user_id: 'acct-sup', role: 'supervisor' }),
        ],
      },
    );
    const byId = new Map(shaped.data.employees.map((e) => [e.id, e]));
    expect(byId.get('e1')).toEqual({ id: 'e1', firstName: 'Riley J', lastName: 'Quinn', role: 'employee', title: 'Crusher', active: true });
    // Hours with no name anywhere: kept for payroll, under the id.
    expect(byId.get('e2')).toMatchObject({ firstName: 'ID e2', lastName: 'Unknown', active: true });
    // No hours and no name: nothing to keep, so they read "Unknown", as the app prints someone it does not know.
    expect(byId.has('e3')).toBe(false);
    expect(byId.has('e9')).toBe(false);
    expect(nameOf(shaped.data.employees, 'e3')).toBe('Unknown');
    expect([...shaped.placeholders].sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e9']);
    expect([...shaped.unnamed].sort()).toEqual(['e2', 'e3', 'e4', 'e9']);
    expect(nameOf(shaped.data.employees, 'e1')).toBe('Quinn, Riley J');
  });

  it('counts the hours of someone with no employee record in payroll, rather than dropping them', () => {
    const start = startOfDay(NOW);
    const shaped = shapeRecords([
      one({ kind: 'shift', id: 's1', created_by: accountOf('e1'), data: { employeeId: 'e1', clockIn: { at: start + 6 * 3_600_000 }, clockOut: { at: start + 14 * 3_600_000 } } }),
    ]);
    const rowsOut = computePayroll(shaped.data.employees.filter((e) => e.active), shaped.data.shifts, [], start, addDays(start, 1), NOW, { rules: rulesFor('NV') });
    expect(rowsOut.map((r) => r.total)).toEqual([800]);
  });
});
