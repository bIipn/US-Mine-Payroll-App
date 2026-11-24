import { usePreventRemove, type NavigationAction } from '@react-navigation/native';
import React, { useEffect, useState } from 'react';

import { color } from '../theme/theme';
import { Button, Sheet, Txt } from './ui';

/**
 * Asks before a half-filled form is left. A back tap, or an edge swipe in
 * gloves, would otherwise throw away everything that was marked.
 *
 * Put `guard.sheet` in the screen. Once the form is signed, call `guard.done`
 * with the move to the next screen: it runs after the guard has let go, so the
 * person is not asked about a form they have just signed.
 */
export function useLeaveGuard(
  navigation: { dispatch: (action: NavigationAction) => void },
  dirty: boolean,
  words: { title: string; body: string },
) {
  const [held, setHeld] = useState<NavigationAction | null>(null);
  const [after, setAfter] = useState<(() => void) | null>(null);

  usePreventRemove(dirty && !after, ({ data }) => setHeld(data.action));

  useEffect(() => {
    after?.();
  }, [after]);

  const leave = () => {
    const action = held;
    setHeld(null);
    // The navigator stops an action once: sent again, the same action goes through.
    if (action) navigation.dispatch(action);
  };

  return {
    done: (go: () => void) => setAfter(() => go),
    sheet: (
      <Sheet testID="unsigned-sheet" visible={held != null} onClose={() => setHeld(null)} title={words.title}>
        <Txt v="body" c={color.inkSoft}>{words.body}</Txt>
        <Button testID="unsigned-stay" label="Keep going" onPress={() => setHeld(null)} />
        <Button testID="unsigned-leave" label="Leave without signing" kind="quiet" onPress={leave} />
      </Sheet>
    ),
  };
}
