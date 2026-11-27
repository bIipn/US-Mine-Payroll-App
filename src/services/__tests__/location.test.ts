// One location reading at the moment of a punch, on each kind of phone. The phone's location service is a
// stand-in here, loaded fresh for an Android phone, an iPhone or a browser, so each test can say which it is.
import type * as LocationModule from 'expo-location';

import { SAMPLE_SITE } from '../../domain/site';

type Os = 'android' | 'ios' | 'web';
type Phone = jest.Mocked<typeof LocationModule>;

/** The location service as one kind of phone runs it, with the phone's answers stubbed. */
function load(os: Os) {
  const phone = {
    Accuracy: { High: 4 },
    PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
    getForegroundPermissionsAsync: jest.fn(),
    requestForegroundPermissionsAsync: jest.fn(),
    hasServicesEnabledAsync: jest.fn(),
    enableNetworkProviderAsync: jest.fn(),
    getCurrentPositionAsync: jest.fn(),
    getLastKnownPositionAsync: jest.fn(),
  } as unknown as Phone;
  phone.getForegroundPermissionsAsync.mockResolvedValue(answer(true, { android: { accuracy: 'fine' } }));
  phone.requestForegroundPermissionsAsync.mockResolvedValue(
    answer(true, os === 'android' ? { android: { accuracy: 'fine' } } : { ios: { scope: 'whenInUse', accuracy: 'full' } }),
  );
  phone.hasServicesEnabledAsync.mockResolvedValue(true);
  phone.enableNetworkProviderAsync.mockResolvedValue(undefined);
  phone.getCurrentPositionAsync.mockResolvedValue(position(6));
  phone.getLastKnownPositionAsync.mockResolvedValue(null);
  let mod: typeof import('../location') | undefined;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: os } }));
    jest.doMock('expo-location', () => phone);
    mod = require('../location');
  });
  return { locate: mod!.locate, phone };
}

/** What the phone says when asked for its location while the app is in use. */
function answer(granted: boolean, extra: Partial<LocationModule.LocationPermissionResponse> = {}) {
  return { granted, status: granted ? 'granted' : 'denied', canAskAgain: true, expires: 'never', ...extra } as unknown as LocationModule.LocationPermissionResponse;
}
/** What an Android phone says of a permission it has never asked for. */
const neverAsked = () => ({ ...answer(false), status: 'undetermined' }) as LocationModule.LocationPermissionResponse;
/** A reading that never comes. */
const never = <T>() => new Promise<T>(() => undefined);
/** Something that comes after this long. */
const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

function position(accuracy: number, mocked = false) {
  return {
    coords: { latitude: 39.5, longitude: -116.5, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
    timestamp: 0,
    mocked,
  } as LocationModule.LocationObject;
}

const readsNothing = (phone: Phone) => {
  expect(phone.getCurrentPositionAsync).not.toHaveBeenCalled();
  expect(phone.getLastKnownPositionAsync).not.toHaveBeenCalled();
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('one reading at the moment of a punch', () => {
  it('gives the position the phone reads, with how sure it is and whether it was simulated', async () => {
    const { locate, phone } = load('ios');
    phone.getCurrentPositionAsync.mockResolvedValue(position(9, true));
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: true, source: 'gps', fix: { lat: 39.5, lng: -116.5, accuracyM: 9, mocked: true } });
  });

  it('reads no position at all when the phone shares only an approximate location', async () => {
    const iphone = load('ios');
    iphone.phone.requestForegroundPermissionsAsync.mockResolvedValue(answer(true, { ios: { scope: 'whenInUse', accuracy: 'reduced' } }));
    expect(await iphone.locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'approximate' });
    readsNothing(iphone.phone);
    const android = load('android');
    android.phone.requestForegroundPermissionsAsync.mockResolvedValue(answer(true, { android: { accuracy: 'coarse' } }));
    expect(await android.locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'approximate' });
    readsNothing(android.phone);
    expect(android.phone.enableNetworkProviderAsync).not.toHaveBeenCalled();
  });

  it('says location is off when the person turned it down, and reads nothing', async () => {
    for (const os of ['ios', 'android'] as const) {
      const { locate, phone } = load(os);
      phone.requestForegroundPermissionsAsync.mockResolvedValue(answer(false));
      expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'off' });
      readsNothing(phone);
      expect(phone.enableNetworkProviderAsync).not.toHaveBeenCalled();
    }
  });

  it('says the phone found no position when it cannot say whether Location Services are on', async () => {
    const { locate, phone } = load('ios');
    phone.hasServicesEnabledAsync.mockRejectedValue(new Error('not supported'));
    expect(await locate(SAMPLE_SITE, 'gps')).toMatchObject({ ok: true, fix: { accuracyM: 6 } });
    phone.getCurrentPositionAsync.mockRejectedValue(new Error('Location request failed'));
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'no_fix' });
  });

  it('says a browser that was allowed but found no position on its first try found none, not that location is off', async () => {
    const { locate, phone } = load('web');
    // The browser asks while it reads: allowed, but no position, it answers "granted" and granted: false.
    phone.requestForegroundPermissionsAsync.mockResolvedValue({ ...answer(false), status: 'granted' } as LocationModule.LocationPermissionResponse);
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'no_fix' });
    phone.requestForegroundPermissionsAsync.mockResolvedValue(neverAsked());
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'off' });
  });

  it('takes a position from the last minute when no reading comes in 15 seconds', async () => {
    const { locate, phone } = load('ios');
    phone.getCurrentPositionAsync.mockReturnValue(never());
    phone.getLastKnownPositionAsync.mockResolvedValue(position(30));
    const reading = locate(SAMPLE_SITE, 'gps');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(await reading).toMatchObject({ ok: true, fix: { accuracyM: 30 } });
    expect(phone.getLastKnownPositionAsync).toHaveBeenCalledWith({ maxAge: 60_000 });
  });

  it('takes a position from the last minute when the reading fails, not only when it is slow', async () => {
    for (const os of ['ios', 'android'] as const) {
      const { locate, phone } = load(os);
      phone.getCurrentPositionAsync.mockRejectedValue(new Error('Current location is unavailable'));
      phone.getLastKnownPositionAsync.mockResolvedValue(position(25));
      expect(await locate(SAMPLE_SITE, 'gps')).toMatchObject({ ok: true, source: 'gps', fix: { accuracyM: 25 } });
      expect(phone.getLastKnownPositionAsync).toHaveBeenCalledWith({ maxAge: 60_000 });
    }
  });

  it('says the phone found no position when there is no reading and none from the last minute, or the reading fails', async () => {
    const { locate, phone } = load('ios');
    phone.getCurrentPositionAsync.mockReturnValue(never());
    const reading = locate(SAMPLE_SITE, 'gps');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(await reading).toEqual({ ok: false, reason: 'no_fix' });
    phone.getCurrentPositionAsync.mockRejectedValue(new Error('Location request failed'));
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'no_fix' });
    phone.getLastKnownPositionAsync.mockRejectedValue(new Error('Location request failed'));
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'no_fix' });
  });

  it('asks nothing of the phone for the preview’s made-up positions', async () => {
    const { locate, phone } = load('android');
    const beforeAsking = jest.fn(async () => undefined);
    phone.getForegroundPermissionsAsync.mockResolvedValue(neverAsked());
    expect(await locate(SAMPLE_SITE, 'at_mine', { beforeAsking })).toMatchObject({ ok: true, source: 'demo' });
    expect(await locate(SAMPLE_SITE, 'in_town', { beforeAsking })).toMatchObject({ ok: true, source: 'demo' });
    expect(phone.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(phone.getForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(beforeAsking).not.toHaveBeenCalled();
  });
});

describe('Android: the phone’s own location switch', () => {
  it('reads the GPS without Google’s dialog when location is on, even with Google Location Accuracy off', async () => {
    // Location on and Google Location Accuracy off ("device only"): the GPS is on, so the services say on.
    const { locate, phone } = load('android');
    expect(await locate(SAMPLE_SITE, 'gps')).toMatchObject({ ok: true, fix: { accuracyM: 6 } });
    expect(phone.getCurrentPositionAsync).toHaveBeenCalledWith({ accuracy: 4, mayShowUserSettingsDialog: false });
    expect(phone.enableNetworkProviderAsync).not.toHaveBeenCalled();
  });

  it('with location off for the whole phone, offers the phone’s switch first, and gives the GPS its 15 seconds after it is answered', async () => {
    const { locate, phone } = load('android');
    let on = false;
    phone.hasServicesEnabledAsync.mockImplementation(async () => on);
    // The person reads the phone's "turn on location" prompt for 20 seconds, then turns it on.
    phone.enableNetworkProviderAsync.mockImplementation(() => after(20_000, undefined).then(() => void (on = true)));
    // The GPS, just switched on, takes 10 seconds to place the phone.
    phone.getCurrentPositionAsync.mockImplementation(() => after(10_000, position(8)));
    const reading = locate(SAMPLE_SITE, 'gps');
    await jest.advanceTimersByTimeAsync(19_000);
    expect(phone.getCurrentPositionAsync).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(phone.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    expect(phone.getCurrentPositionAsync).toHaveBeenCalledWith({ accuracy: 4, mayShowUserSettingsDialog: false });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await reading).toMatchObject({ ok: true, source: 'gps', fix: { accuracyM: 8 } });
    expect(phone.enableNetworkProviderAsync).toHaveBeenCalledTimes(1);
    expect(phone.getLastKnownPositionAsync).not.toHaveBeenCalled();
  });

  it('says location is off, and reads nothing, when the person leaves it off at the phone’s prompt', async () => {
    const { locate, phone } = load('android');
    phone.hasServicesEnabledAsync.mockResolvedValue(false);
    phone.enableNetworkProviderAsync.mockRejectedValue(new Error('Location settings are not satisfied'));
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'off' });
    readsNothing(phone);
    // Turned down at the prompt, but on by now (from the phone's quick settings): the GPS is read.
    phone.hasServicesEnabledAsync.mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await locate(SAMPLE_SITE, 'gps')).toMatchObject({ ok: true, fix: { accuracyM: 6 } });
  });

  it('carries on without a position when the phone never answers its own prompt, so no punch waits on it', async () => {
    const { locate, phone } = load('android');
    phone.hasServicesEnabledAsync.mockResolvedValue(false);
    phone.enableNetworkProviderAsync.mockReturnValue(never());
    const reading = locate(SAMPLE_SITE, 'gps');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(await reading).toEqual({ ok: false, reason: 'off' });
    readsNothing(phone);
  });

  it('never offers the switch on an iPhone or in a browser, where the reading is asked for as before', async () => {
    for (const os of ['ios', 'web'] as const) {
      const { locate, phone } = load(os);
      phone.hasServicesEnabledAsync.mockResolvedValue(false);
      phone.getCurrentPositionAsync.mockRejectedValue(new Error('Location services are disabled'));
      expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'off' });
      expect(phone.enableNetworkProviderAsync).not.toHaveBeenCalled();
      expect(phone.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    }
  });
});

describe('Android: why the app reads a location, said before the phone first asks', () => {
  it('says why first when the phone has never asked, and asks only once that is answered', async () => {
    const { locate, phone } = load('android');
    phone.getForegroundPermissionsAsync.mockResolvedValue(neverAsked());
    const order: string[] = [];
    const beforeAsking = jest.fn(() => after(5_000, undefined).then(() => void order.push('said why')));
    phone.requestForegroundPermissionsAsync.mockImplementation(async () => {
      order.push('phone asked');
      return answer(true, { android: { accuracy: 'fine' } });
    });
    const reading = locate(SAMPLE_SITE, 'gps', { beforeAsking });
    await jest.advanceTimersByTimeAsync(4_000);
    expect(beforeAsking).toHaveBeenCalledTimes(1);
    expect(phone.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await reading).toMatchObject({ ok: true, fix: { accuracyM: 6 } });
    expect(order).toEqual(['said why', 'phone asked']);
  });

  it('says nothing first once the phone has asked, whatever the answer was, or when it cannot say', async () => {
    const { locate, phone } = load('android');
    const beforeAsking = jest.fn(async () => undefined);
    phone.getForegroundPermissionsAsync.mockResolvedValue(answer(true, { android: { accuracy: 'fine' } }));
    expect(await locate(SAMPLE_SITE, 'gps', { beforeAsking })).toMatchObject({ ok: true });
    phone.getForegroundPermissionsAsync.mockResolvedValue(answer(false));
    phone.requestForegroundPermissionsAsync.mockResolvedValue(answer(false));
    expect(await locate(SAMPLE_SITE, 'gps', { beforeAsking })).toEqual({ ok: false, reason: 'off' });
    phone.getForegroundPermissionsAsync.mockRejectedValue(new Error('no permissions module'));
    expect(await locate(SAMPLE_SITE, 'gps', { beforeAsking })).toEqual({ ok: false, reason: 'off' });
    expect(beforeAsking).not.toHaveBeenCalled();
    expect(phone.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(3);
  });

  it('never says it first on an iPhone, whose own prompt shows the reason, or in a browser', async () => {
    for (const os of ['ios', 'web'] as const) {
      const { locate, phone } = load(os);
      const beforeAsking = jest.fn(async () => undefined);
      phone.getForegroundPermissionsAsync.mockResolvedValue(neverAsked());
      expect(await locate(SAMPLE_SITE, 'gps', { beforeAsking })).toMatchObject({ ok: true });
      expect(beforeAsking).not.toHaveBeenCalled();
      expect(phone.getForegroundPermissionsAsync).not.toHaveBeenCalled();
    }
  });
});
