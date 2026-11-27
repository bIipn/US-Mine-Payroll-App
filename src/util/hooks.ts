import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';

/** The current time, refreshed on an interval while the screen is in view. */
export function useNow(intervalMs = 1000): number {
  const focused = useIsFocused();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!focused) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [focused, intervalMs]);
  return now;
}

/**
 * Android's back button and back gesture, while `when` holds and the screen is in front: `onBack` runs
 * before the navigator's own going back, and returns true when it dealt with the press, or false to let
 * the navigator have it. A screen opened on top turns it off until this one is in front again, so back
 * works there as ever. React Native asks the listener added last first; the navigator's own is added as
 * the app opens, so this one comes ahead of it once the screen is opened, or `when` turns true, after
 * that. iPhone and the web have no back button: there nothing is listened for.
 */
export function useBackPress(when: boolean, onBack: () => boolean): void {
  const latest = useRef(onBack);
  latest.current = onBack;
  useFocusEffect(
    useCallback(() => {
      if (!when || Platform.OS !== 'android') return undefined;
      const press = BackHandler.addEventListener('hardwareBackPress', () => latest.current());
      return () => press.remove();
    }, [when]),
  );
}
