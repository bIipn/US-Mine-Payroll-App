import React, { useCallback, useEffect, useRef, useState } from 'react';

import { LOCATION_PURPOSE } from '../config';
import { color } from '../theme/theme';
import { Button, Sheet, Txt } from './ui';

/**
 * Why the app reads a location, said before the phone first asks. Android's own prompt has no room for an
 * app's reason (an iPhone's shows `LOCATION_PURPOSE`), so `locate` calls `beforeAsking` on Android the one
 * time the phone is about to ask, and this sheet says it. One tap goes on, and so does closing the sheet:
 * a punch is never held by more than that tap, and never turned back by it.
 *
 * Pass `beforeAsking` to `locate`, and put `sheet` on the screen.
 */
export function useLocationPurpose(): { beforeAsking: () => Promise<void>; sheet: React.ReactElement } {
  const [open, setOpen] = useState(false);
  const waiting = useRef<(() => void) | null>(null);

  const carryOn = useCallback(() => {
    setOpen(false);
    const go = waiting.current;
    waiting.current = null;
    go?.();
  }, []);
  const beforeAsking = useCallback(
    () =>
      new Promise<void>((resolve) => {
        waiting.current = resolve;
        setOpen(true);
      }),
    [],
  );
  // A screen that goes away with the sheet up lets the punch it was for go on.
  useEffect(() => () => waiting.current?.(), []);

  const sheet = (
    <Sheet testID="location-purpose" visible={open} onClose={carryOn} title="How the app uses your location">
      <Txt v="body">{LOCATION_PURPOSE}</Txt>
      <Txt v="body" c={color.inkSoft}>Your phone asks next.</Txt>
      <Button testID="location-purpose-continue" label="Continue" kind="ink" onPress={carryOn} />
    </Sheet>
  );
  return { beforeAsking, sheet };
}
