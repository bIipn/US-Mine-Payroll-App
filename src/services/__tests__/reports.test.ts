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
});
