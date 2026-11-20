import * as Location from 'expo-location';

import { DEMO_MODE } from '../config';
import { destination, type RawFix } from '../domain/geofence';
import { awayFromSite } from '../domain/site';
import type { DemoLocation, GeoStamp, NoLocation, SiteConfig } from '../domain/types';

/** A position, or why the phone gave none (`NoLocation`): location off, approximate only, or no fix. */
export type LocateResult =
  | { ok: true; fix: RawFix; source: GeoStamp['source'] }
  | { ok: false; reason: NoLocation };

const GPS_TIMEOUT_MS = 15_000;

/** Whether Location Services are on for the whole phone. A phone that cannot say is taken to have them on. */
async function servicesOn(): Promise<boolean> {
  try {
    return await Location.hasServicesEnabledAsync();
  } catch {
    return true;
  }
}

/**
 * One location reading, taken at the moment of a punch.
 *
 * The app asks only for "while using the app" permission and never tracks
 * anyone in the background: a position is read when a button is pressed,
 * stamped on that punch, and that is all. When the person allows only an
 * approximate location, no position is read at all: one that vague cannot be
 * checked against the boundary.
 */
export async function locate(site: SiteConfig | null, setting: DemoLocation): Promise<LocateResult> {
  // Simulated GPS is for a preview only. A build that keeps real records reads the phone's own,
  // whatever a preview once left in the settings on this device.
  const demo: DemoLocation = DEMO_MODE ? setting : 'gps';
  // With no site set there is nowhere for the preview to pretend to be, so the phone's own GPS is read.
  if (site && demo === 'at_mine') {
    // A spot by the plant, a little off the pin, as a phone would report it.
    const jitter = (Date.now() % 40) - 20;
    return { ok: true, source: 'demo', fix: { ...destination(site.center, 90 + jitter, -60), accuracyM: 6 } };
  }
  if (site && demo === 'in_town') {
    return { ok: true, source: 'demo', fix: { ...awayFromSite(site), accuracyM: 8 } };
  }

  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: 'off' };
    // iPhone: Precise Location turned off. Android: approximate location only.
    if (permission.ios?.accuracy === 'reduced' || permission.android?.accuracy === 'coarse') {
      return { ok: false, reason: 'approximate' };
    }
    if (!(await servicesOn())) return { ok: false, reason: 'off' };

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), GPS_TIMEOUT_MS));
    const reading = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      timeout,
    ]);
    const position = reading ?? (await Location.getLastKnownPositionAsync({ maxAge: 60_000 }));
    if (!position) return { ok: false, reason: 'no_fix' };

    return {
      ok: true,
      source: 'gps',
      fix: {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracyM: position.coords.accuracy,
        mocked: position.mocked,
      },
    };
  } catch {
    return { ok: false, reason: 'no_fix' };
  }
}
