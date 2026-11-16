/**
 * Date and number formatting. Written without Intl so output is identical on
 * iOS, Android, web and in tests. All dates are shown in the device's local time.
 */

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** 6:42 AM */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Parts of a live clock: ["6:42", "18", "AM"] */
export function clockParts(ms: number): { hm: string; sec: string; ampm: string } {
  const d = new Date(ms);
  const h = d.getHours();
  return {
    hm: `${h % 12 === 0 ? 12 : h % 12}:${pad(d.getMinutes())}`,
    sec: pad(d.getSeconds()),
    ampm: h < 12 ? 'AM' : 'PM',
  };
}

/** Fri, Nov 13 */
export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Friday, November 13 */
export function fmtDateLong(ms: number): string {
  const d = new Date(ms);
  return `${DAYS_LONG[d.getDay()]}, ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}`;
}

/** Nov 13 */
export function fmtDayShort(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Fri */
export function fmtWeekday(ms: number): string {
  return DAYS[new Date(ms).getDay()];
}

/** Nov 13, 6:42 AM */
export function fmtDateTime(ms: number): string {
  return `${fmtDayShort(ms)}, ${fmtTime(ms)}`;
}

/** Today / Yesterday / Fri, Nov 13 */
export function fmtRelativeDay(ms: number, now: number): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return fmtDate(ms);
}

/** 2026-11-13 in local time. */
export function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar-aware day shift, so daylight-saving changes never drift the date. */
export function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Start of the workweek containing `ms`. `startsOn` 0 = Sunday. */
export function startOfWeek(ms: number, startsOn: number): number {
  const d = new Date(startOfDay(ms));
  const back = (d.getDay() - startsOn + 7) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** Nov 8 – Nov 14 */
export function fmtRange(startMs: number, endMsInclusive: number): string {
  return `${fmtDayShort(startMs)} – ${fmtDayShort(endMsInclusive)}`;
}

/** 4h 12m (or 12m under an hour) */
export function fmtDur(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MIN));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${pad(m)}m`;
}

/** Countdown 17:46 */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/**
 * Minutes to hundredths of an hour, the way the crew fills in a timesheet:
 * 5 min = .08, 10 = .17, 15 = .25, 20 = .33, 25 = .42, 30 = .50,
 * 35 = .58, 40 = .67, 45 = .75, 50 = .83, 55 = .92, 60 = 1.00.
 * Returned as a whole number of hundredths (765 min -> 1275) so that
 * timesheet figures always add up exactly.
 */
export function toHundredths(minutes: number): number {
  return Math.round((minutes * 100) / 60);
}

/** Hundredths of an hour as timesheet text: 1225 -> "12.25". */
export function fmtHrs(hundredths: number): string {
  return (hundredths / 100).toFixed(2);
}

/** The minute column of the timesheet conversion chart: 45 -> ".75". */
export function minuteDecimal(minutes: number): string {
  const h = toHundredths(minutes);
  return h >= 100 ? fmtHrs(h) : `.${h < 10 ? `0${h}` : h}`;
}

/** 12h 45m, always showing hours, for the worked-example line on a shift. */
export function fmtHM(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}h ${pad(total % 60)}m`;
}

/** Distances the way the crew talks about them: feet up close, miles further out. */
export function fmtDistance(metres: number): string {
  const feet = metres * 3.28084;
  if (feet < 1000) return `${Math.round(feet / 5) * 5} ft`;
  const miles = metres / 1609.344;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

export function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

export function fullName(p: { firstName: string; lastName: string }): string {
  return `${p.firstName} ${p.lastName}`;
}

/** J. Rivera */
export function shortName(p: { firstName: string; lastName: string }): string {
  return `${p.firstName.charAt(0)}. ${p.lastName}`;
}

/** "1 person", "2 people". */
export function peopleCount(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

export function greeting(ms: number): string {
  const h = new Date(ms).getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** 1,284.5 */
export function fmtMeter(n: number): string {
  const fixed = (Math.round(n * 10) / 10).toFixed(1);
  const [whole, frac] = fixed.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/** An hourly rate in cents: 2400 -> "$24.00". A half cent is kept: 3637.5 -> "$36.375". */
export function fmtRate(cents: number): string {
  return Number.isInteger(cents) ? fmtMoney(cents) : `$${(cents / 100).toFixed(3)}`;
}

/** Whole cents as dollars: 123456 -> "$1,234.56". */
export function fmtMoney(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${whole}.${pad(Math.abs(cents) % 100)}`;
}
