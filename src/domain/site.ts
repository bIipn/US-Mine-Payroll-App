import type { LatLng, SiteConfig } from './types';

/** Pin supplied by the crew, dropped on the mine in Maps. */
export const MINE_CENTER: LatLng = { lat: 38.33419, lng: -120.94551 };

/** Downtown Ione (Main St). Used only to show how far the boundary stays from town. */
export const IONE_TOWN_CENTER: LatLng = { lat: 38.3527, lng: -120.9327 };

/**
 * Default clock-in boundary.
 *
 * The Central Valley Water Board permit for the site (Order R5-2025-0042) puts
 * the US Mine Ione Plant about 1.25 miles south of Ione on a 3,570-acre
 * property, of which about 402 acres have been mined, built on or reclaimed,
 * all south of town and west of Highway 124. A circle the size of the whole
 * 3,570 acres centred on the pin would reach the south edge of town, so the
 * default covers the working area (about 776 acres, nearly double the active
 * footprint) and stays roughly 0.8 miles short of downtown.
 *
 * Supervisors can change the radius in the app. A surveyed property outline can
 * replace the circle by setting `polygon`.
 */
export const DEFAULT_RADIUS_M = 1000;
export const MIN_RADIUS_M = 200;
export const MAX_RADIUS_M = 2000;

export const PROPERTY_FACTS = {
  totalAcres: 3570,
  activeAcres: 402,
  milesSouthOfIone: 1.25,
  address: '8625 Highway 124, Ione, CA 95640',
  parcels: [
    '005-130-012', '005-130-033', '005-130-034', '005-130-051',
    '005-150-007', '005-150-008', '005-160-003',
  ],
  source: 'Central Valley Regional Water Quality Control Board, Order R5-2025-0042 (June 2025)',
};

export const DEFAULT_SITE: SiteConfig = {
  name: 'US Mine — Ione Plant',
  center: MINE_CENTER,
  radiusM: DEFAULT_RADIUS_M,
};
