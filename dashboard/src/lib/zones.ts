import { browserZone } from './timezone';

/** The time zones a US mine keeps, by the name people use for them, with the browser's own first when it is another. */
export const US_ZONES: { value: string; label: string }[] = [
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Detroit', label: 'Eastern (Detroit)' },
  { value: 'America/Indiana/Indianapolis', label: 'Eastern (Indianapolis)' },
  { value: 'America/Kentucky/Louisville', label: 'Eastern (Louisville)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Boise', label: 'Mountain (Boise)' },
  { value: 'America/Phoenix', label: 'Arizona, no daylight saving (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'America/Juneau', label: 'Alaska (Juneau)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
];

export function zoneChoices(): { value: string; label: string }[] {
  const mine = browserZone();
  if (US_ZONES.some((z) => z.value === mine)) return US_ZONES;
  return [{ value: mine, label: `${mine.replace(/_/g, ' ')} (this computer)` }, ...US_ZONES];
}

/** A time zone by the name people use for it: "Eastern (New York)", or its own name with spaces. */
export function zoneLabel(zone: string): string {
  return US_ZONES.find((z) => z.value === zone)?.label ?? zone.replace(/_/g, ' ');
}
