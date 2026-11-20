import * as Location from 'expo-location';

import { SAMPLE_SITE } from '../../domain/site';
import { locate } from '../location';

jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  requestForegroundPermissionsAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
}));

const phone = Location as jest.Mocked<typeof Location>;

/** What the phone says when asked for its location while the app is in use. */
const answer = (granted: boolean, extra: Partial<Location.LocationPermissionResponse> = {}) =>
  ({ granted, status: granted ? 'granted' : 'denied', canAskAgain: true, expires: 'never', ...extra }) as unknown as Location.LocationPermissionResponse;
/** A reading that never comes. */
const never = () => new Promise<Location.LocationObject>(() => undefined);

const position = (accuracy: number, mocked = false) =>
  ({
    coords: { latitude: 39.5, longitude: -116.5, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
    timestamp: 0,
    mocked,
  }) as Location.LocationObject;

const readsNothing = () => {
  expect(phone.getCurrentPositionAsync).not.toHaveBeenCalled();
  expect(phone.getLastKnownPositionAsync).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  phone.requestForegroundPermissionsAsync.mockResolvedValue(answer(true, { ios: { scope: 'whenInUse', accuracy: 'full' } }));
  phone.hasServicesEnabledAsync.mockResolvedValue(true);
  phone.getCurrentPositionAsync.mockResolvedValue(position(6));
  phone.getLastKnownPositionAsync.mockResolvedValue(null);
});
afterEach(() => jest.useRealTimers());

describe('one reading at the moment of a punch', () => {
  it('gives the position the phone reads, with how sure it is and whether it was simulated', async () => {
    phone.getCurrentPositionAsync.mockResolvedValue(position(9, true));
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: true, source: 'gps', fix: { lat: 39.5, lng: -116.5, accuracyM: 9, mocked: true } });
  });

  it('reads no position at all when the phone shares only an approximate location', async () => {
    phone.requestForegroundPermissionsAsync.mockResolvedValue(answer(true, { ios: { scope: 'whenInUse', accuracy: 'reduced' } }));
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'approximate' });
    readsNothing();
    phone.requestForegroundPermissionsAsync.mockResolvedValue(answer(true, { android: { accuracy: 'coarse' } }));
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'approximate' });
    readsNothing();
  });

  it('says location is off when the person turned it down, or Location Services are off', async () => {
    phone.requestForegroundPermissionsAsync.mockResolvedValue(answer(false));
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'off' });
    readsNothing();
    phone.requestForegroundPermissionsAsync.mockResolvedValue(answer(true, { android: { accuracy: 'fine' } }));
    phone.hasServicesEnabledAsync.mockResolvedValue(false);
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'off' });
    readsNothing();
  });

  it('still reads a position when the phone cannot say whether Location Services are on', async () => {
    phone.hasServicesEnabledAsync.mockRejectedValue(new Error('not supported'));
    expect(await locate(SAMPLE_SITE, 'gps')).toMatchObject({ ok: true, fix: { accuracyM: 6 } });
  });

  it('takes a position from the last minute when no reading comes in 15 seconds', async () => {
    phone.getCurrentPositionAsync.mockReturnValue(never());
    phone.getLastKnownPositionAsync.mockResolvedValue(position(30));
    const reading = locate(SAMPLE_SITE, 'gps');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(await reading).toMatchObject({ ok: true, fix: { accuracyM: 30 } });
    expect(phone.getLastKnownPositionAsync).toHaveBeenCalledWith({ maxAge: 60_000 });
  });

  it('says the phone found no position when there is no reading and none from the last minute, or the reading fails', async () => {
    phone.getCurrentPositionAsync.mockReturnValue(never());
    const reading = locate(SAMPLE_SITE, 'gps');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(await reading).toEqual({ ok: false, reason: 'no_fix' });
    phone.getCurrentPositionAsync.mockRejectedValue(new Error('Location request failed'));
    expect(await locate(SAMPLE_SITE, 'gps')).toEqual({ ok: false, reason: 'no_fix' });
  });

  it('asks nothing of the phone for the preview’s made-up positions', async () => {
    expect(await locate(SAMPLE_SITE, 'at_mine')).toMatchObject({ ok: true, source: 'demo' });
    expect(await locate(SAMPLE_SITE, 'in_town')).toMatchObject({ ok: true, source: 'demo' });
    expect(phone.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});
