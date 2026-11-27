// The App Store and Google Play builds are made by EAS from eas.json and app.json. These hold them to a
// build that connects to the company's server and carries nothing one mine owns: no preview controls,
// no made-up crew, no roster, area sheets or company, no customer's logo, and no server address or key
// in the repository (those are set in the EAS environment). They also hold the store settings the
// listing depends on: iPhone only, local notifications only, no cloud backup of what stays on the phone,
// and location while the app is in use only.

import { LOCATION_PURPOSE } from '../../src/config';
import { parseAreaSheets } from '../../src/domain/areaExam';
import { parseCompany } from '../../src/domain/company';
import { parsePersonName, parseRoster } from '../../src/domain/roster';

// This project has no Node types, so the file system is asked for by name with the calls used here.
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');

const here = expect.getState().testPath ?? '';
const root = here.slice(0, here.search(/[\\/]scripts[\\/]/));
const read = (name: string) => fs.readFileSync(`${root}/${name}`, 'utf8');

type Profile = { extends?: string; env?: Record<string, string>; environment?: string; distribution?: string; android?: { buildType?: string } };
const eas = JSON.parse(read('eas.json')) as {
  cli: { appVersionSource?: string };
  build: Record<string, Profile>;
  submit?: Record<string, { ios?: { ascAppId?: string } }>;
};

/** A profile's env with what it extends folded in, the way EAS reads it. */
function envOf(name: string, seen: string[] = []): Record<string, string> {
  const profile = eas.build[name];
  expect(profile).toBeDefined();
  expect(seen).not.toContain(name);
  const base = profile.extends ? envOf(profile.extends, [...seen, name]) : {};
  return { ...base, ...(profile.env ?? {}) };
}

/** Every setting a store build must have, and the value it must have. */
const STORE_ENV: Record<string, string> = {
  // .env.local is not read: a local `eas build --local` would otherwise take this computer's private settings.
  EXPO_NO_DOTENV: '1',
  // Not a preview: no preview controls, nothing made up, and it may connect.
  EXPO_PUBLIC_DEMO: '0',
  // "0", not empty: with no roster an empty value means the sample crew, and a build with them never connects.
  EXPO_PUBLIC_SAMPLE_CREW: '0',
  // The private settings, blank: every company's people, sheets and settings come from its server.
  // A single space, not "": EAS refuses an empty value in eas.json ("is not allowed to be empty", from
  // eas-cli 27 on), and the app reads a blank one as none. Set here, it also overrides one this
  // computer's shell has, for `eas build --local`.
  EXPO_PUBLIC_ROSTER_OWNER: ' ',
  EXPO_PUBLIC_ROSTER: ' ',
  EXPO_PUBLIC_AREA_SHEETS: ' ',
  EXPO_PUBLIC_COMPANY: ' ',
  // No customer's trademark in a public app.
  EXPO_PUBLIC_LOGO_ART: '0',
};

describe('the store builds (eas.json)', () => {
  const builds = Object.keys(eas.build).filter((name) => name !== 'base');

  it('has a production build and an internal test build, and no profile named "preview"', () => {
    // In this repository "preview" is the demo build that never sends.
    expect(builds).toEqual(expect.arrayContaining(['production', 'internal']));
    expect(builds).not.toContain('preview');
  });

  it.each(builds)('gives the %s build every store setting, and nothing overrides one', (name) => {
    expect(envOf(name)).toMatchObject(STORE_ENV);
  });

  it('gives no setting an empty value, which EAS refuses before it builds anything', () => {
    for (const name of Object.keys(eas.build)) {
      for (const [key, value] of Object.entries(eas.build[name].env ?? {})) expect([name, key, value]).not.toEqual([name, key, '']);
    }
  });

  it('blanks each private setting in a way the app reads as none', () => {
    expect(parsePersonName(STORE_ENV.EXPO_PUBLIC_ROSTER_OWNER)).toBeNull();
    expect(parseRoster(STORE_ENV.EXPO_PUBLIC_ROSTER)).toEqual([]);
    expect(parseAreaSheets(STORE_ENV.EXPO_PUBLIC_AREA_SHEETS)).toEqual([]);
    expect(parseCompany(STORE_ENV.EXPO_PUBLIC_COMPANY)).toEqual({});
  });

  it('names no company server and no key: those are set in the EAS environment, never in the repository', () => {
    const text = read('eas.json');
    expect(text).not.toMatch(/SUPABASE/);
    expect(text).not.toMatch(/supabase\.co|sb_publishable|sb_secret|eyJ[A-Za-z0-9_-]{10,}/);
    // An Apple ID is an email address, and it does not go in a public file either.
    expect(text).not.toMatch(/appleId|@/);
    for (const name of builds) expect(eas.build[name].environment).toMatch(/^(production|preview|development)$/);
  });

  it('names the App Store Connect app a production build is sent to, so it goes with no one at the keyboard', () => {
    // The app's Apple ID in App Store Connect, public once it is listed. EAS Submit refuses to send
    // a build in --non-interactive mode without it.
    expect(eas.submit?.production?.ios?.ascAppId).toMatch(/^\d{9,12}$/);
  });

  it('builds a store bundle for production, and lets EAS keep the build numbers', () => {
    expect(eas.build.production.distribution ?? 'store').toBe('store');
    expect(eas.build.production.android?.buildType ?? 'app-bundle').toBe('app-bundle');
    expect(eas.cli.appVersionSource).toBe('remote');
  });
});

type Plugin = string | [string, Record<string, unknown>];
const app = (JSON.parse(read('app.json')) as {
  expo: {
    owner?: string;
    extra?: { eas?: { projectId?: string } };
    ios: { supportsTablet?: boolean; bundleIdentifier: string; config?: { usesNonExemptEncryption?: boolean } };
    android: { package: string; allowBackup?: boolean; blockedPermissions?: string[]; permissions?: string[] };
    plugins: Plugin[];
  };
}).expo;
const plugin = (name: string) => {
  const found = app.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
  expect(found).toBeDefined();
  return (Array.isArray(found) ? found[1] : {}) as Record<string, unknown>;
};

describe('the store settings (app.json)', () => {
  it('belongs to the Expo organization and project the store builds are made in', () => {
    // EAS builds and keeps the signing credentials by project: without these, `eas build` stops
    // with "EAS project not configured", and an access token cannot make one by itself.
    expect(app.owner).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(app.extra?.eas?.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is for iPhone only, so no update ever has to drop iPad', () => {
    expect(app.ios.supportsTablet).toBe(false);
    expect(app.ios.bundleIdentifier).toBe('com.minemuster.app');
    expect(app.android.package).toBe('com.minemuster.app');
  });

  it('answers the export compliance question: no encryption beyond the system HTTPS', () => {
    expect(app.ios.config?.usesNonExemptEncryption).toBe(false);
  });

  it('keeps what never leaves the phone out of Android cloud backups', () => {
    // The hourly rate, the app accounts and the server session stay on the phone (AGENTS.md).
    expect(app.android.allowBackup).toBe(false);
  });

  it('blocks Android permissions the app does not use, the advertising ID among them', () => {
    expect(app.android.blockedPermissions).toEqual(expect.arrayContaining([
      'android.permission.ACCESS_WIFI_STATE',
      'com.google.android.gms.permission.AD_ID',
      'android.permission.SYSTEM_ALERT_WINDOW',
    ]));
    expect(app.android.permissions ?? []).not.toContain('android.permission.ACCESS_BACKGROUND_LOCATION');
  });

  it('may ask to deliver the lunch-over notice on time, with the alarm permission a person grants', () => {
    // SCHEDULE_EXACT_ALARM is the Alarms & reminders switch the person turns on; USE_EXACT_ALARM is granted
    // without asking and Google Play keeps it for alarm-clock and calendar apps.
    expect(app.android.permissions ?? []).toContain('android.permission.SCHEDULE_EXACT_ALARM');
    expect(app.android.permissions ?? []).not.toContain('android.permission.USE_EXACT_ALARM');
  });

  it('reads the phone’s decimal mark with no permission and no change to how the app is laid out', () => {
    // expo-localization's plugin with no options leaves the iPhone's Info.plist as it is and, on Android,
    // only adds locale and layoutDirection to the main activity's configChanges, so a change of language or
    // region does not restart the screen a checklist is half filled on. Options would set the languages
    // the app offers and how it lays out right to left; the app sets neither.
    expect(app.plugins).toContain('expo-localization');
    expect(plugin('expo-localization')).toEqual({});
  });

  it('asks for location while the app is in use only, and says who sees it', () => {
    const location = plugin('expo-location');
    expect(location).toMatchObject({
      locationAlwaysAndWhenInUsePermission: false,
      locationAlwaysPermission: false,
      motionUsagePermission: false,
      locationFullAccuracyPermission: false,
    });
    expect(location.isIosBackgroundLocationEnabled ?? false).toBe(false);
    expect(location.isAndroidBackgroundLocationEnabled ?? false).toBe(false);
    expect(location.isAndroidForegroundServiceEnabled ?? false).toBe(false);
    const why = String(location.locationWhenInUsePermission);
    expect(why).toMatch(/clock in/);
    expect(why).toMatch(/supervisors can see/);
    expect(why).toMatch(/never read in the background/);
    // The iPhone's prompt shows this; Android's has no room for it, so the app shows the same words first.
    expect(why).toBe(LOCATION_PURPOSE);
  });

  it('sends local notifications only, with the white mark Android draws in the status bar', () => {
    const notifications = plugin('expo-notifications');
    expect(notifications.enableRemoteNotifications).toBe(false);
    expect(notifications.icon).toBe('./assets/notification-icon.png');
  });

  it('names no default Android channel: that is for messages from a server, and each local notice names its own', () => {
    // The old shared channel ("lunch") is taken off the phone (src/services/notificationChannels.ts), so nothing points at it.
    expect(plugin('expo-notifications').defaultChannel).toBeUndefined();
  });
});
