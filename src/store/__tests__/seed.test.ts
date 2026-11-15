import { AREA_CONDITIONS, examFindings, openFindings, parseAreaSheets, rowAnswer, SAMPLE_AREA_SHEETS, shiftAt } from '../../domain/areaExam';
import { payPeriodOf, previousPayPeriod } from '../../domain/payPeriod';
import { computePayroll, computeRange } from '../../domain/payroll';
import { checklistFor } from '../../domain/templates';
import { shiftFlags, shiftTotals } from '../../domain/time';
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
      [1044, 'open'],
    ]);
    expect(data.mrfSeq).toBe(1045);

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
    // Every request came from a checklist or from a line on an exam, and they point at each other.
    for (const m of data.mrfs) {
      const fromChecklist = data.inspections.some((i) => i.id === m.inspectionId && i.mrfId === m.id);
      const fromExam = data.exams.some((x) => x.id === m.examId && examFindings(x).some((f) => f.key === m.findingKey && f.mrfId === m.id));
      expect(fromChecklist || fromExam).toBe(true);
    }
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

  it.each(DAYS)('has every lunch end by itself after 30 minutes, opened at %d', (now) => {
    const data = buildDemoData(now);
    const lunches = data.shifts.flatMap((s) => s.lunches);
    expect(lunches.length).toBeGreaterThan(100);
    for (const lunch of lunches) {
      expect(lunch.end).toEqual({ at: lunch.start.at + 30 * 60_000, auto: true });
    }
    // Somebody is at lunch right now, so the board has one to show.
    const eating = data.shifts.filter((s) => !s.clockOut && shiftTotals(s, now).onLunch);
    expect(eating.map((s) => s.employeeId)).toEqual(['e07']);
  });

  it('gives the sample employee a rate so the pay estimate has something to show', () => {
    expect(buildDemoData(DAYS[4]).payRates.emp_demo).toBeGreaterThan(0);
  });

  it.each(DAYS)('fills every equipment checklist in on the 21 lines of the card, opened at %d', (now) => {
    const data = buildDemoData(now);
    const lines = checklistFor('loader').items.map((i) => i.id);
    expect(data.inspections.length).toBeGreaterThan(60);
    for (const inspection of data.inspections) {
      expect(inspection.templateId).toBe('operator_equipment_checklist');
      expect(inspection.answers.map((a) => a.itemId)).toEqual(lines);
      // Whatever is wrong is written down.
      for (const a of inspection.answers) if (a.answer === 'bo') expect(a.note).toBeTruthy();
    }
    // A machine on tracks has no tires to check, so that line is N/A on its card.
    const dozer = data.equipment.find((e) => e.category === 'dozer')!;
    const onDozer = data.inspections.find((i) => i.equipmentId === dozer.id)!;
    expect(onDozer.answers.find((a) => a.itemId === 'tires')?.answer).toBe('na');
    // Some cards have gallons and a comment written on them.
    expect(data.inspections.some((i) => i.fuelGal)).toBe(true);
    expect(data.inspections.some((i) => i.comments)).toBe(true);
  });

  it.each(DAYS)('has pre shift exams for each work area, with conditions found and fixed, opened at %d', (now) => {
    const data = buildDemoData(now);
    expect(data.areaSheets).toEqual(SAMPLE_AREA_SHEETS);
    const today = startOfDay(now);
    const people = new Set(data.employees.map((e) => e.id));
    for (const exam of data.exams) {
      const sheet = data.areaSheets.find((s) => s.id === exam.sheetId)!;
      expect(exam.area).toBe(sheet.title);
      expect(people.has(exam.employeeId)).toBe(true);
      expect(exam.rows.map((r) => r.label)).toEqual(sheet.rows.map((r) => r.label));
      expect(exam.conditions.map((c) => c.id)).toEqual(AREA_CONDITIONS.map((c) => c.id));
      // An exam is made by someone who was on the clock that day.
      expect(data.shifts.some((s) => s.employeeId === exam.employeeId && s.clockIn.at <= exam.submittedAt && startOfDay(s.clockIn.at) === startOfDay(exam.submittedAt))).toBe(true);
    }
    const examinedToday = new Set(data.exams.filter((x) => x.submittedAt >= today).map((x) => x.sheetId));
    // One area is left for whoever opens the preview to examine.
    expect([...examinedToday].sort()).toEqual([data.areaSheets[1].id, data.areaSheets[2].id].sort());

    const found = data.exams.flatMap(examFindings);
    const open = openFindings(data.exams);
    // One was fixed on the spot, one is waiting on a maintenance request, one is still open from yesterday.
    expect(found.filter((f) => f.fixed).length).toBe(1);
    expect(open.map((f) => !!f.mrfId).sort()).toEqual([false, true]);
    expect(open.find((f) => f.mrfId)?.foundAt).toBeGreaterThanOrEqual(today);
    expect(open.find((f) => !f.mrfId)?.foundAt).toBeLessThan(today);
  });

  it.each(DAYS)('numbers the maintenance requests in the order they were sent, opened at %d', (now) => {
    const data = buildDemoData(now);
    const byNumber = [...data.mrfs].sort((a, b) => a.number - b.number).map((m) => m.createdAt);
    expect(byNumber).toEqual([...byNumber].sort((a, b) => a - b));
  });

  it.each(DAYS)('never passes a line while what was found on it is still open, opened at %d', (now) => {
    const data = buildDemoData(now);
    // An exam made after a condition was found, in the same area, does not mark that line OK.
    for (const open of openFindings(data.exams)) {
      const [page, id] = [open.key.slice(0, open.key.indexOf(':')), open.key.slice(open.key.indexOf(':') + 1)];
      for (const exam of data.exams.filter((x) => x.sheetId === open.sheetId && x.submittedAt > open.foundAt)) {
        const answer = page === 'row' ? rowAnswer(exam.rows.find((r) => r.id === id)!) : exam.conditions.find((c) => c.id === id)!.answer;
        expect([exam.area, open.label, answer]).toEqual([exam.area, open.label, 'bo']);
      }
    }
    // A unit with a request still open on a line does not pass that line on a later checklist.
    for (const mrf of data.mrfs.filter((m) => m.status !== 'completed' && m.inspectionId)) {
      const first = data.inspections.find((i) => i.id === mrf.inspectionId)!;
      const lines = first.answers.filter((a) => a.answer === 'bo').map((a) => a.itemId);
      const later = data.inspections.filter((i) => i.equipmentId === first.equipmentId && i.submittedAt > first.submittedAt);
      for (const check of later) {
        for (const line of lines) expect([mrf.number, line, check.answers.find((a) => a.itemId === line)?.answer]).toEqual([mrf.number, line, 'bo']);
        // The later checklist points at the request that is already in, not at a new one.
        expect(check.mrfId).toBe(mrf.id);
      }
    }
  });

  it('marks the outdoor conditions N/A only on the sheet of an indoor area, whatever its place in the list', () => {
    const named = parseAreaSheets('North plant\nFeeder\n\nBag house\nFan\n\nYard\nGate\n\nAssay lab\nBalance');
    const data = buildDemoData(DAYS[4], named);
    const haulRoads = (area: string) => data.exams.filter((x) => x.area === area).map((x) => x.conditions.find((c) => c.id === 'haul_roads')?.answer);
    expect(new Set(haulRoads('Assay lab'))).toEqual(new Set(['na']));
    expect(new Set(haulRoads('Yard'))).toEqual(new Set(['ok']));
  });

  it('puts an exam made in the small hours on the night shift', () => {
    // Opened at 6:15 AM, the crew that is already hours into its shift came in around midnight.
    const data = buildDemoData(new Date(2026, 10, 13, 6, 15).getTime());
    expect(data.exams.some((exam) => new Date(exam.submittedAt).getHours() < 4)).toBe(true);
    for (const exam of data.exams) expect(exam.shift).toBe(shiftAt(exam.submittedAt));
  });

  it('makes the sample exams on whatever sheets a build names', () => {
    const named = parseAreaSheets('North plant\nFeeder\nBelt 4\nScreen\n\nBag house\nFan\nHopper');
    const data = buildDemoData(DAYS[4], named);
    expect(data.areaSheets).toEqual(named);
    expect(new Set(data.exams.map((x) => x.area))).toEqual(new Set(['North plant', 'Bag house']));
    expect(openFindings(data.exams).length).toBeGreaterThan(0);
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
    expect(safety.sheets).toBe(8);
    expect(safety.rows).toBeGreaterThan(900);
  });
});
