import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSyncStatus } from '../services/sync';
import { color, space } from '../theme/theme';
import { WifiOff } from './icons';
import { Txt } from './ui';

/** What the strip says with no signal: that nothing is lost, and when it goes. */
export function noSignalWords(server: boolean, waiting: number): string {
  if (server && waiting > 0) {
    return `No signal. ${waiting} ${waiting === 1 ? 'record is' : 'records are'} saved on this phone and will send when you are back in range.`;
  }
  return 'No signal. Everything you do is saved on this phone.';
}

/**
 * Wraps the app. With no signal, a strip is drawn across the top and the
 * screens are told the top of the screen is the bottom of the strip, so their
 * content starts under it. The screens keep their full height, so a form that
 * moves up for the keyboard still moves the whole way, and the tree is the
 * same with signal or without, so nothing on screen resets.
 */
export function SignalFrame({ children }: { children: React.ReactNode }) {
  const online = useSyncStatus((s) => s.online);
  const server = useSyncStatus((s) => s.server);
  const waiting = useSyncStatus((s) => s.waiting);
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  const below = online ? insets : { ...insets, top: Math.max(insets.top, height) };
  return (
    <View style={styles.frame}>
      <SafeAreaInsetsContext.Provider value={below}>{children}</SafeAreaInsetsContext.Provider>
      {online ? null : (
        <View
          testID="no-signal"
          style={[styles.strip, { paddingTop: insets.top + 6 }]}
          accessibilityRole="alert"
          onLayout={(e) => setHeight(Math.ceil(e.nativeEvent.layout.height))}
        >
          <WifiOff color={color.white} size={20} strokeWidth={2.5} />
          <Txt v="smallStrong" c={color.white} style={styles.words}>{noSignalWords(server, waiting)}</Txt>
          {/* Light status bar icons on the dark strip. */}
          <StatusBar style="light" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  strip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.ink,
    paddingHorizontal: space.lg,
    paddingBottom: 8,
  },
  words: { flex: 1 },
});
