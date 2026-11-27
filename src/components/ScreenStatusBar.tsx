import { useIsFocused } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import React from 'react';

import { useSyncStatus } from '../services/sync';

/**
 * The status bar icons for a screen with a coloured top under the status bar: 'light' (white) on a dark or
 * strong colour, 'dark' on yellow. Only while the screen is the one in front: React Native merges every status
 * bar drawn in the order they were drawn, not by which screen shows, so a tab left open behind another, or a
 * screen with another opened over it, draws none, and the light screens keep the app's own dark icons. Each
 * time the screen comes back to the front its style is the newest. With no signal the black strip across the
 * top is under the status bar, so the icons stay white there whatever the screen asks for.
 */
export function ScreenStatusBar({ style }: { style: 'light' | 'dark' }) {
  const focused = useIsFocused();
  const online = useSyncStatus((s) => s.online);
  return focused ? <StatusBar style={online ? style : 'light'} /> : null;
}
