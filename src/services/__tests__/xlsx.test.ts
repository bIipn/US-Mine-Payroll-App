import { strFromU8, unzipSync } from 'fflate';

import { buildWorkbook, columnLetter, excelSerial, sheetName } from '../xlsx';

const sheet = (name: string) => ({
  name,
  title: 'Title & <more>',
  subtitle: 'Sub',
  columns: [{ header: 'Name', width: 20 }, { header: 'Hours', width: 10 }, { header: 'Day', width: 12 }],
  rows: [
    ['Rivera, Jordan', { v: 12.25, s: 'num2' as const }, { v: new Date(2026, 10, 13), s: 'date' as const }],
    ['O"Brien <x>', { v: 8, s: 'num2' as const }, null],
  ],
  totals: [{ v: 'Total', s: 'total' as const }, { v: 20.25, s: 'totalNum' as const }],
});

describe('xlsx writer', () => {
  it('names columns the way Excel does', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('writes local dates as Excel serial numbers', () => {
    expect(excelSerial(new Date(2026, 10, 13))).toBe(46339);
    expect(excelSerial(new Date(2026, 10, 13, 12, 0))).toBe(46339.5);
  });

  it('keeps sheet names legal', () => {
    expect(sheetName('Pre-Op: Inspections/All [2026]*?')).toBe('Pre-Op  Inspections All  2026');
    expect(sheetName('x'.repeat(40))).toHaveLength(31);
    expect(sheetName('  ')).toBe('Sheet');
  });

  it('builds a workbook with every required part', () => {
    const files = unzipSync(buildWorkbook([sheet('Hours'), sheet('Hours'), sheet('Other')]));
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ]);
    const workbook = strFromU8(files['xl/workbook.xml']);
    // Two sheets asked for the same name; Excel refuses duplicates.
    expect(workbook).toContain('name="Hours"');
    expect(workbook).toContain('name="Hours 2"');
    expect(strFromU8(files['[Content_Types].xml'])).toContain('/xl/worksheets/sheet3.xml');
  });

  it('writes numbers, dates and escaped text, with a frozen filtered header', () => {
    const xml = strFromU8(unzipSync(buildWorkbook([sheet('Hours')]))['xl/worksheets/sheet1.xml']);
    expect(xml).toContain('<v>12.25</v>');
    expect(xml).toContain('<v>46339</v>');
    expect(xml).toContain('Title &amp; &lt;more&gt;');
    expect(xml).toContain('O&quot;Brien &lt;x&gt;');
    expect(xml).toContain('<pane ySplit="4" topLeftCell="A5"');
    expect(xml).toContain('<autoFilter ref="A4:C6"/>');
    expect(xml).toContain('<mergeCell ref="A1:C1"/>');
    // header row 4, two data rows, then the totals row
    expect(xml.match(/<row r="/g)).toHaveLength(6);
    expect(xml).toContain('<row r="7"');
  });

  it('refuses an empty workbook', () => {
    expect(() => buildWorkbook([])).toThrow();
  });
});
