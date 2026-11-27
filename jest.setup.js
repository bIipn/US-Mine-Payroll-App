// Device storage has no native module under Jest; use the library's in-memory stand-in.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// The phone's region settings (src/services/decimalMark.native.ts). Under Jest the phone writes a point, as
// en-US does. A stand-in here, not the package's own native mock, so that a test of the store does not load
// `expo` and what it installs over a test's own stand-ins. A test of a phone that writes a comma mocks
// expo-localization again in its own file.
jest.mock('expo-localization', () => {
  const locales = () => [{ languageTag: 'en-US', languageCode: 'en', regionCode: 'US', decimalSeparator: '.', digitGroupingSeparator: ',' }];
  return { getLocales: locales, useLocales: locales };
});
