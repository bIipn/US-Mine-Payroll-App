import { fmtMeter } from '../util/format';

/**
 * A number typed into a box with a decimal pad: equipment hours, an odometer, gallons of fuel added, and the
 * other boxes that take a part (hours of paid leave, the time spent on a maintenance request, an hourly
 * rate). One rule for every screen that takes one, and for the store, so whatever a keyboard sends is read
 * the same way. On Android the number pad is the keyboard's own, and React Native lets every key it has
 * through, so a minus sign, a space or a comma can reach the box; the iPhone's decimal pad has only digits
 * and a point, or, on a phone set to a region that writes 12,5 for twelve and a half, digits and a comma. So
 * a number is read by the phone's own decimal mark, which the screens pass in (`useDecimalMark` in
 * `src/services/decimalMark`); with none given it is a point. Each box keeps its own range and rounding.
 */

/** The mark a phone writes between the whole units and the part: a point (12.5) or a comma (12,5). */
export type DecimalMark = '.' | ',';

/** The highest reading a meter shows: the most the company takes for a unit (readRecord, and the server's own check). */
export const READING_MAX = 10_000_000;

/** What to say of a meter reading that is not one. Its example has the phone's own mark, so its keyboard can type it. */
export const readingProblem = (mark: DecimalMark = '.') => `Enter the reading off the machine as a number, like 4250${mark}5.`;
/** What to say of gallons of fuel that are not a number. Left blank, there are none. */
export const gallonsProblem = (mark: DecimalMark = '.') => `Enter the gallons added as a number, like 12${mark}5, or leave it blank.`;

/** What to say of an hourly rate that is not one, as the store turns it back. */
export const rateProblem = (mark: DecimalMark = '.') => `Enter your hourly rate in dollars, like 24${mark}00.`;
/** What to say of hours of paid leave that are not hours of one day, as the store turns them back. */
export const leaveHoursProblem = (mark: DecimalMark = '.') => `Enter the hours for that day, between 0${mark}25 and 24.`;
/** What to say of the time spent on a maintenance request that is not a number of hours. Left blank, there is none. */
export const timeSpentProblem = (mark: DecimalMark = '.') => `Enter the time spent in hours, like 1${mark}5.`;

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

/** A number typed where a point is the decimal mark, as a number's own text, or null when it is not one. */
function withPoint(typed: string): string | null {
  // 12,5 is twelve and a half where a comma is the decimal point; read as 125 it would go on the signed card
  // ten times over, so a comma anywhere but between thousands is asked again.
  if (typed.includes(',') && !THOUSANDS.test(typed)) return null;
  const text = typed.replace(/,/g, '');
  return DIGITS.test(text) ? text : null;
}

/**
 * A number typed where a comma is the decimal mark, as a number's own text, or null when it is not one. A
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
 * A number as typed, by the phone's decimal mark, with no range of its own: each box keeps its own. Spaces
 * at the ends are left out, and so is what goes between thousands: a comma where the mark is a point
 * (1,000), a point or a space where it groups threes where the mark is a comma (1.000,5 or 10 000).
 * Undefined when nothing is typed. NaN when what is typed is not a number: a minus sign, a letter, an
 * exponent, two decimal marks, or a mark or a space that may be either (12 5 may be a gloved slip for 12,5,
 * and 12,5 on a phone that writes 12.5 may be 125), so it is asked again, not guessed.
 */
export function parseDecimal(typed: string, mark: DecimalMark = '.'): number | undefined {
  const trimmed = typed.trim();
  if (!trimmed) return undefined;
  const text = mark === ',' ? withComma(trimmed) : withPoint(trimmed);
  if (text === null) return Number.NaN;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * A reading as typed, by the phone's decimal mark (`parseDecimal`). Undefined when nothing is typed. NaN
 * when what is typed is not a number, or is more than a meter shows.
 */
export function parseReading(typed: string, mark: DecimalMark = '.'): number | undefined {
  const n = parseDecimal(typed, mark);
  return n === undefined || isReading(n) ? n : Number.NaN;
}

/** A dollar sign ahead of an amount or after it, with spaces beside it: $24.50, $ 24.50, 24,50 $. */
const DOLLAR_SIGN = /^\$\s*|\s*\$$/;

/**
 * Dollars as typed into the hourly rate, by the phone's decimal mark (`parseDecimal`): 24.50, or 24,50 where
 * the mark is a comma, with one dollar sign ahead of the amount or after it. Every place typed is kept, for
 * the store to round to the cent. Undefined when nothing is typed; NaN when it is not an amount, so 9,75 on
 * a phone that writes a point is asked again, never saved as $975.00 an hour.
 */
export function parseDollars(typed: string, mark: DecimalMark = '.'): number | undefined {
  const trimmed = typed.trim();
  if (!trimmed) return undefined;
  const amount = trimmed.replace(DOLLAR_SIGN, '');
  if (amount.includes('$')) return Number.NaN;
  return parseDecimal(amount, mark) ?? Number.NaN;
}

/**
 * A number's own text (8.00, 24.50, 1.5) written with the phone's decimal mark, for a box the person keeps
 * or changes or for its example, so it reads back as the same number (`parseDecimal`): 8,00 where the mark
 * is a comma.
 */
export function withMark(text: string, mark: DecimalMark = '.'): string {
  return mark === ',' ? text.replace('.', ',') : text;
}

/**
 * A reading written into a box for the person to keep or change, with the phone's decimal mark and nothing
 * between thousands, so it reads back as the same reading (`parseReading`): 4250.5, or 4250,5 where the
 * mark is a comma. Written with a point there, 100.125 hours would read back as 100125.
 */
export function readingText(n: number, mark: DecimalMark = '.'): string {
  return withMark(String(n), mark);
}

/**
 * A reading shown beside the box it is typed into, as `fmtMeter` writes it, to a tenth, but with the phone's
 * decimal mark: 4,250.5, or 4 250,5 where the mark is a comma, with a space that does not break between
 * thousands, since a point there could be taken for the decimal mark. It reads back as the same reading
 * (`parseReading`). The card, the exports and the PDF keep `fmtMeter` and its point.
 */
export function meterText(n: number, mark: DecimalMark = '.'): string {
  const shown = fmtMeter(n);
  return mark === ',' ? shown.replace(/,/g, '\u00a0').replace('.', ',') : shown;
}

/** Whether a number is a reading a meter shows, or gallons that can be added: from 0 up to READING_MAX. */
export function isReading(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= READING_MAX;
}
