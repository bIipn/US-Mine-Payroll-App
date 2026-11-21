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

/**
 * Why a reading the app was allowed to take gave no position: location is off
 * for the whole phone, or it is on and found none. A phone that cannot say
 * whether it is on is taken to have found none.
 */
async function whyNoPosition(): Promise<NoLocation> {
  try {
    return (await Location.hasServicesEnabledAsync()) ? 'no_fix' : 'off';
  } catch {
    return 'no_fix';
  }
}

/**
 * One location reading, taken at the moment of a punch.
 *
 * The app asks only for "while using the app" permission and never tracks
 * anyone in the background: a position is read when a button is pressed,
 * stamped on that punch, and that is all. When the person allows only an
 * approximate location, no position is read at all: one that vague cannot be
 * checked against the boundary. With location off for the whole phone the
 * reading is still asked for, so the phone can offer its own one-tap switch
 * (Android does, as part of the reading); only once it fails does the answer
 * say location is off.
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
    // Turned down for the app (an iPhone with Location Services off says the same).
    if (permission.status !== Location.PermissionStatus.GRANTED) return { ok: false, reason: 'off' };
    // A browser asks as it reads: allowed, but with no position on that first try, it says granted: false.
    if (!permission.granted) return { ok: false, reason: 'no_fix' };
    // iPhone: Precise Location turned off. Android: approximate location only.
    if (permission.ios?.accuracy === 'reduced' || permission.android?.accuracy === 'coarse') {
      return { ok: false, reason: 'approximate' };
    }

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), GPS_TIMEOUT_MS));
    const reading = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      timeout,
    ]);
    const position = reading ?? (await Location.getLastKnownPositionAsync({ maxAge: 60_000 }));
    if (!position) return { ok: false, reason: await whyNoPosition() };

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
    return { ok: false, reason: await whyNoPosition() };
  }
}
