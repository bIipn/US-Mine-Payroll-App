import { payPeriodOf, previousPayPeriod } from '../../domain/payPeriod';
import { computePayroll, computeRange } from '../../domain/payroll';
import { shiftFlags } from '../../domain/time';
import { payrollReport, safetyReport } from '../../services/reports';
import { addDays, startOfDay, startOfWeek } from '../../util/format';
import { buildDemoData } from '../seed';

// The sample data has to hold together whatever day of the week the demo is opened.
const DAYS = [9, 10, 11, 12, 13, 14, 15].map((d) => new Date(2026, 10, d, 10, 42).getTime());

describe('sample data', () => {
  it('is the same every time for the same moment', () => {
    expect(buildDemoData(DAYS[4])).toEqual(buildDemoData(DAYS[4]));
  });

  it.each(DAYS)('tells the same story when opened at %d', (now) => {
    const data = buildDemoData(now);
    const status = (unit: string) => data.equipment.find((e) => e.unit === unit)?.status;
    expect(status('EX-09')).toBe('out_of_service');
    expect(status('L-15')).toBe('defect');
    expect(status('HT-21')).toBe('ready');
    expect(data.mrfs.map((m) => [m.number, m.status])).toEqual([
      [1041, 'completed'],
      [1042, 'in_progress'],
      [1043, 'open'],
    ]);
    expect(data.mrfSeq).toBe(1044);

    const flagsOf = (id: string) => data.shifts.filter((s) => s.employeeId === id).flatMap((s) => shiftFlags(s, now));
    expect(flagsOf('e12')).toContain('missing_out');
    expect(flagsOf('e03')).toContain('late_lunch');
    expect(flagsOf('e10')).toContain('no_lunch');
    expect(flagsOf('e08')).toContain('offsite_out');
    expect(flagsOf('e04')).toContain('edited');

    // Every pre-op points at a real unit and a real person; every MRF at a real pre-op.
    const units = new Set(data.equipment.map((e) => e.id));
    const people = new Set(data.employees.map((e) => e.id));
    for (const i of data.inspections) {
      expect(units.has(i.equipmentId)).toBe(true);
      expect(people.has(i.employeeId)).toBe(true);
    }
    for (const m of data.mrfs) expect(data.inspections.some((i) => i.id === m.inspectionId && i.mrfId === m.id)).toBe(true);
    // The demo employee starts the day off the clock.
    expect(data.shifts.some((s) => s.employeeId === 'emp_demo' && !s.clockOut)).toBe(false);
    // Nobody is on two shifts at once.
    for (const e of data.employees) {
      const own = data.shifts.filter((s) => s.employeeId === e.id).sort((a, b) => a.clockIn.at - b.clockIn.at);
      for (let i = 1; i < own.length; i++) {
        expect(own[i].clockIn.at).toBeGreaterThan(own[i - 1].clockOut?.at ?? own[i - 1].clockIn.at);
      }
    }
  });

  it.each(DAYS)('has a full earlier pay period to look back on when opened at %d', (now) => {
    const data = buildDemoData(now);
    const last = previousPayPeriod(payPeriodOf(now));
    const own = data.shifts.filter((s) => s.employeeId === 'emp_demo');
    const range = computeRange(own, [], last.start, last.end, now);
    expect(range.daysWorked).toBeGreaterThanOrEqual(8);
    expect(range.needsFix).toBe(0);
  });

  it.each(DAYS)('includes paid leave on days the person did not work, opened at %d', (now) => {
    const data = buildDemoData(now);
    expect(data.leave.map((l) => l.type).sort()).toEqual(['pto', 'sick']);
    for (const entry of data.leave) {
      expect(entry.hours).toBe(800);
      const workedThatDay = data.shifts.some(
        (s) => s.employeeId === entry.employeeId && s.clockIn.at >= entry.day && s.clockIn.at < addDays(entry.day, 1),
      );
      expect(workedThatDay).toBe(false);
    }
  });

  it('gives the sample employee a rate so the pay estimate has something to show', () => {
    expect(buildDemoData(DAYS[4]).payRates.emp_demo).toBeGreaterThan(0);
  });

  it('feeds reports whose totals agree with the payroll screen', () => {
    const now = DAYS[4];
    const data = buildDemoData(now);
    const week = startOfWeek(now, 0);
    const period = payPeriodOf(now);
    const rows = computePayroll(data.employees, data.shifts, data.leave, period.start, period.end, now);
    for (const r of rows) {
      expect(r.reg + r.ot + r.dt).toBe(r.paid);
      expect(r.gross - r.lunch).toBe(r.paid);
      expect(r.paid + r.holiday + r.pto + r.sick).toBe(r.total);
    }
    const payroll = payrollReport(data, { start: period.start, end: period.end, payDate: period.payDate }, now);
    expect(payroll.name).toBe('US-Mine-Payroll_2026-11-01_to_2026-11-15.xlsx');
    expect(payroll.sheets).toBe(5);
    expect(payroll.bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    // A plain workweek still exports, for the weekly time log.
    expect(payrollReport(data, { start: week, end: addDays(week, 7) }, now).name).toBe('US-Mine-Payroll_2026-11-08_to_2026-11-14.xlsx');

    const to = addDays(startOfDay(now), 1);
    const safety = safetyReport(data, addDays(to, -30), to, now);
    expect(safety.name).toBe('US-Mine-Safety-Log_2026-10-15_to_2026-11-13.xlsx');
    expect(safety.sheets).toBe(5);
    expect(safety.rows).toBeGreaterThan(200);
  });
});
