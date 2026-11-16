import { buildPdf, textWidth, toWinAnsi, wrapText, type PdfSection } from '../pdf';

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** The objects a PDF's cross-reference table points at, read back the way a reader does. */
function xrefTargets(bytes: Uint8Array): string[] {
  const text = ascii(bytes);
  const start = Number(text.match(/startxref\s+(\d+)/)![1]);
  expect(text.slice(start, start + 4)).toBe('xref');
  const table = text.slice(start).split('\n');
  const count = Number(table[1].split(' ')[1]);
  const offsets = table.slice(3, 2 + count).map((line) => Number(line.slice(0, 10)));
  return offsets.map((offset) => text.slice(offset, offset + 12));
}

describe('toWinAnsi', () => {
  it('writes plain text as one byte a character', () => {
    expect([...toWinAnsi('Bad Order')]).toEqual([...'Bad Order'].map((c) => c.charCodeAt(0)));
  });

  it('keeps the typographer’s quotes, dashes and accents a reader can draw', () => {
    expect([...toWinAnsi('“Rest” – it’s café')]).toEqual([0x93, 0x52, 0x65, 0x73, 0x74, 0x94, 0x20, 0x96, 0x20, 0x69, 0x74, 0x92, 0x73, 0x20, 0x63, 0x61, 0x66, 0xe9]);
  });

  it('puts a question mark for a character the standard fonts do not have', () => {
    expect([...toWinAnsi('MM 🚜 ✓')]).toEqual([0x4d, 0x4d, 0x20, 0x3f, 0x20, 0x3f]);
  });
});

describe('textWidth and wrapText', () => {
  it('measures with the standard font metrics', () => {
    expect(textWidth('A', 'regular', 10)).toBeCloseTo(6.67, 2);
    expect(textWidth('A', 'bold', 10)).toBeCloseTo(7.22, 2);
  });

  it('wraps at spaces to fit a width, and breaks a word longer than the width', () => {
    const lines = wrapText('Brake pedal goes to the floor before it bites', 'regular', 10, 90);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 'regular', 10)).toBeLessThanOrEqual(90);
    expect(lines.join(' ')).toBe('Brake pedal goes to the floor before it bites');
    const long = wrapText('Supercalifragilisticexpialidocious', 'regular', 10, 40);
    expect(long.length).toBeGreaterThan(1);
    for (const line of long) expect(textWidth(line, 'regular', 10)).toBeLessThanOrEqual(40);
  });

  it('breaks a long run of words joined by slashes after a slash, not inside a word', () => {
    const lines = wrapText('Seatbelts/DROPS/FOPS', 'regular', 8.5, 60);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('Seatbelts/DROPS/FOPS');
    // Every line but the last ends at a slash, so no word is cut in two.
    expect(lines.slice(0, -1).every((line) => line.endsWith('/'))).toBe(true);
  });

  it('keeps line breaks written into the text', () => {
    expect(wrapText('one\ntwo', 'regular', 10, 500)).toEqual(['one', 'two']);
  });
});

describe('buildPdf', () => {
  const section = (rows: number): PdfSection => ({
    title: 'Equipment defects',
    note: 'Each Bad Order, kept until the repair is made.',
    columns: [
      { header: 'Date', width: 1 },
      { header: 'Unit', width: 1 },
      { header: 'What was wrong', width: 4 },
    ],
    rows: Array.from({ length: rows }, (_, i) => [`Nov ${(i % 28) + 1}`, `L-${i}`, `Defect number ${i}, described at some length so that it wraps onto a second line in the table.`]),
    empty: 'No defects in the period.',
  });

  it('writes a well-formed PDF whose cross-reference points at every object', () => {
    const bytes = buildPdf({ title: 'Records for MSHA', heading: ['Sample Mining Co.'], footer: 'Generated Nov 16, 2026, 1:42 PM', sections: [section(3)] });
    const text = ascii(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    xrefTargets(bytes).forEach((head, i) => expect(head.startsWith(`${i + 1} 0 obj`)).toBe(true));
    expect(text).toContain('/BaseFont /Helvetica');
    expect(text).toContain('/Encoding /WinAnsiEncoding');
  });

  it('flows a long table onto more pages, repeats the header, and numbers every page out of the total', () => {
    const bytes = buildPdf({ title: 'Records for MSHA', heading: ['Sample Mining Co.'], footer: 'Generated Nov 16, 2026', sections: [section(80)] });
    const text = ascii(bytes);
    const pages = Number(text.match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)![1]);
    expect(pages).toBeGreaterThan(2);
    expect(text).toContain(`(Page 1 of ${pages})`);
    expect(text).toContain(`(Page ${pages} of ${pages})`);
    expect(text.split('(What was wrong)').length - 1).toBe(pages);
    expect(text).toMatch(/\(Defect number 79, described[^)]*\)/);
  });

  it('says so when a section has nothing in it', () => {
    const text = ascii(buildPdf({ title: 'Records for MSHA', heading: [], footer: '', sections: [section(0)] }));
    expect(text).toContain('(No defects in the period.)');
  });

  it('escapes the characters PDF strings treat specially', () => {
    const text = ascii(buildPdf({ title: 'T', heading: ['Back\\slash (and brackets)'], footer: '', sections: [] }));
    expect(text).toContain('(Back\\\\slash \\(and brackets\\))');
  });
});
