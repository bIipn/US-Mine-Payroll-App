import { startOfDay } from './format';

/**
 * Read a typed clock time ("2:45 PM", "2:45p", "245pm", "14:45") as a time on
 * the given day. Returns null when it cannot be read, or when a 12-hour time is
 * missing AM/PM.
 */
export function parseTime(text: string, day: number): number | null {
  const match = text.trim().toLowerCase().replace(/\./g, '').match(/^(\d{1,2})(?::?(\d{2}))?\s*(a|p)?m?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const half = match[3];
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    if (half === 'a') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour < 13 || hour > 23) {
    // "2:45" could be morning or afternoon; make the person say which.
    return null;
  }
  const d = new Date(startOfDay(day));
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}
