import * as Location from 'expo-location';
import { Platform } from 'react-native';

import { DEMO_MODE } from '../config';
import { destination, type RawFix } from '../domain/geofence';
import { awayFromSite } from '../domain/site';
import type { DemoLocation, GeoStamp, NoLocation, SiteConfig } from '../domain/types';

/** A position, or why the phone gave none (`NoLocation`): location off, approximate only, or no fix. */
export type LocateResult =
  | { ok: true; fix: RawFix; source: GeoStamp['source'] }
  | { ok: false; reason: NoLocation };

/** How long the GPS has to give a position once the reading is asked for. */
const GPS_TIMEOUT_MS = 15_000;
/**
 * How long Android's own "turn on location" prompt can go unanswered with the app in front. The app's timers
 * stand still while the prompt is up, so a person reading it is never hurried: this is only so no punch waits on
 * a prompt the phone never answers.
 */
const SWITCH_ANSWER_MS = 60_000;

/** What a screen can add to a reading. */
export interface LocateOptions {
  /**
   * Android only, and only before the phone first asks for location: say why the app reads it, and resolve once
   * that is read. Android's own prompt has no room for the app's reason; an iPhone's shows it.
   */
  beforeAsking?: () => Promise<void>;
}

/** What `promise` gives, or `late` once `ms` have passed. The clock is stopped either way. */
async function within<T, L>(ms: number, promise: Promise<T>, late: L): Promise<T | L> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<L>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  try {
    return await Promise.race([promise, timeUp]);
  } finally {
    clearTimeout(timer);
  }
}

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
 * Whether a phone may still ask whether the app can read its location: on
 * Android, one that has never asked. A phone that cannot say is not asked about.
 */
async function neverAsked(): Promise<boolean> {
  try {
    return (await Location.getForegroundPermissionsAsync()).status === Location.PermissionStatus.UNDETERMINED;
  } catch {
    return false;
  }
}

/**
 * Android, with location off for the whole phone: offer the phone's own
 * one-tap switch, and wait for the answer. Says whether location is on now.
 * The prompt is settled before the reading starts, so the time spent on it
 * never comes off the GPS's 15 seconds; and the reading itself never shows it.
 */
async function switchedOn(): Promise<boolean> {
  const on = () => Location.hasServicesEnabledAsync().catch(() => true);
  if (await on()) return true;
  await within(SWITCH_ANSWER_MS, Location.enableNetworkProviderAsync().catch(() => undefined), undefined);
  // Turned down, or no answer: location may still have been turned on another way.
  return on();
}

/**
 * One location reading, taken at the moment of a punch.
 *
 * The app asks only for "while using the app" permission and never tracks
 * anyone in the background: a position is read when a button is pressed,
 * stamped on that punch, and that is all. When the person allows only an
 * approximate location, no position is read at all: one that vague cannot be
 * checked against the boundary.
 *
 * On Android the screen says why first, the one time the phone is about to
 * ask (`beforeAsking`). With location off for the whole phone, Android offers
 * its own switch before the reading (`switchedOn`); left off, the answer is
 * that location is off. With location on, the GPS is read without Google's
 * "location accuracy" prompt, so a phone set to use the GPS alone is read as
 * it is. An iPhone shows no such prompt. A reading that is slow or fails falls
 * back to a position from the last minute.
 */
export async function locate(site: SiteConfig | null, setting: DemoLocation, options: LocateOptions = {}): Promise<LocateResult> {
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

  const android = Platform.OS === 'android';
  try {
    if (android && options.beforeAsking && (await neverAsked())) await options.beforeAsking();
    const permission = await Location.requestForegroundPermissionsAsync();
    // Turned down for the app (an iPhone with Location Services off says the same).
    if (permission.status !== Location.PermissionStatus.GRANTED) return { ok: false, reason: 'off' };
    // A browser asks as it reads: allowed, but with no position on that first try, it says granted: false.
    if (!permission.granted) return { ok: false, reason: 'no_fix' };
    // iPhone: Precise Location turned off. Android: approximate location only.
    if (permission.ios?.accuracy === 'reduced' || permission.android?.accuracy === 'coarse') {
      return { ok: false, reason: 'approximate' };
    }

    if (android && !(await switchedOn())) return { ok: false, reason: 'off' };

    // The 15 seconds start here, with every question the phone asks already answered.
    const reading = await within(
      GPS_TIMEOUT_MS,
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: false }).catch(() => null),
      null,
    );
    const position = reading ?? (await Location.getLastKnownPositionAsync({ maxAge: 60_000 }).catch(() => null));
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
