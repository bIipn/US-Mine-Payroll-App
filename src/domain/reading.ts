/**
 * A reading typed into a number box: equipment hours, an odometer, or gallons of fuel added. One rule for
 * every screen that takes one, and for the store, so whatever a keyboard sends is read the same way. On
 * Android the number pad is the keyboard's own, and React Native lets every key it has through, so a minus
 * sign, a space or a comma can reach the box; the iPhone's decimal pad has only digits and a point, or, on a
 * phone set to a region that writes 12,5 for twelve and a half, digits and a comma. So a reading is read by
 * the phone's own decimal mark, which the screens pass in (`useDecimalMark` in `src/services/decimalMark`);
 * with none given it is a point.
 */

/** The mark a phone writes between the whole units and the part: a point (12.5) or a comma (12,5). */
export type DecimalMark = '.' | ',';

/** The highest reading a meter shows: the most the company takes for a unit (readRecord, and the server's own check). */
export const READING_MAX = 10_000_000;

/** What to say of a meter reading that is not one. Its example has the phone's own mark, so its keyboard can type it. */
export const readingProblem = (mark: DecimalMark = '.') => `Enter the reading off the machine as a number, like 4250${mark}5.`;
/** What to say of gallons of fuel that are not a number. Left blank, there are none. */
export const gallonsProblem = (mark: DecimalMark = '.') => `Enter the gallons added as a number, like 12${mark}5, or leave it blank.`;

/** Digits with a point, if any: 4250.5, 12, 12. or .5. No sign, no exponent. */
const DIGITS = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
/** A comma between every three digits, ahead of any point: 1,000 or 10,000,000.5. */
const THOUSANDS = /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/** Whole units, as digits alone: 4250. */
const WHOLE = /^\d+$/;
/**
 * Whole units with one mark between every three digits, the same mark throughout: a point (1.000), a
 * space (10 000), or the no-break spaces a phone writes there. No thousand starts with a nought.
 */
const GROUPED = /^[1-9]\d{0,2}([.   ])\d{3}(?:\1\d{3})*$/;
/** What goes between thousands where a comma is the decimal point. */
const BETWEEN_THOUSANDS = /[.   ]/g;
/** A lone point with digits after it: 12.5 or .5. */
const POINT_PART = /^\d*\.\d+$/;

/** A reading typed where a point is the decimal mark, as a number's own text, or null when it is not one. */
function withPoint(typed: string): string | null {
  // 12,5 is twelve and a half where a comma is the decimal point; read as 125 it would go on the signed card
  // ten times over, so a comma anywhere but between thousands is asked again.
  if (typed.includes(',') && !THOUSANDS.test(typed)) return null;
  const text = typed.replace(/,/g, '');
  return DIGITS.test(text) ? text : null;
}

/**
 * A reading typed where a comma is the decimal mark, as a number's own text, or null when it is not one. A
 * single comma with digits after it is the decimal point (4250,5), and the whole units before it may be
 * grouped in threes by a point or a space (1.000,5, 10 000). With no comma, a lone point followed by digits
 * that do not group threes is the decimal point still (12.5), as a number pad with both keys may send it.
 */
function withComma(typed: string): string | null {
  const [whole, part, more] = typed.split(',');
  if (more !== undefined) return null;
  const units = (text: string) => (WHOLE.test(text) ? text : GROUPED.test(text) ? text.replace(BETWEEN_THOUSANDS, '') : null);
  if (part !== undefined) {
    if (!WHOLE.test(part)) return null;
    const read = whole === '' ? '0' : units(whole);
    return read === null ? null : `${read}.${part}`;
  }
  return units(whole) ?? (POINT_PART.test(whole) ? whole : null);
}

/**
 * A reading as typed, by the phone's decimal mark. Spaces at the ends are left out, and so is what goes
 * between thousands: a comma where the mark is a point (1,000), a point or a space where it groups threes
 * where the mark is a comma (1.000,5 or 10 000). Undefined when nothing is typed. NaN when what is typed is
 * not a reading: a minus sign, a letter, two decimal marks, more than a meter shows, or a mark or a space
 * that may be either (12 5 may be a gloved slip for 12,5, and 12,5 on a phone that writes 12.5 may be 125),
 * so it is asked again, not guessed.
 */
export function parseReading(typed: string, mark: DecimalMark = '.'): number | undefined {
  const trimmed = typed.trim();
  if (!trimmed) return undefined;
  const text = mark === ',' ? withComma(trimmed) : withPoint(trimmed);
  if (text === null) return Number.NaN;
  const n = Number(text);
  return isReading(n) ? n : Number.NaN;
}

/**
 * A reading written into a box for the person to keep or change, with the phone's decimal mark and nothing
 * between thousands, so it reads back as the same reading (`parseReading`): 4250.5, or 4250,5 where the
 * mark is a comma. Written with a point there, 100.125 hours would read back as 100125.
 */
export function readingText(n: number, mark: DecimalMark = '.'): string {
  return mark === ',' ? String(n).replace('.', ',') : String(n);
}

/** Whether a number is a reading a meter shows, or gallons that can be added: from 0 up to READING_MAX. */
export function isReading(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= READING_MAX;
}
