import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { keepsTime } from '../domain/company';
import { useStore } from '../store/useStore';
import { color, space } from '../theme/theme';
import { TriangleAlert } from './icons';
import { Button, Notice } from './ui';

/** How often the app saves the records again while a save could not be written. */
export const SAVE_AGAIN_MS = 15_000;

/**
 * Wraps the app, and draws across the top of every screen, under the no-signal strip when that is there:
 *
 * - while the last save of the records could not be written to the phone (`recordsUnsaved`: it is full, say), a
 *   notice that says so. Meanwhile the records are saved again every few seconds, and the notice goes once a save
 *   works.
 * - once the phone has opened on an older copy of the records because it shut off while saving the newest
 *   (`shutOffWhileSaving`: a power cut, a forced restart), a notice of what to check, until the person taps OK.
 *
 * The screens are told their top is the bottom of the notices, so nothing is hidden under them. As with
 * SignalFrame, the tree is the same with the notices or without, so nothing on screen resets.
 */
export function RecordsNotSavedFrame({ children }: { children: React.ReactNode }) {
  const unsaved = useStore((s) => s.recordsUnsaved);
  const shutOff = useStore((s) => s.shutOffWhileSaving);
  const time = useStore((s) => keepsTime(s.settings.company));
  const saveAgain = useStore((s) => s.saveRecordsAgain);
  const seen = useStore((s) => s.dismissShutOffNotice);
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!unsaved) return undefined;
    const timer = setInterval(() => saveAgain(), SAVE_AGAIN_MS);
    return () => clearInterval(timer);
  }, [unsaved, saveAgain]);

  const shown = unsaved || shutOff;
  const below = shown ? { ...insets, top: insets.top + height } : insets;
  return (
    <View style={styles.frame}>
      <SafeAreaInsetsContext.Provider value={below}>{children}</SafeAreaInsetsContext.Provider>
      {shown ? (
        <View style={[styles.notices, { top: insets.top }]} onLayout={(e) => setHeight(Math.ceil(e.nativeEvent.layout.height))}>
          {unsaved ? (
            <View testID="records-not-saved" accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <Notice
                tone="bo"
                icon={TriangleAlert}
                title="Records could not be saved on this phone"
                body="Free up space on the phone, then keep the app open until this message goes away."
              />
            </View>
          ) : null}
          {shutOff ? (
            <View testID="shut-off-while-saving" accessibilityRole="alert" style={styles.shutOff}>
              <Notice
                tone="warn"
                icon={TriangleAlert}
                title="This phone shut off while saving"
                body={
                  time
                    ? 'The last few minutes of changes before that may not be on the phone. Check your last punch, checklist, exam or request, and enter again anything that is missing. A supervisor can correct the time of a punch.'
                    : 'The last few minutes of changes before that may not be on the phone. Check your last checklist, exam or request, and enter again anything that is missing.'
                }
              />
              <Button label="OK" kind="ink" onPress={seen} testID="shut-off-ok" />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  notices: {
    position: 'absolute',
    left: 0,
    right: 0,
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.kaolin,
    borderBottomWidth: 1,
    borderBottomColor: color.rule,
  },
  shutOff: { gap: space.sm },
});
