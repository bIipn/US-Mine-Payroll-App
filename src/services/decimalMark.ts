import { useEffect, useState } from 'react';

import type { DecimalMark } from '../domain/reading';

/**
 * The mark this device writes between a number's whole units and its part, which its number pad types and
 * a reading is read by (`parseReading`). In a browser it is the one the browser writes 1.5 with. Anything
 * but a comma is a point, and so is a browser that cannot say. The phone's own is in `decimalMark.native.ts`.
 */
export function decimalMark(): DecimalMark {
  try {
    const decimal = new Intl.NumberFormat().formatToParts(1.5).find((p) => p.type === 'decimal')?.value;
    return decimal === ',' ? ',' : '.';
  } catch {
    return '.';
  }
}

/** The decimal mark for a screen that takes a reading, read again if the browser's language changes. */
export function useDecimalMark(): DecimalMark {
  const [mark, setMark] = useState(decimalMark);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const changed = () => setMark(decimalMark());
    window.addEventListener('languagechange', changed);
    return () => window.removeEventListener('languagechange', changed);
  }, []);
  return mark;
}
