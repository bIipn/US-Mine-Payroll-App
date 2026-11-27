import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEMO_MODE, SERVER } from '../config';
import { keepsTime } from '../domain/company';
import { useStore } from '../store/useStore';
import { color, space } from '../theme/theme';
import { TriangleAlert } from './icons';
import { Button, Notice, Txt } from './ui';

/** How often the app saves the records again while a save could not be written. */
export const SAVE_AGAIN_MS = 15_000;

/**
 * In a browser, how many of those tries in a row come every 15 seconds, and how far apart the rest are. A browser's
 * room for a site is fixed, about 5 MB, whatever room the computer has, so a try there seldom finds more, and each
 * one writes all the records. A change in the app still saves at once, as every change does. A phone keeps trying
 * every 15 seconds: freeing space on it makes room.
 */
export const QUICK_TRIES = 3;
export const SAVE_AGAIN_SLOWLY_MS = 5 * 60_000;

/** What the notice of a save that could not be written says, on a phone or in a browser. */
function unsavedWords(): { title: string; body: string } {
  if (Platform.OS !== 'web') {
    return {
      title: 'Records could not be saved on this phone',
      body: 'Free up space on the phone, then keep the app open until this message goes away.',
    };
  }
  return {
    title: 'This browser has no more room for MineMuster’s records',
    body: SERVER
      ? 'What you do now is kept only while this tab stays open. Records already sent to your company are safe. Tell your supervisor.'
      : 'What you do now is kept only while this tab stays open. Tell your supervisor.',
  };
}

/**
 * Wraps the app, and draws across the top of every screen, under the no-signal strip when that is there:
 *
 * - while the last save of the records could not be written (`recordsUnsaved`: the phone, or the browser's room for
 *   the site, is full), a notice that says so. Meanwhile the records are saved again every few seconds (in a browser,
 *   less often after a few tries: above), and the notice goes once a save works.
 * - while a browser that would not let the app at its storage keeps the records only in memory (`recordsInMemory`),
 *   a notice that they go when the tab closes, in a build that keeps real records. Not in the preview, which runs
 *   inside a frame, where that is to be expected.
 * - once the phone has opened on an older copy of the records because it shut off while saving the newest
 *   (`shutOffWhileSaving`: a power cut, a forced restart), a notice of what to check, until the person taps OK.
 * - when that brought back an account deleted on the phone, which the store could not delete again by itself
 *   (`deletionNotFinished`: its shift is open in the copy the phone opened on), a notice of what to do, until OK.
 *
 * And in a browser, while another tab of MineMuster saves the records (`recordsElsewhere`: storage.ts), this tab
 * saves nothing, and what it shows may be older than what that tab saved: the app is hidden, so nothing in it can be
 * seen, tapped or reached from the keyboard, and in its place the notice says so, with Use this tab, which takes the
 * records, reads them again and shows the app once they have been. Nothing done here is dropped while it looks saved:
 * nothing can be done.
 *
 * The screens are told their top is the bottom of the notices, so nothing is hidden under them. As with
 * SignalFrame, the tree is the same with the notices or without, so nothing on screen resets: hidden, the app is
 * still there, and comes back as it was.
 */
export function RecordsNotSavedFrame({ children }: { children: React.ReactNode }) {
  const unsaved = useStore((s) => s.recordsUnsaved);
  const inMemory = useStore((s) => s.recordsInMemory) && !DEMO_MODE;
  const shutOff = useStore((s) => s.shutOffWhileSaving);
  const time = useStore((s) => keepsTime(s.settings.company));
  const saveAgain = useStore((s) => s.saveRecordsAgain);
  const seen = useStore((s) => s.dismissShutOffNotice);
  const deletionBack = useStore((s) => s.deletionNotFinished);
  const seenDeletion = useStore((s) => s.dismissDeletionNotice);
  const elsewhere = useStore((s) => s.recordsElsewhere);
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!unsaved) return undefined;
    // Counted from the save that was turned down: once one works, this stops, and the next starts from none.
    const spacedOut = Platform.OS === 'web';
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      timer = setTimeout(
        () => {
          tries += 1;
          next();
          saveAgain();
        },
        spacedOut && tries >= QUICK_TRIES ? SAVE_AGAIN_SLOWLY_MS : SAVE_AGAIN_MS,
      );
    };
    next();
    return () => clearTimeout(timer);
  }, [unsaved, saveAgain]);

  const shown = (unsaved || inMemory || shutOff || deletionBack) && !elsewhere;
  const below = shown ? { ...insets, top: insets.top + height } : insets;
  const words = unsavedWords();
  return (
    <View style={styles.frame}>
      <View testID="records-app" style={[styles.frame, elsewhere && styles.hidden]}>
        <SafeAreaInsetsContext.Provider value={below}>{children}</SafeAreaInsetsContext.Provider>
      </View>
      {elsewhere ? <OtherTabNotice /> : null}
      {shown ? (
        <View style={[styles.notices, { top: insets.top }]} onLayout={(e) => setHeight(Math.ceil(e.nativeEvent.layout.height))}>
          {unsaved ? (
            <View testID="records-not-saved" accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <Notice tone="bo" icon={TriangleAlert} title={words.title} body={words.body} />
            </View>
          ) : null}
          {inMemory ? (
            <View testID="records-in-memory" accessibilityRole="alert">
              <Notice
                tone="bo"
                icon={TriangleAlert}
                title="This browser is not keeping MineMuster’s records"
                body={
                  SERVER
                    ? 'What you do here is lost when this tab closes, unless it has been sent to your company. Use the app on your phone, or allow this site to store data.'
                    : 'What you do here is lost when this tab closes. Use the app on your phone, or allow this site to store data.'
                }
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
          {deletionBack ? (
            <View testID="deletion-not-finished" accessibilityRole="alert" style={styles.shutOff}>
              <Notice
                tone="warn"
                icon={TriangleAlert}
                title="A deleted account may be back on this phone"
                body="The phone shut off before it finished deleting an account, so the account and its hourly rate may be on the phone again. Clock out if you are on the clock, then delete it again on More, Delete my account."
              />
              <Button label="OK" kind="ink" onPress={seenDeletion} testID="deletion-not-finished-ok" />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * What a tab of the browser shows in place of the app while another tab saves the records: that nothing is saved in
 * this one, and Use this tab, tapped once at a time (`takeRecordsHere`).
 */
function OtherTabNotice() {
  const take = useStore((s) => s.takeRecordsHere);
  const insets = useSafeAreaInsets();
  const [taking, setTaking] = useState(false);
  const takeHere = async () => {
    setTaking(true);
    try {
      await take();
    } finally {
      setTaking(false);
    }
  };
  return (
    <View testID="records-elsewhere" accessibilityRole="alert" style={[styles.elsewhere, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl }]}>
      <Notice
        tone="warn"
        icon={TriangleAlert}
        title="MineMuster is open in another tab"
        body="Only one tab at a time can save the records, so nothing is saved in this one. Use the other tab, or use this one instead."
      />
      <Txt v="small" c={color.silica}>
        If you use this one, it reads the records again first, and the other tab stops saving them.
      </Txt>
      <Button label="Use this tab" kind="ink" loading={taking} onPress={() => void takeHere()} testID="use-this-tab" />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  hidden: { display: 'none' },
  elsewhere: { flex: 1, justifyContent: 'center', gap: space.lg, paddingHorizontal: space.lg, backgroundColor: color.kaolin },
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
