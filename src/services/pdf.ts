import { PDF_WIDTHS } from './pdfMetrics';

/**
 * A small PDF writer for record sheets: a title, a few heading lines, then
 * sections, each a short note and a table that flows onto as many pages as it
 * needs, its header repeated on every page, and every page numbered out of the
 * total. Written by hand, as the Excel writer is, so it runs the same on a
 * phone with no signal, on the web and in tests.
 *
 * It uses the two standard fonts every PDF reader has built in (Helvetica and
 * Helvetica-Bold) in WinAnsiEncoding, so no font is embedded. A character
 * those fonts cannot draw becomes a question mark.
 */

export type PdfFont = 'regular' | 'bold';

export interface PdfColumn {
  header: string;
  /** Share of the table's width, against the other columns. */
  width: number;
}

export interface PdfSection {
  title: string;
  /** A short paragraph under the title: what the records are and the rule they answer to. */
  note?: string;
  columns: PdfColumn[];
  /** Cells as text; a line break in a cell starts a new line. */
  rows: string[][];
  /** Said in place of the table when there are no rows. */
  empty: string;
}

export interface PdfDocument {
  /** The document's title, at the top of the first page and in its properties. */
  title: string;
  /** Lines under the title: who the records are for, the period, when it was made. */
  heading: string[];
  /** At the foot of every page, beside "Page n of N". */
  footer: string;
  sections: PdfSection[];
  /** When the document was made, for its properties. */
  created?: number;
}

// Unicode characters with a place in WinAnsiEncoding outside Latin-1.
const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Text as WinAnsiEncoding bytes. Anything the standard fonts cannot draw becomes "?". */
export function toWinAnsi(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (code === 9) out.push(32);
    else if (code >= 32 && code < 127) out.push(code);
    else if (code >= 160 && code <= 255) out.push(code);
    else if (WIN_ANSI_EXTRA[code] != null) out.push(WIN_ANSI_EXTRA[code]);
    else out.push(63);
  }
  return Uint8Array.from(out);
}

/** The width of a line of text, in points. */
export function textWidth(text: string, font: PdfFont, size: number): number {
  const widths = PDF_WIDTHS[font];
  let total = 0;
  for (const byte of toWinAnsi(text)) total += widths[byte - 32] ?? 0;
  return (total * size) / 1000;
}

/** Text broken into lines no wider than `width`: at spaces where it can, inside a word where it must. */
export function wrapText(text: string, font: PdfFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // A word longer than the whole width is broken after the last slash that fits ("Seatbelts/DROPS/"),
      // or else where it reaches the edge.
      let rest = word;
      while (textWidth(rest, font, size) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && textWidth(rest.slice(0, cut), font, size) > width) cut -= 1;
        const slash = rest.lastIndexOf('/', cut - 1);
        if (slash > 0) cut = slash + 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

// ---- Page layout: US Letter on its side, half-inch margins --------------------------------------

const PAGE_W = 792;
const PAGE_H = 612;
const MARGIN = 36;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const FOOT_Y = 22;
const BOTTOM = 44; // nothing but the footer goes below this
const CELL = 8.5;
const CELL_LEAD = 10.5;
const PAD = 3.5;

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** A PDF literal string from WinAnsi bytes, with the characters PDF treats specially escaped. */
function literal(text: string): string {
  let out = '';
  for (const byte of toWinAnsi(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else out += String.fromCharCode(byte);
  }
  return `(${out})`;
}

class Page {
  ops: string[] = [];
  text(x: number, y: number, value: string, font: PdfFont, size: number, gray = 0) {
    this.ops.push(`BT ${fmt(gray)} g /${font === 'bold' ? 'F2' : 'F1'} ${fmt(size)} Tf 1 0 0 1 ${fmt(x)} ${fmt(y)} Tm ${literal(value)} Tj ET`);
  }
  fill(x: number, y: number, w: number, h: number, gray: number) {
    this.ops.push(`${fmt(gray)} g ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f`);
  }
  line(x1: number, y1: number, x2: number, y2: number, gray: number, width = 0.5) {
    this.ops.push(`${fmt(gray)} G ${fmt(width)} w ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S`);
  }
}

/** The layout of a table's columns: where each starts and how wide its text may run. */
function columnsOf(columns: PdfColumn[]) {
  const total = columns.reduce((sum, c) => sum + c.width, 0) || 1;
  let x = MARGIN;
  return columns.map((c) => {
    const w = (CONTENT_W * c.width) / total;
    const col = { x, w, text: w - 2 * PAD };
    x += w;
    return col;
  });
}

function layout(doc: PdfDocument): Page[] {
  const pages: Page[] = [];
  let page = new Page();
  pages.push(page);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = new Page();
    pages.push(page);
    y = PAGE_H - MARGIN;
  };

  // Title and heading, on the first page only.
  page.text(MARGIN, y - 18, doc.title, 'bold', 18);
  y -= 26;
  for (const line of doc.heading) {
    for (const part of wrapText(line, 'regular', 10, CONTENT_W)) {
      page.text(MARGIN, y - 10, part, 'regular', 10, 0.2);
      y -= 13;
    }
  }
  y -= 8;

  for (const section of doc.sections) {
    const cols = columnsOf(section.columns);
    const noteLines = section.note ? wrapText(section.note, 'regular', 8.5, CONTENT_W) : [];
    const headerLines = section.columns.map((c, i) => wrapText(c.header, 'bold', CELL, cols[i].text));
    const headerH = Math.max(1, ...headerLines.map((l) => l.length)) * CELL_LEAD + 2 * PAD;

    const sectionTitle = (continued: boolean) => {
      page.text(MARGIN, y - 13, continued ? `${section.title} (continued)` : section.title, 'bold', 13);
      y -= 19;
    };
    const header = () => {
      page.fill(MARGIN, y - headerH, CONTENT_W, headerH, 0.9);
      headerLines.forEach((lines, i) =>
        lines.forEach((l, k) => page.text(cols[i].x + PAD, y - PAD - CELL - k * CELL_LEAD + 1.5, l, 'bold', CELL)),
      );
      y -= headerH;
    };

    // Keep a section's title with its note and at least the table header and one row.
    if (y - 19 - noteLines.length * 11 - headerH - 2 * CELL_LEAD < BOTTOM) newPage();
    else y -= 6;
    sectionTitle(false);
    for (const l of noteLines) {
      page.text(MARGIN, y - 8.5, l, 'regular', 8.5, 0.3);
      y -= 11;
    }
    y -= 5;

    if (section.rows.length === 0) {
      page.text(MARGIN, y - 10, section.empty, 'regular', 10, 0.3);
      y -= 18;
      continue;
    }

    header();
    for (const row of section.rows) {
      const cells = row.map((value, i) => wrapText(value ?? '', 'regular', CELL, cols[i]?.text ?? 0));
      const rowH = Math.max(1, ...cells.map((l) => l.length)) * CELL_LEAD + 2 * PAD;
      if (y - rowH < BOTTOM) {
        newPage();
        sectionTitle(true);
        header();
      }
      cells.forEach((lines, i) =>
        lines.forEach((l, k) => page.text(cols[i].x + PAD, y - PAD - CELL - k * CELL_LEAD + 1.5, l, 'regular', CELL)),
      );
      y -= rowH;
      page.line(MARGIN, y, MARGIN + CONTENT_W, y, 0.75);
    }
    y -= 10;
  }
  return pages;
}

/** "D:20261116134200-08'00'": a PDF date in local time with its offset from UTC. */
function pdfDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}'${pad(abs % 60)}'`;
}

/** The document as PDF bytes. */
export function buildPdf(doc: PdfDocument): Uint8Array {
  const pages = layout(doc);
  pages.forEach((page, i) => {
    page.line(MARGIN, FOOT_Y + 11, PAGE_W - MARGIN, FOOT_Y + 11, 0.75);
    if (doc.footer) page.text(MARGIN, FOOT_Y, doc.footer, 'regular', 8, 0.35);
    const label = `Page ${i + 1} of ${pages.length}`;
    page.text(PAGE_W - MARGIN - textWidth(label, 'regular', 8), FOOT_Y, label, 'regular', 8, 0.35);
  });

  // Objects: 1 catalog, 2 page tree, 3 and 4 fonts, 5 document information, then a page and its content stream for each page.
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objects.push(`<< /Title ${literal(doc.title)} /Producer (MineMuster)${doc.created != null ? ` /CreationDate (${pdfDate(doc.created)})` : ''} >>`);
  pages.forEach((page, i) => {
    const stream = page.ops.join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  // Every character in the file is one byte, so a string's length is its length in bytes.
  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
