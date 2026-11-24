import { ymd } from '../util/format';
import type { EmployeePayroll } from './payroll';

/**
 * The payroll hours file: the hours a payroll system's own import reads, one
 * kind of hours to a line, with each person's payroll ID and the company's own
 * earning codes. It is plain CSV so that the import of the company's payroll
 * system can map its columns. It holds hours only, before taxes: never a rate
 * or an amount of money.
 *
 * It is made from the same payroll as the Excel export, so the two agree to the
 * hundredth: overtime is figured over whole workweeks, a shift with no
 * clock-out counts nothing, and paid leave has lines of its own.
 */

/** The code the company's payroll system uses for each kind of hours. */
export interface PayCodes {
  regular: string;
  overtime: string;
  double: string;
  holiday: string;
  pto: string;
  sick: string;
}

export const DEFAULT_PAY_CODES: PayCodes = { regular: 'REG', overtime: 'OT', double: 'DT', holiday: 'HOL', pto: 'PTO', sick: 'SICK' };

/** One line a person a day and a kind of hours, or one line a person and a kind of hours for the whole period. */
export type PayrollCsvLayout = 'day' | 'period';

/** Hundredths of an hour as hours with two places: 1225 -> "12.25". */
const hours = (hundredths: number) => `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;

const KINDS = ['regular', 'overtime', 'double', 'holiday', 'pto', 'sick'] as const;

export function payrollCsv(rows: EmployeePayroll[], codes: PayCodes, layout: PayrollCsvLayout, range: { start: number; end: number }): string[][] {
  const lastDay = range.end - 86_400_000;
  const head = ['Employee ID', 'Last name', 'First name'];
  const out: string[][] = [
    layout === 'day' ? [...head, 'Date', 'Earning code', 'Hours'] : [...head, 'Period start', 'Period end', 'Earning code', 'Hours'],
  ];
  for (const r of rows) {
    const who = [r.employee.payrollId ?? '', r.employee.lastName, r.employee.firstName];
    if (layout === 'period') {
      const amounts = { regular: r.reg, overtime: r.ot, double: r.dt, holiday: r.holiday, pto: r.pto, sick: r.sick };
      for (const kind of KINDS) if (amounts[kind] > 0) out.push([...who, ymd(range.start), ymd(lastDay), codes[kind], hours(amounts[kind])]);
      continue;
    }
    // By day: hours worked from the days, paid leave from its entries, in date order.
    const byDay = new Map<number, Record<(typeof KINDS)[number], number>>();
    const at = (dayStart: number) => {
      let line = byDay.get(dayStart);
      if (!line) byDay.set(dayStart, (line = { regular: 0, overtime: 0, double: 0, holiday: 0, pto: 0, sick: 0 }));
      return line;
    };
    for (const d of r.days) {
      if (!d.reg && !d.ot && !d.dt) continue;
      const line = at(d.dayStart);
      line.regular += d.reg;
      line.overtime += d.ot;
      line.double += d.dt;
    }
    for (const entry of r.leave) at(entry.day)[entry.type] += entry.hours;
    for (const dayStart of [...byDay.keys()].sort((a, b) => a - b)) {
      const line = byDay.get(dayStart)!;
      for (const kind of KINDS) if (line[kind] > 0) out.push([...who, ymd(dayStart), codes[kind], hours(line[kind])]);
    }
  }
  return out;
}

/**
 * A field a spreadsheet could read as a formula: one that starts with = + - or
 * @, in their full-width forms too, after any spaces, or that starts with a tab
 * or a carriage return (OWASP's list for CSV injection).
 */
const FORMULA = /^(?:[\t\r]|[\s\u3000]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/;

/**
 * Rows as CSV: commas, quotes only where a field needs them, CRLF line ends.
 * A field that starts like a formula gets a leading apostrophe, so a
 * spreadsheet that opens the file shows the text instead of running it.
 */
export function toCsv(rows: string[][]): string {
  const field = (value: string) => {
    const safe = FORMULA.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((row) => row.map(field).join(',')).join('\r\n') + '\r\n';
}
