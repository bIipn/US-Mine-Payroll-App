import { strToU8, zipSync } from 'fflate';

/**
 * A small .xlsx writer: styled header rows, frozen panes, filters, number and
 * date formats, and status colours. Pure JavaScript, so the same code builds
 * workbooks on iOS, Android and the web without a server.
 */

export type StyleKey =
  | 'text' | 'header' | 'title' | 'subtitle' | 'bold' | 'num2' | 'int'
  | 'date' | 'time' | 'datetime' | 'ok' | 'bad' | 'warn' | 'total' | 'totalNum' | 'wrap' | 'muted';

export type CellValue = string | number | Date | null | undefined;
export interface Cell {
  v: CellValue;
  s?: StyleKey;
}
export type CellInput = CellValue | Cell;

export interface Column {
  header: string;
  /** Width in characters. */
  width: number;
}

export interface Sheet {
  name: string;
  title: string;
  subtitle?: string;
  columns: Column[];
  rows: CellInput[][];
  totals?: CellInput[];
}

const STYLE_INDEX: Record<StyleKey, number> = {
  text: 0, header: 1, title: 2, subtitle: 3, bold: 4, num2: 5, int: 6, date: 7, time: 8,
  datetime: 9, ok: 10, bad: 11, warn: 12, total: 13, totalNum: 14, wrap: 15, muted: 16,
};

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="m/d/yyyy\\ h:mm\\ AM/PM"/></numFmts>
<fonts count="8">
<font><sz val="11"/><color rgb="FF12161C"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF12161C"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="16"/><color rgb="FF12161C"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF5B6472"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF16833F"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFC8281E"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF8A4B00"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="7">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1B212B"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE3F4E9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFCE9E7"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF0D9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F3EF"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E5DF"/></bottom><diagonal/></border>
<border><left/><right/><top style="medium"><color rgb="FF1B212B"/></top><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="17">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="2" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="14" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="18" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="7" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="6" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="2" fontId="1" fillId="6" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 -> A, 25 -> Z, 26 -> AA */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Excel serial number for a date shown in the device's local time. */
export function excelSerial(date: Date): number {
  return (date.getTime() - date.getTimezoneOffset() * 60_000) / 86_400_000 + 25_569;
}

/** Excel limits sheet names to 31 characters and forbids []:*?/\ */
export function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
}

function isCell(input: CellInput): input is Cell {
  return typeof input === 'object' && input !== null && !(input instanceof Date);
}

function cellXml(ref: string, input: CellInput, fallback?: StyleKey): string {
  const value = isCell(input) ? input.v : input;
  let style = (isCell(input) ? input.s : undefined) ?? fallback;
  if (value == null || value === '') {
    return style ? `<c r="${ref}" s="${STYLE_INDEX[style]}"/>` : '';
  }
  if (value instanceof Date) {
    style = style ?? 'datetime';
    return `<c r="${ref}" s="${STYLE_INDEX[style]}"><v>${excelSerial(value)}</v></c>`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    style = style ?? 'text';
    return `<c r="${ref}" s="${STYLE_INDEX[style]}"><v>${value}</v></c>`;
  }
  style = style ?? 'text';
  return `<c r="${ref}" s="${STYLE_INDEX[style]}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function rowXml(rowNumber: number, cells: CellInput[], opts: { height?: number; fallback?: StyleKey } = {}): string {
  const body = cells.map((cell, i) => cellXml(`${columnLetter(i)}${rowNumber}`, cell, opts.fallback)).join('');
  const height = opts.height ? ` ht="${opts.height}" customHeight="1"` : '';
  return `<row r="${rowNumber}"${height}>${body}</row>`;
}

const HEADER_ROW = 4;

function sheetXml(sheet: Sheet, first: boolean): string {
  const lastCol = columnLetter(sheet.columns.length - 1);
  const rows: string[] = [
    rowXml(1, [{ v: sheet.title, s: 'title' }], { height: 26 }),
    rowXml(2, [{ v: sheet.subtitle ?? '', s: 'subtitle' }], { height: 18 }),
    rowXml(HEADER_ROW, sheet.columns.map((c) => ({ v: c.header, s: 'header' as StyleKey })), { height: 30 }),
  ];
  let r = HEADER_ROW + 1;
  for (const row of sheet.rows) rows.push(rowXml(r++, row, { height: 20 }));
  if (sheet.totals) {
    const padded = sheet.columns.map((_, i) => sheet.totals?.[i] ?? { v: null, s: 'total' as StyleKey });
    rows.push(rowXml(r++, padded, { height: 22, fallback: 'total' }));
  }
  const lastDataRow = Math.max(HEADER_ROW, HEADER_ROW + sheet.rows.length);
  const cols = sheet.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`)
    .join('');
  return `${XML_HEAD}<worksheet xmlns="${NS_MAIN}">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ''} showGridLines="0"><pane ySplit="${HEADER_ROW}" topLeftCell="A${HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${rows.join('')}</sheetData>
<autoFilter ref="A${HEADER_ROW}:${lastCol}${lastDataRow}"/>
<mergeCells count="2"><mergeCell ref="A1:${lastCol}1"/><mergeCell ref="A2:${lastCol}2"/></mergeCells>
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

/** Build a complete .xlsx file. */
export function buildWorkbook(sheets: Sheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet.');
  const used = new Set<string>();
  const names = sheets.map((sheet) => {
    const base = sheetName(sheet.name);
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${base.slice(0, 28)} ${n++}`;
    used.add(name.toLowerCase());
    return name;
  });

  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

  const rootRels = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">
<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">
<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews>
<sheets>${names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;

  const workbookRels = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>
</Relationships>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
    'xl/styles.xml': strToU8(STYLES_XML),
  };
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet, i === 0));
  });
  return zipSync(files, { level: 6 });
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
