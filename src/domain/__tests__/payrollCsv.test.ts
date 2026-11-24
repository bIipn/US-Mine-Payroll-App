import { computePayroll } from '../payroll';
import { DEFAULT_PAY_CODES, payrollCsv, toCsv } from '../payrollCsv';
import { CA_RULES } from '../time';
import type { Employee, LeaveEntry, Shift } from '../types';

const day = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const stamp = (at: number) => ({ at, geo: undefined });
const shift = (id: string, employeeId: string, d: number, inH: number, outH: number): Shift =>
  ({ id, employeeId, clockIn: stamp(day(d, inH)), clockOut: stamp(day(d, outH)), lunches: [{ start: stamp(day(d, 11)), end: stamp(day(d, 11, 30)) }], breaks: [] }) as unknown as Shift;

const people: Employee[] = [
  { id: 'a', firstName: 'Avery', lastName: 'Quill', role: 'employee', active: true, payrollId: '000123' },
  { id: 'b', firstName: 'Blake', lastName: 'Rook, Jr.', role: 'employee', active: true },
];
// Mon Nov 2 to Fri Nov 6, 6 AM to 7 PM less a 0.50 lunch: 12.50 paid a day for Avery.
const shifts = [2, 3, 4, 5, 6].map((d) => shift(`s${d}`, 'a', d, 6, 19));
const leave: LeaveEntry[] = [{ id: 'lv', employeeId: 'b', day: day(4, 0), type: 'pto', hours: 800 } as LeaveEntry];
const start = day(1, 0);
const end = day(16, 0);
const rows = computePayroll(people, shifts, leave, start, end, day(16, 9), { weekStartsOn: 0, rules: CA_RULES });

describe('the payroll hours file', () => {
  it('has one line a person, a day and a kind of hours, with the person’s payroll ID and the company’s codes', () => {
    const lines = payrollCsv(rows, DEFAULT_PAY_CODES, 'day', { start, end });
    expect(lines[0]).toEqual(['Employee ID', 'Last name', 'First name', 'Date', 'Earning code', 'Hours']);
    const avery = lines.filter((l) => l[1] === 'Quill');
    // Each day: 8 straight, 4 overtime, 0.50 double after 12 in California.
    expect(avery.filter((l) => l[3] === '2026-11-02')).toEqual([
      ['000123', 'Quill', 'Avery', '2026-11-02', 'REG', '8.00'],
      ['000123', 'Quill', 'Avery', '2026-11-02', 'OT', '4.00'],
      ['000123', 'Quill', 'Avery', '2026-11-02', 'DT', '0.50'],
    ]);
    expect(lines.filter((l) => l[1] === 'Rook, Jr.')).toEqual([['', 'Rook, Jr.', 'Blake', '2026-11-04', 'PTO', '8.00']]);
  });

  it('adds up to the same hours as payroll, in hundredths', () => {
    const lines = payrollCsv(rows, DEFAULT_PAY_CODES, 'day', { start, end }).slice(1);
    const sum = (code: string) => lines.filter((l) => l[4] === code).reduce((n, l) => n + Math.round(Number(l[5]) * 100), 0);
    const total = (k: 'reg' | 'ot' | 'dt' | 'pto') => rows.reduce((n, r) => n + r[k], 0);
    expect(sum('REG')).toBe(total('reg'));
    expect(sum('OT')).toBe(total('ot'));
    expect(sum('DT')).toBe(total('dt'));
    expect(sum('PTO')).toBe(total('pto'));
  });

  it('can give one line a person and a kind of hours for the whole period', () => {
    const lines = payrollCsv(rows, { ...DEFAULT_PAY_CODES, regular: 'R', overtime: 'O' }, 'period', { start, end });
    expect(lines[0]).toEqual(['Employee ID', 'Last name', 'First name', 'Period start', 'Period end', 'Earning code', 'Hours']);
    expect(lines.slice(1).filter((l) => l[1] === 'Quill')).toEqual([
      ['000123', 'Quill', 'Avery', '2026-11-01', '2026-11-15', 'R', '40.00'],
      ['000123', 'Quill', 'Avery', '2026-11-01', '2026-11-15', 'O', '20.00'],
      ['000123', 'Quill', 'Avery', '2026-11-01', '2026-11-15', 'DT', '2.50'],
    ]);
  });

  it('never carries a pay rate or an amount of money', () => {
    const text = toCsv(payrollCsv(rows, DEFAULT_PAY_CODES, 'period', { start, end }));
    expect(text).not.toMatch(/\$|rate|cents/i);
  });
});

describe('toCsv', () => {
  it('writes plain CSV: quotes only where needed, doubled quotes, and a line ending a spreadsheet expects', () => {
    expect(toCsv([['a', 'b, c', 'say "hi"'], ['1', '', 'two\nlines']])).toBe('a,"b, c","say ""hi"""\r\n1,,"two\nlines"\r\n');
  });

  it('keeps a spreadsheet from reading a typed name as a formula', () => {
    expect(toCsv([['=SUM(A1)', '+1', '-x', '@me']])).toBe("'=SUM(A1),'+1,'-x,'@me\r\n");
    // After a tab or spaces, which some importers trim, and in full-width forms.
    expect(toCsv([['\t=HYPERLINK("x")', '  =1+1', '\u3000@me', '\uFF1DSUM(A1)', '\uFF0B1', '\uFF0D1', '\uFF20me']])).toBe(
      '"\'\t=HYPERLINK(""x"")",\'  =1+1,\'\u3000@me,\'\uFF1DSUM(A1),\'\uFF0B1,\'\uFF0D1,\'\uFF20me\r\n',
    );
    // A field that starts with a tab or a carriage return at all.
    expect(toCsv([['\tName', '\rName']])).toBe('\'\tName,"\'\rName"\r\n');
    // Ordinary names, codes and hours are left alone.
    expect(toCsv([['O\'Neil', 'Ortiz-Lee', 'REG', '8.00', ' Sam']])).toBe("O'Neil,Ortiz-Lee,REG,8.00, Sam\r\n");
  });
});
