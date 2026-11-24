import { destination, haversineM } from './geofence';
import type { LatLng, SiteConfig } from './types';

/**
 * The clock-in boundary is a setting: a pin on the mine with a circle around
 * it, or a surveyed outline. A build names its company's site in
 * EXPO_PUBLIC_COMPANY (`site`); a supervisor moves the pin and sizes the
 * circle on More → Mine boundary. No mine's location is written into the code.
 */

export const DEFAULT_RADIUS_M = 1000;
export const MIN_RADIUS_M = 200;
export const MAX_RADIUS_M = 2000;

/** Round numbers in open desert: made up for the sample company, not modelled on any mine. */
const SAMPLE_PIN: LatLng = { lat: 39.5, lng: -116.5 };

/** The made-up site of the made-up Sample Mining Co., with a town about a mile and a half off for reference. */
export const SAMPLE_SITE: SiteConfig = {
  name: 'Sample Mining Co. pit',
  center: SAMPLE_PIN,
  radiusM: DEFAULT_RADIUS_M,
  town: { name: 'Sample town', center: destination(SAMPLE_PIN, 800, 2250) },
};

/**
 * Where the preview puts a phone that is away from the mine: in the site's
 * town, or for a site with none, a mile past the edge of the boundary.
 */
export function awayFromSite(site: SiteConfig): LatLng {
  return site.town?.center ?? destination(site.center, 0, site.radiusM + 1609);
}

/** How far the town is from the pin, and from the edge of the boundary. Nothing for a site with no town. */
export function townGap(site: SiteConfig): { name: string; distanceM: number; gapM: number } | undefined {
  if (!site.town) return undefined;
  const distanceM = haversineM(site.center, site.town.center);
  return { name: site.town.name, distanceM, gapM: distanceM - site.radiusM };
}
