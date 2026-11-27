/**
 * A reading typed into a number box: equipment hours, an odometer, or gallons of fuel added. One rule for
 * every screen that takes one, and for the store, so whatever a keyboard sends is read the same way. On
 * Android the number pad is the keyboard's own, and React Native lets every key it has through, so a minus
 * sign, a space or a comma can reach the box; the iPhone's decimal pad has only digits and a point, or, on a
 * phone set to a region that writes 12,5 for twelve and a half, digits and a comma.
 */

/** The highest reading a meter shows: the most the company takes for a unit (readRecord, and the server's own check). */
export const READING_MAX = 10_000_000;

/** What to say of a meter reading that is not one. Its example has a point, for someone who typed a comma for one. */
export const READING_PROBLEM = 'Enter the reading off the machine as a number, like 4250.5.';
/** What to say of gallons of fuel that are not a number. Left blank, there are none. */
export const GALLONS_PROBLEM = 'Enter the gallons added as a number, like 12.5, or leave it blank.';

/** Digits with a point, if any: 4250.5, 12, 12. or .5. No sign, no exponent. */
const DIGITS = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
/** A comma between every three digits, ahead of any point: 1,000 or 10,000,000.5. */
const THOUSANDS = /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/**
 * A reading as typed. Spaces at the ends and commas between thousands ("1,000") are left out. Undefined
 * when nothing is typed. NaN when what is typed is not a reading: a minus sign, a space between digits
 * (12 000 may be 12000, and 12 5 a gloved slip for 12.5, so it is asked again, not guessed), a comma
 * anywhere but between thousands (12,5 is twelve and a half where a comma is the decimal point, and read
 * as 125 it would go on the signed card ten times over), a letter, two points, or more than a meter shows.
 */
export function parseReading(typed: string): number | undefined {
  const trimmed = typed.trim();
  if (trimmed.includes(',') && !THOUSANDS.test(trimmed)) return Number.NaN;
  const text = trimmed.replace(/,/g, '');
  if (!text) return undefined;
  if (!DIGITS.test(text)) return Number.NaN;
  const n = Number(text);
  return isReading(n) ? n : Number.NaN;
}

/** Whether a number is a reading a meter shows, or gallons that can be added: from 0 up to READING_MAX. */
export function isReading(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= READING_MAX;
}
