/**
 * The app's shared code counts days, workweeks and pay periods in the local
 * time zone of the device it runs on. In the office that is this computer's.
 * When it is not the company's, the dashboard says so.
 */

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Minutes ahead of UTC in a zone at a moment, or undefined for a zone this browser does not know. */
export function offsetIn(zone: string, at: number): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000);
  } catch {
    return undefined;
  }
}

/** Whether two zones keep the same clock all year: same name, or the same offset in winter and in summer. */
export function sameClock(a: string, b: string, year: number): boolean {
  if (a === b) return true;
  const moments = [Date.UTC(year, 0, 15, 12), Date.UTC(year, 6, 15, 12)];
  return moments.every((at) => {
    const x = offsetIn(a, at);
    return x !== undefined && x === offsetIn(b, at);
  });
}
