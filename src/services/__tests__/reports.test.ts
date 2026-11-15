import { strFromU8, unzipSync } from 'fflate';

import { COMPANY } from '../../config';
import { payPeriodOf } from '../../domain/payPeriod';
import { checklistFor } from '../../domain/templates';
import { buildDemoData } from '../../store/seed';
import { addDays, startOfDay, startOfWeek } from '../../util/format';
import { payrollReport, safetyReport } from '../reports';

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

describe('safety report', () => {
  const data = buildDemoData(now);
  const to = addDays(startOfDay(now), 1);
  const report = safetyReport(data, addDays(to, -30), to, now);

  it('has a sheet for each paper form', () => {
    const workbook = strFromU8(unzipSync(report.bytes)['xl/workbook.xml']);
    expect([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1])).toEqual([
      'Equipment Checklists', 'Bad Order Items', 'Equipment Use', 'Pre Shift Exams',
      'Exam Conditions', 'Exam Lines', 'Maintenance Requests', 'Time On Site',
    ]);
  });

  it('lays each equipment checklist out with the 21 lines of the card as columns', () => {
    const head = headers(report.bytes, 1);
    const lines = checklistFor('loader').items.map((i) => i.label);
    expect(head.slice(0, 10)).toEqual(['Date', 'Time', 'Employee', '#', 'Unit', 'Equipment', 'Type', 'Equp. hrs st', 'Equp. hrs end', 'Gallons added']);
    expect(head.slice(10, 31)).toEqual(lines);
    expect(head.slice(31)).toEqual(['Result', 'MRF #', 'After a defect', 'Comments']);

    const rows = table(report.bytes, 1);
    expect(rows).toHaveLength(data.inspections.length);
    // Lines that do not apply to a machine are N/A, as the legend on the card says.
    const dozer = rows.find((r) => r.Unit === 'D-03')!;
    expect([dozer['Fire extinguisher'], dozer['Tires/nuts / pressure'], dozer['Bed condition']]).toEqual(['OK', 'N/A', 'N/A']);
    const tagged = rows.find((r) => r.Unit === 'EX-09')!;
    expect([tagged['Seatbelts/DROPS/FOPS'], tagged.Result, tagged['MRF #']]).toEqual(['BO', 'Bad order', 1043]);
    // "#" is the unit's column on that person's card for the day.
    const herrera = rows.filter((r) => r.Employee === 'Herrera, Luis').slice(-2);
    expect(herrera.map((r) => [r['#'], r.Unit])).toEqual([[1, 'EX-09'], [2, 'EX-07']]);
  });

  it('lists every pre shift exam with who made it, and every line of each one', () => {
    const exams = table(report.bytes, 4);
    expect(headers(report.bytes, 4)).toEqual(['Date', 'Shift', 'Area', 'Examined by', 'Time', 'Lines', 'OK', 'Bad Order', 'N/A', 'Still open', 'Result']);
    expect(exams).toHaveLength(data.exams.length);
    expect(exams[exams.length - 1]).toMatchObject({ Shift: 'Day', Area: 'Lab', 'Examined by': 'Ruiz, Angela', Lines: 27, 'N/A': 6, Result: 'Clear' });

    const lines = table(report.bytes, 6);
    expect(lines).toHaveLength(data.exams.reduce((sum, exam) => sum + exam.rows.length + exam.conditions.length, 0));
    expect(headers(report.bytes, 6)).toEqual(['Date', 'Shift', 'Area', 'Examined by', 'Page', 'Line', 'Guarding', 'Electrical', 'Safe access', 'Result', 'Notes', 'Date fixed']);
  });

  it('lists each condition found, with the date it was fixed once there is one', () => {
    const found = table(report.bytes, 5);
    expect(found.map((r) => [r.Area, r.Line, r['Found in'], r['MRF #'], r.Status])).toEqual([
      ['Wash plant', 'Ground conditions', 'Conditions', undefined, 'Fixed'],
      ['Lab', 'Fire extinguishers', 'Conditions', undefined, 'Open'],
      ['Wash plant', 'Slurry pump 3', 'Guarding', 1044, 'Open'],
    ]);
    expect(found.map((r) => typeof r['Date fixed'])).toEqual(['number', 'undefined', 'undefined']);
    expect(found[0]).toMatchObject({ 'What was done': 'Rolled up the hose and hung it on the rack', 'Fixed by': 'Whitfield, Dana' });
    expect(found[2].MSHA).toBe('30 CFR § 56.14107');
  });

  it('gives each maintenance request the fields of the paper form', () => {
    expect(headers(report.bytes, 7)).toEqual([
      'MRF #', 'Date', 'By', 'Location', 'Unit', 'Problem', 'Priority', 'Status', 'Red tagged',
      'Assigned to', 'Date completed', 'Time spent (hrs)', 'Completed by', 'Remarks', 'Days open',
    ]);
    const rows = table(report.bytes, 7);
    const done = rows.find((r) => r['MRF #'] === 1041)!;
    expect([done.Unit, done['Assigned to'], done['Completed by'], done['Time spent (hrs)'], done.Remarks]).toEqual([
      'HT-21', 'Brooks, Tyler', 'Brooks, Tyler', 2.25, 'Replaced backup alarm and tested in reverse. Returned to service.',
    ]);
    const fromExam = rows.find((r) => r['MRF #'] === 1044)!;
    expect([fromExam.By, fromExam.Location, fromExam.Unit, fromExam.Status]).toEqual(['Whitfield, Dana', 'Wash plant: Slurry pump 3', undefined, 'Open']);
  });
});

/** The column headings of a worksheet, left to right. */
function headers(bytes: Uint8Array, index: number): (string | number)[] {
  return Object.values(sheetRows(bytes, index)[2]);
}

/** The rows under the headings, keyed by heading. */
function table(bytes: Uint8Array, index: number): Record<string, string | number | undefined>[] {
  const [, , head, ...rows] = sheetRows(bytes, index);
  return rows.map((row) => Object.fromEntries(Object.entries(head).map(([column, name]) => [name, row[column]])));
}

/** The cells of each row on a worksheet, keyed by column letter. */
function sheetRows(bytes: Uint8Array, index: number): Record<string, string | number>[] {
  const xml = strFromU8(unzipSync(bytes)[`xl/worksheets/sheet${index}.xml`]);
  return [...xml.matchAll(/<row [^>]*>(.*?)<\/row>/g)].map(([, cells]) => {
    const row: Record<string, string | number> = {};
    for (const [, column, body] of cells.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(.*?)<\/c>)/g)) {
      const text = body?.match(/<t [^>]*>([^<]*)<\/t>/);
      const number = body?.match(/<v>([^<]*)<\/v>/);
      // Text is escaped in the file: "&" is written "&amp;".
      if (text) row[column] = text[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      else if (number) row[column] = Number(number[1]);
    }
    return row;
  });
}
