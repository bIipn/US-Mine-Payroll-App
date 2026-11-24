import { useIsFocused } from '@react-navigation/native';
import { useEffect, useState } from 'react';

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
