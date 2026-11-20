import type { GeoStamp, LatLng, NoLocation, SiteConfig } from './types';

const EARTH_RADIUS_M = 6_371_008.8;
const SQ_M_PER_ACRE = 4046.8564224;

/** A fix worse than this is too vague to trust for a punch. */
export const MAX_ACCURACY_M = 200;
/** How much of the reported GPS error counts in the employee's favour at the edge. */
export const EDGE_TOLERANCE_M = 50;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** East/north offset of `p` from `origin`, in metres. Accurate at site scale. */
export function offsetM(origin: LatLng, p: LatLng): { east: number; north: number } {
  return {
    east: rad(p.lng - origin.lng) * EARTH_RADIUS_M * Math.cos(rad(origin.lat)),
    north: rad(p.lat - origin.lat) * EARTH_RADIUS_M,
  };
}

/** The point `east`/`north` metres away from `origin`. */
export function destination(origin: LatLng, east: number, north: number): LatLng {
  return {
    lat: origin.lat + (north / EARTH_RADIUS_M) * (180 / Math.PI),
    lng: origin.lng + (east / (EARTH_RADIUS_M * Math.cos(rad(origin.lat)))) * (180 / Math.PI),
  };
}

/** Ray-casting point-in-polygon on a flat projection around the first vertex. */
export function pointInPolygon(p: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;
  const origin = polygon[0];
  const pt = offsetM(origin, p);
  const verts = polygon.map((v) => offsetM(origin, v));
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const a = verts[i];
    const b = verts[j];
    const crosses = a.north > pt.north !== b.north > pt.north;
    if (crosses && pt.east < ((b.east - a.east) * (pt.north - a.north)) / (b.north - a.north) + a.east) {
      inside = !inside;
    }
  }
  return inside;
}

export interface RawFix extends LatLng {
  accuracyM: number | null;
  mocked?: boolean;
}

export type FixVerdict = 'inside' | 'outside' | 'weak_gps' | 'mocked';

export interface FixCheck {
  verdict: FixVerdict;
  distanceM: number;
  /** Positive = this far inside the boundary; negative = this far outside. */
  marginM: number;
}

/**
 * Decide whether a GPS fix counts as "at the mine".
 * Spoofed fixes and fixes too vague to trust are rejected outright.
 */
export function checkFix(site: SiteConfig, fix: RawFix): FixCheck {
  const distanceM = haversineM(site.center, fix);
  const marginM = site.radiusM - distanceM;
  if (fix.mocked) return { verdict: 'mocked', distanceM, marginM };
  if (fix.accuracyM != null && fix.accuracyM > MAX_ACCURACY_M) {
    return { verdict: 'weak_gps', distanceM, marginM };
  }
  const tolerance = Math.min(fix.accuracyM ?? 0, EDGE_TOLERANCE_M);
  const inside = site.polygon ? pointInPolygon(fix, site.polygon) : distanceM <= site.radiusM + tolerance;
  return { verdict: inside ? 'inside' : 'outside', distanceM, marginM };
}

export function toGeoStamp(site: SiteConfig, fix: RawFix, source: GeoStamp['source']): GeoStamp {
  const check = checkFix(site, fix);
  return {
    lat: fix.lat,
    lng: fix.lng,
    accuracyM: fix.accuracyM,
    distanceM: Math.round(check.distanceM),
    inside: check.verdict === 'inside',
    mocked: fix.mocked || undefined,
    source,
  };
}

/** Why a clock-in made with a position is turned down. */
export type TurnDown = Exclude<FixVerdict, 'inside'>;

/**
 * Why a clock-in at this stamped position is turned down: outside the
 * boundary, simulated, or too vague to trust. Nothing when it may go through.
 */
export function turnDownOf(geo: GeoStamp): TurnDown | undefined {
  if (geo.mocked) return 'mocked';
  if (geo.inside) return undefined;
  return geo.accuracyM != null && geo.accuracyM > MAX_ACCURACY_M ? 'weak_gps' : 'outside';
}

/** What the phone gave for a punch: a position, or why it has none. */
export type Reading = { fix: RawFix; source: GeoStamp['source'] } | { none: NoLocation };

export type ClockInVerdict =
  | { ok: true; geo: GeoStamp }
  | { ok: true; noLocation: NoLocation }
  | { ok: false; kind: TurnDown; geo: GeoStamp };

/**
 * Whether a clock-in goes through. A position the phone gives has to be inside
 * the boundary, and not simulated or too vague to trust; one that is not is
 * turned down, with where it was, to be logged. With no position at all
 * (location off, only an approximate location, or no fix) the clock-in goes
 * through with none, flagged for a supervisor to review: it is never turned
 * down for want of a location.
 */
export function clockInVerdict(site: SiteConfig, reading: Reading): ClockInVerdict {
  if ('none' in reading) return { ok: true, noLocation: reading.none };
  const geo = toGeoStamp(site, reading.fix, reading.source);
  const kind = turnDownOf(geo);
  return kind ? { ok: false, kind, geo } : { ok: true, geo };
}

export function circleAcres(radiusM: number): number {
  return (Math.PI * radiusM * radiusM) / SQ_M_PER_ACRE;
}
