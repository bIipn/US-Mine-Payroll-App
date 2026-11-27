import { getLocales, useLocales } from 'expo-localization';

import type { DecimalMark } from '../domain/reading';

/**
 * The phone's decimal mark, from its own region settings, which its decimal pad follows. expo-localization
 * reads it natively: on the iPhone from the current locale (Region and Number Format under Language &
 * Region, the same for every language in the list), on Android from the number format of the first
 * language. JavaScript's Intl is not asked: Hermes picks its own default locale, which need not be the one
 * the keyboard follows. Anything but a comma is a point.
 */
const markOf = (separator: string | null | undefined): DecimalMark => (separator === ',' ? ',' : '.');

/** The phone's decimal mark now, for the store's own words. A phone that cannot say is taken to write a point. */
export function decimalMark(): DecimalMark {
  try {
    return markOf(getLocales()[0]?.decimalSeparator);
  } catch {
    return '.';
  }
}

/** The phone's decimal mark for a screen that takes a reading, read again when the phone's region settings change. */
export function useDecimalMark(): DecimalMark {
  return markOf(useLocales()[0]?.decimalSeparator);
}
