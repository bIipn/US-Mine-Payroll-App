import { strFromU8, unzipSync } from 'fflate';

import { COMPANY } from '../../config';
import { payPeriodOf } from '../../domain/payPeriod';
import { buildDemoData } from '../../store/seed';
import { addDays, startOfWeek } from '../../util/format';
import { payrollReport } from '../reports';

const now = new Date(2026, 10, 13, 10, 42).getTime();

/** Every piece of text on one worksheet, by the sheet's position in the workbook. */
function sheetText(bytes: Uint8Array, index: number): string[] {
  const xml = strFromU8(unzipSync(bytes)[`xl/worksheets/sheet${index}.xml`]);
  return [...xml.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((match) => match[1]);
}

describe('payroll report', () => {
  const data = buildDemoData(now);
  const period = payPeriodOf(now);
  const report = payrollReport(data, { start: period.start, end: period.end, payDate: period.payDate }, now);

  it('is headed with the company name the way the pay stub prints it', () => {
    expect(COMPANY).toBe('U.S. Mine Corp.');
    expect(sheetText(report.bytes, 1)[0]).toBe('U.S. Mine Corp. payroll summary');
  });

  it('says which pay period it covers and when it is paid', () => {
    const subtitle = sheetText(report.bytes, 1)[1];
    expect(subtitle).toContain('Pay period Nov 1 to Nov 15, 2026.');
    expect(subtitle).toContain('Pay date Fri, Nov 20, 2026.');
  });

  it('gives no pay date for a plain workweek', () => {
    const week = startOfWeek(now, 0);
    const subtitle = sheetText(payrollReport(data, { start: week, end: addDays(week, 7) }, now).bytes, 1)[1];
    expect(subtitle).toContain('Period Nov 8 to Nov 14, 2026.');
    expect(subtitle).not.toContain('Pay date');
  });

  it('lists paid leave on its own sheet, with who entered it', () => {
    const text = sheetText(report.bytes, 3);
    expect(text[0]).toBe('Paid leave');
    expect(text).toEqual(expect.arrayContaining(['Cole, Hannah', 'PTO', 'Nakamura, Sam', 'Sick', 'Morgan, Casey']));
  });

  describe('punch log', () => {
    // Columns: A employee, B date, C time, D punch, E at the mine, F feet from pin, G accuracy, H source.
    const punches = sheetRows(report.bytes, 4).filter((row) => typeof row.D === 'string' && row.D !== 'Punch');
    const ends = punches.filter((row) => row.D === 'Lunch end');
    const count = (name: string, punch: string) => punches.filter((row) => row.A === name && row.D === punch).length;

    it('shows the end of every lunch as automatic, with no location read', () => {
      expect(ends.length).toBeGreaterThan(50);
      for (const row of ends) {
        expect(row.H).toBe('Automatic, 30 minutes after lunch start');
        expect(row.E).toBeUndefined();
        expect(row.F).toBeUndefined();
      }
    });

    it('leaves out the end of a lunch that is still going', () => {
      // Sam Nakamura started lunch 14 minutes before the report was made.
      expect(count('Nakamura, Sam', 'Lunch start')).toBe(count('Nakamura, Sam', 'Lunch end') + 1);
      expect(count('Bell, Marcus', 'Lunch start')).toBe(count('Bell, Marcus', 'Lunch end'));
    });
  });
});

/** The cells of each row on a worksheet, keyed by column letter. */
function sheetRows(bytes: Uint8Array, index: number): Record<string, string | number>[] {
  const xml = strFromU8(unzipSync(bytes)[`xl/worksheets/sheet${index}.xml`]);
  return [...xml.matchAll(/<row [^>]*>(.*?)<\/row>/g)].map(([, cells]) => {
    const row: Record<string, string | number> = {};
    for (const [, column, body] of cells.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(.*?)<\/c>)/g)) {
      const text = body?.match(/<t [^>]*>([^<]*)<\/t>/);
      const number = body?.match(/<v>([^<]*)<\/v>/);
      if (text) row[column] = text[1];
      else if (number) row[column] = Number(number[1]);
    }
    return row;
  });
}
