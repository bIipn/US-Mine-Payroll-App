import { COMPANY } from '../config';
import { computePayroll, sumPayroll } from '../domain/payroll';
import { standard } from '../domain/standards';
import { CATEGORY_LABEL, countAnswers, findItem, isHazard, templateFor } from '../domain/templates';
import { backFromLunchAt, FLAG_HELP, FLAG_LABEL, MEAL_NOTE_LABEL, shiftFlags, shiftTotals } from '../domain/time';
import type { Employee, Equipment, Inspection, LeaveEntry, Mrf, OperatingLog, Punch, Shift } from '../domain/types';
import { addDays, DAY, fmtDateTime, fmtDayShort, fmtWeekday, HOUR, startOfDay, ymd } from '../util/format';
import { buildWorkbook, type CellInput, type Sheet } from './xlsx';

/**
 * Excel reports. Hours are written as hundredths-of-an-hour decimals, the same
 * figures shown in the app, so a sheet always adds up to the screen.
 */

export interface ReportData {
  employees: Employee[];
  shifts: Shift[];
  leave: LeaveEntry[];
  equipment: Equipment[];
  inspections: Inspection[];
  opLogs: OperatingLog[];
  mrfs: Mrf[];
}

export interface Report {
  name: string;
  bytes: Uint8Array;
  sheets: number;
  rows: number;
}

const hrs = (hundredths: number): CellInput => ({ v: hundredths / 100, s: 'num2' });
const totalHrs = (hundredths: number): CellInput => ({ v: hundredths / 100, s: 'totalNum' });
/** A calendar date with no time of day, so Excel sorts and filters it by day. */
const date = (ms: number): CellInput => ({ v: new Date(startOfDay(ms)), s: 'date' });
const time = (ms?: number): CellInput => (ms == null ? null : { v: new Date(ms), s: 'time' });
const yesNo = (value: boolean | undefined): CellInput => (value == null ? null : value ? 'Yes' : 'No');
const byName = (a: Employee, b: Employee) =>
  a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);
const nameOf = (e?: Employee) => (e ? `${e.lastName}, ${e.firstName}` : 'Unknown');
const feet = (metres?: number | null): CellInput => (metres == null ? null : { v: Math.round(metres * 3.28084), s: 'int' });

function finish(name: string, sheets: Sheet[]): Report {
  return {
    name,
    bytes: buildWorkbook(sheets),
    sheets: sheets.length,
    rows: sheets.reduce((sum, s) => sum + s.rows.length, 0),
  };
}

export interface ReportRange {
  start: number;
  /** Start of the day after the last day. */
  end: number;
  /** Set for a pay period, so the sheets say when it is paid. */
  payDate?: number;
}

const LEAVE_LABEL = { holiday: 'Holiday', pto: 'PTO', sick: 'Sick' } as const;

/**
 * Payroll for a pay period (or any run of days): summary, daily detail, paid
 * leave, punch log and flags. The summary has one column for each earning line
 * on the pay stub: ST, OT, DT, holiday, PTO and sick.
 */
export function payrollReport(data: ReportData, range: ReportRange, now: number): Report {
  const periodStart = startOfDay(range.start);
  const periodEnd = startOfDay(range.end);
  const lastDay = addDays(periodEnd, -1);
  const people = data.employees.filter((e) => e.active).sort(byName);
  const employeeOf = new Map(data.employees.map((e) => [e.id, e]));
  const rows = computePayroll(people, data.shifts, data.leave, periodStart, periodEnd, now);
  const totals = sumPayroll(rows);
  const period = `${fmtDayShort(periodStart)} to ${fmtDayShort(lastDay)}, ${new Date(lastDay).getFullYear()}`;
  const paid = range.payDate
    ? ` Pay date ${fmtWeekday(range.payDate)}, ${fmtDayShort(range.payDate)}, ${new Date(range.payDate).getFullYear()}.`
    : '';
  const stamp = `${range.payDate ? 'Pay period' : 'Period'} ${period}.${paid} Generated ${fmtDateTime(now)}. Hours are decimals: time on site less unpaid lunch (6:15 AM to 7:00 PM less a 0.50 lunch is 12.25).`;

  const summary: Sheet = {
    name: 'Payroll Summary',
    title: `${COMPANY} payroll summary`,
    subtitle: stamp,
    columns: [
      { header: 'Employee', width: 26 }, { header: 'Job title', width: 30 }, { header: 'Days worked', width: 12 },
      { header: 'ST hours', width: 11 }, { header: 'OT hours (1.5x)', width: 14 }, { header: 'DT hours (2x)', width: 13 },
      { header: 'Holiday', width: 10 }, { header: 'PTO', width: 9 }, { header: 'Sick', width: 9 },
      { header: 'Total hours', width: 12 }, { header: 'Hours on site', width: 13 }, { header: 'Unpaid lunch', width: 12 },
      { header: 'Meal flags', width: 11 }, { header: 'Shifts to fix', width: 12 },
    ],
    rows: rows.map((r) => [
      { v: nameOf(r.employee), s: 'bold' }, r.employee.title ?? '', { v: r.daysWorked, s: 'int' },
      hrs(r.reg), hrs(r.ot), hrs(r.dt), hrs(r.holiday), hrs(r.pto), hrs(r.sick),
      hrs(r.total), hrs(r.gross), hrs(r.lunch),
      r.mealFlags > 0 ? { v: r.mealFlags, s: 'warn' } : { v: 0, s: 'int' },
      r.needsFix > 0 ? { v: r.needsFix, s: 'bad' } : { v: 0, s: 'int' },
    ]),
    totals: [
      { v: `Total, ${rows.length} employees`, s: 'total' }, { v: null, s: 'total' }, { v: totals.daysWorked, s: 'total' },
      totalHrs(totals.reg), totalHrs(totals.ot), totalHrs(totals.dt),
      totalHrs(totals.holiday), totalHrs(totals.pto), totalHrs(totals.sick),
      totalHrs(totals.total), totalHrs(totals.gross), totalHrs(totals.lunch),
      { v: totals.mealFlags, s: 'total' }, { v: totals.needsFix, s: 'total' },
    ],
  };

  const daily: Sheet = {
    name: 'Daily Detail',
    title: 'Daily detail',
    subtitle: stamp,
    columns: [
      { header: 'Employee', width: 26 }, { header: 'Date', width: 12 }, { header: 'Day', width: 7 },
      { header: 'In', width: 11 }, { header: 'Lunch out', width: 11 }, { header: 'Lunch in', width: 11 }, { header: 'Out', width: 11 },
      { header: 'On site', width: 10 }, { header: 'Lunch', width: 9 }, { header: 'Worked', width: 9 },
      { header: 'ST', width: 9 }, { header: 'OT', width: 9 }, { header: 'DT', width: 9 },
      { header: 'Flags', width: 34 }, { header: 'Employee note', width: 30 },
    ],
    rows: rows.flatMap((r) =>
      r.days
        .filter((day) => day.shifts.length > 0)
        .map((day): CellInput[] => {
          const first = day.shifts[0];
          const lunch = first.lunches[0];
          const missing = day.flags.includes('missing_out');
          const note = day.shifts.map((s) => (s.mealNote ? MEAL_NOTE_LABEL[s.mealNote] : '')).filter(Boolean).join('; ');
          return [
            nameOf(r.employee), date(day.dayStart), fmtWeekday(day.dayStart),
            time(day.firstIn), time(lunch?.start.at), time(backFromLunchAt(lunch, now)),
            missing ? { v: 'MISSING', s: 'bad' } : day.open ? { v: 'On the clock', s: 'warn' } : time(day.lastOut),
            missing ? null : hrs(day.gross), missing ? null : hrs(day.lunch), missing ? null : hrs(day.paid),
            hrs(day.reg), hrs(day.ot), hrs(day.dt),
            day.flags.length ? { v: day.flags.map((f) => FLAG_LABEL[f]).join(', '), s: missing ? 'bad' : 'warn' } : '',
            note,
          ];
        }),
    ),
  };

  const paidLeave: Sheet = {
    name: 'Paid Leave',
    title: 'Paid leave',
    subtitle: `Holiday, PTO and sick hours in the period. Paid at straight time and never counted toward overtime. ${stamp}`,
    columns: [
      { header: 'Employee', width: 26 }, { header: 'Date', width: 12 }, { header: 'Day', width: 7 },
      { header: 'Type', width: 10 }, { header: 'Hours', width: 9 }, { header: 'Note', width: 36 }, { header: 'Entered by', width: 26 },
    ],
    rows: rows.flatMap((r) =>
      r.leave.map((entry): CellInput[] => [
        nameOf(r.employee), date(entry.day), fmtWeekday(entry.day), LEAVE_LABEL[entry.type],
        hrs(entry.hours), { v: entry.note ?? '', s: 'wrap' }, nameOf(employeeOf.get(entry.enteredBy)),
      ]),
    ),
  };

  const inPeriod = data.shifts
    .filter((s) => s.clockIn.at >= periodStart && s.clockIn.at < periodEnd)
    .sort((a, b) => a.clockIn.at - b.clockIn.at);

  const source = (punch: Punch): string => {
    if (punch.auto) return 'Automatic, 30 minutes after lunch start';
    if (!punch.geo) return 'Entered by supervisor';
    return punch.geo.mocked ? 'Simulated GPS' : punch.geo.source === 'demo' ? 'Demo GPS' : 'Phone GPS';
  };
  // A lunch end is written down when the lunch starts, so one still in the future is left out.
  const punchRow = (shift: Shift, label: string, punch?: Punch): CellInput[] | null =>
    punch && punch.at <= now
      ? [
          nameOf(employeeOf.get(shift.employeeId)), date(punch.at), time(punch.at), label,
          punch.geo ? (punch.geo.inside ? { v: 'Yes', s: 'ok' } : { v: 'No', s: 'bad' }) : '',
          feet(punch.geo?.distanceM), feet(punch.geo?.accuracyM),
          source(punch),
        ]
      : null;

  const punches: Sheet = {
    name: 'Punch Log',
    title: 'Punch log',
    subtitle: `Every punch with where the phone was. Lunch ends by itself 30 minutes after it starts, so a lunch end has no location. ${stamp}`,
    columns: [
      { header: 'Employee', width: 26 }, { header: 'Date', width: 12 }, { header: 'Time', width: 11 }, { header: 'Punch', width: 16 },
      { header: 'At the mine', width: 12 }, { header: 'Feet from mine pin', width: 14 }, { header: 'GPS accuracy (ft)', width: 14 }, { header: 'Source', width: 22 },
    ],
    rows: inPeriod.flatMap((shift) =>
      [
        punchRow(shift, 'Clock in', shift.clockIn),
        ...shift.lunches.flatMap((l) => [punchRow(shift, 'Lunch start', l.start), punchRow(shift, 'Lunch end', l.end)]),
        punchRow(shift, 'Clock out', shift.clockOut),
      ].filter((row): row is CellInput[] => row != null),
    ),
  };

  const flags: Sheet = {
    name: 'Flags For Review',
    title: 'Flags for review',
    subtitle: 'Lunch and punch exceptions for a supervisor to look at. Nothing here is paid or docked automatically.',
    columns: [
      { header: 'Employee', width: 26 }, { header: 'Date', width: 12 }, { header: 'Flag', width: 22 },
      { header: 'What it means', width: 62 }, { header: 'Employee note', width: 30 },
    ],
    rows: inPeriod.flatMap((shift) =>
      shiftFlags(shift, now).map((flag): CellInput[] => [
        nameOf(employeeOf.get(shift.employeeId)), date(shift.clockIn.at),
        { v: FLAG_LABEL[flag], s: flag === 'missing_out' ? 'bad' : 'warn' }, { v: FLAG_HELP[flag], s: 'wrap' },
        shift.mealNote ? MEAL_NOTE_LABEL[shift.mealNote] : '',
      ]),
    ),
  };

  return finish(`US-Mine-Payroll_${ymd(periodStart)}_to_${ymd(lastDay)}.xlsx`, [summary, daily, paidLeave, punches, flags]);
}

/** Safety records for a date range: pre-ops, Bad Order items, equipment use, MRFs and time on site. */
export function safetyReport(data: ReportData, from: number, to: number, now: number): Report {
  const employeeOf = new Map(data.employees.map((e) => [e.id, e]));
  const unitOf = new Map(data.equipment.map((e) => [e.id, e]));
  const mrfOf = new Map(data.mrfs.map((m) => [m.id, m]));
  const within = (ms: number) => ms >= from && ms < to;
  const lastDay = to - DAY;
  const stamp = `${fmtDayShort(from)} to ${fmtDayShort(lastDay)}, ${new Date(lastDay).getFullYear()}. Generated ${fmtDateTime(now)}.`;
  const describe = (id: string) => {
    const unit = unitOf.get(id);
    return unit ? `${unit.make} ${unit.model}` : 'Removed from fleet';
  };
  const resultCell = (i: Inspection): CellInput =>
    i.result === 'pass' ? { v: 'Passed', s: 'ok' } : i.result === 'defect' ? { v: 'Defect', s: 'warn' } : { v: 'Bad order', s: 'bad' };

  const inspections = data.inspections.filter((i) => within(i.submittedAt)).sort((a, b) => a.submittedAt - b.submittedAt);

  const preops: Sheet = {
    name: 'Pre-Op Inspections',
    title: 'Pre-operational inspections',
    subtitle: `Operator inspection before each unit is placed in operation on the shift (30 CFR 56.14100(a)). ${stamp}`,
    columns: [
      { header: 'Date', width: 12 }, { header: 'Time', width: 11 }, { header: 'Unit', width: 9 }, { header: 'Equipment', width: 26 },
      { header: 'Type', width: 14 }, { header: 'Operator', width: 24 }, { header: 'Meter', width: 11 }, { header: 'Work area', width: 14 },
      { header: 'Result', width: 12 }, { header: 'OK', width: 6 }, { header: 'BO', width: 6 }, { header: 'N/A', width: 6 },
      { header: 'MRF #', width: 8 }, { header: 'After a defect', width: 30 },
    ],
    rows: inspections.map((i) => {
      const unit = unitOf.get(i.equipmentId);
      const counts = countAnswers(i.answers);
      const mrf = i.mrfId ? mrfOf.get(i.mrfId) : undefined;
      return [
        date(i.submittedAt), time(i.submittedAt), { v: unit?.unit ?? '', s: 'bold' }, describe(i.equipmentId),
        unit ? CATEGORY_LABEL[unit.category] : '', nameOf(employeeOf.get(i.employeeId)), { v: i.meter, s: 'num2' }, i.area ?? '',
        resultCell(i), { v: counts.ok, s: 'int' }, counts.bo ? { v: counts.bo, s: 'bad' } : { v: 0, s: 'int' }, { v: counts.na, s: 'int' },
        mrf ? { v: mrf.number, s: 'int' } : null,
        i.decision === 'operate' ? 'Ran it after supervisor cleared it' : i.decision === 'parked' ? 'Parked it' : i.result === 'bad_order' ? 'Out of service' : '',
      ];
    }),
  };

  const defects: Sheet = {
    name: 'Bad Order Items',
    title: 'Bad Order items',
    subtitle: `Each defect found on a pre-op, with the standard it falls under. This is the record kept until the repair is made (30 CFR 56.14100(d)). ${stamp}`,
    columns: [
      { header: 'Date', width: 12 }, { header: 'Unit', width: 9 }, { header: 'Operator', width: 24 }, { header: 'Check', width: 34 },
      { header: 'What was wrong', width: 46 }, { header: 'MSHA', width: 20 }, { header: 'OSHA', width: 24 },
      { header: 'Unsafe to run', width: 13 }, { header: 'MRF #', width: 8 }, { header: 'MRF status', width: 13 },
    ],
    rows: inspections.flatMap((i) => {
      const unit = unitOf.get(i.equipmentId);
      if (!unit) return [];
      const template = templateFor(unit.category);
      const mrf = i.mrfId ? mrfOf.get(i.mrfId) : undefined;
      return i.answers
        .filter((a) => a.answer === 'bo')
        .map((a): CellInput[] => {
          const item = findItem(template, a.itemId);
          const hazard = isHazard(template, a);
          return [
            date(i.submittedAt), { v: unit.unit, s: 'bold' }, nameOf(employeeOf.get(i.employeeId)), item?.label ?? a.itemId,
            { v: a.note ?? '', s: 'wrap' }, standard(item?.cfr)?.cite ?? '', standard(item?.osha)?.cite ?? '',
            hazard ? { v: 'Yes', s: 'bad' } : 'No', mrf ? { v: mrf.number, s: 'int' } : null,
            mrf ? (mrf.status === 'completed' ? { v: 'Completed', s: 'ok' } : mrf.status === 'in_progress' ? { v: 'In progress', s: 'warn' } : { v: 'Open', s: 'bad' }) : { v: 'No MRF', s: 'bad' },
          ];
        });
    }),
  };

  const usage: Sheet = {
    name: 'Equipment Use',
    title: 'Equipment operating sheet',
    subtitle: `Who ran which unit, when, and the meter readings. ${stamp}`,
    columns: [
      { header: 'Date', width: 12 }, { header: 'Unit', width: 9 }, { header: 'Equipment', width: 26 }, { header: 'Operator', width: 24 },
      { header: 'Start', width: 11 }, { header: 'End', width: 11 }, { header: 'Hours in use', width: 12 },
      { header: 'Start meter', width: 12 }, { header: 'End meter', width: 12 }, { header: 'Meter used', width: 11 },
      { header: 'Fuel (gal)', width: 10 }, { header: 'Work area', width: 14 }, { header: 'Parked safe', width: 12 }, { header: 'Notes', width: 34 },
    ],
    rows: data.opLogs
      .filter((l) => within(l.startAt))
      .sort((a, b) => a.startAt - b.startAt)
      .map((l) => {
        const unit = unitOf.get(l.equipmentId);
        return [
          date(l.startAt), { v: unit?.unit ?? '', s: 'bold' }, describe(l.equipmentId), nameOf(employeeOf.get(l.employeeId)),
          time(l.startAt), l.endAt ? time(l.endAt) : { v: 'In use', s: 'warn' },
          l.endAt ? { v: Math.round(((l.endAt - l.startAt) / HOUR) * 100) / 100, s: 'num2' } : null,
          { v: l.startMeter, s: 'num2' }, l.endMeter != null ? { v: l.endMeter, s: 'num2' } : null,
          l.endMeter != null ? { v: Math.round((l.endMeter - l.startMeter) * 10) / 10, s: 'num2' } : null,
          l.fuelGal != null ? { v: l.fuelGal, s: 'num2' } : null, l.area ?? '', yesNo(l.endAt ? !!l.parkedSafely : undefined), { v: l.notes ?? '', s: 'wrap' },
        ];
      }),
  };

  const requests: Sheet = {
    name: 'Maintenance Requests',
    title: 'Maintenance requests (MRF)',
    subtitle: `Requests opened in the period, plus any older request still open. ${stamp}`,
    columns: [
      { header: 'MRF #', width: 8 }, { header: 'Opened', width: 20 }, { header: 'Unit', width: 9 }, { header: 'Equipment', width: 26 },
      { header: 'Requested by', width: 24 }, { header: 'Priority', width: 10 }, { header: 'Status', width: 13 }, { header: 'Tagged out', width: 11 },
      { header: 'Problem', width: 50 }, { header: 'Unit location', width: 26 }, { header: 'Completed', width: 20 },
      { header: 'Days open', width: 10 }, { header: 'Latest note', width: 46 },
    ],
    rows: data.mrfs
      .filter((m) => within(m.createdAt) || (m.status !== 'completed' && m.createdAt < to))
      .sort((a, b) => a.number - b.number)
      .map((m) => {
        const unit = unitOf.get(m.equipmentId);
        const done = m.history.find((h) => h.status === 'completed');
        const lastNote = [...m.history].reverse().find((h) => h.note)?.note ?? '';
        return [
          { v: m.number, s: 'int' }, { v: new Date(m.createdAt), s: 'datetime' }, { v: unit?.unit ?? '', s: 'bold' }, describe(m.equipmentId),
          nameOf(employeeOf.get(m.requestedBy)),
          m.priority === 'safety' ? { v: 'Safety', s: 'bad' } : m.priority === 'high' ? { v: 'High', s: 'warn' } : 'Routine',
          m.status === 'completed' ? { v: 'Completed', s: 'ok' } : m.status === 'in_progress' ? { v: 'In progress', s: 'warn' } : { v: 'Open', s: 'bad' },
          m.taggedOut ? (m.status === 'completed' ? 'Was tagged out' : { v: 'Yes', s: 'bad' }) : 'No',
          { v: m.description, s: 'wrap' }, m.location ?? '', done ? { v: new Date(done.at), s: 'datetime' } : null,
          { v: Math.round((((done?.at ?? now) - m.createdAt) / DAY) * 10) / 10, s: 'num2' }, { v: lastNote, s: 'wrap' },
        ];
      }),
  };

  const onSite: Sheet = {
    name: 'Time On Site',
    title: 'Time on site',
    subtitle: `When each person arrived, took lunch and left. ${stamp}`,
    columns: [
      { header: 'Employee', width: 26 }, { header: 'Date', width: 12 }, { header: 'Arrived', width: 11 }, { header: 'Lunch out', width: 11 },
      { header: 'Lunch in', width: 11 }, { header: 'Left', width: 13 }, { header: 'Hours on site', width: 13 }, { header: 'Left from the mine', width: 16 },
    ],
    rows: data.shifts
      .filter((s) => within(s.clockIn.at))
      .sort((a, b) => a.clockIn.at - b.clockIn.at)
      .map((s) => {
        const missing = shiftFlags(s, now).includes('missing_out');
        const lunch = s.lunches[0];
        return [
          nameOf(employeeOf.get(s.employeeId)), date(s.clockIn.at), time(s.clockIn.at), time(lunch?.start.at), time(backFromLunchAt(lunch, now)),
          s.clockOut ? time(s.clockOut.at) : missing ? { v: 'MISSING', s: 'bad' } : { v: 'On site now', s: 'ok' },
          missing ? null : hrs(shiftTotals(s, now).gross),
          s.clockOut?.geo ? (s.clockOut.geo.inside ? 'Yes' : { v: 'No', s: 'warn' }) : '',
        ];
      }),
  };

  return finish(`US-Mine-Safety-Log_${ymd(from)}_to_${ymd(lastDay)}.xlsx`, [preops, defects, usage, requests, onSite]);
}
