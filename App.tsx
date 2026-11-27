import { Barlow_500Medium } from '@expo-google-fonts/barlow/500Medium';
import { Barlow_600SemiBold } from '@expo-google-fonts/barlow/600SemiBold';
import { Barlow_700Bold } from '@expo-google-fonts/barlow/700Bold';
import { BarlowCondensed_600SemiBold } from '@expo-google-fonts/barlow-condensed/600SemiBold';
import { BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed/700Bold';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { APP_NAME } from './src/config';
import { rulesFor } from './src/domain/stateRules';
import { RecordsNotSavedFrame } from './src/components/RecordsNotSaved';
import { SignalFrame } from './src/components/SignalStrip';
import { keepsTime } from './src/domain/company';
import { ToastHost } from './src/components/ui';
import { RootNavigator } from './src/navigation/RootNavigator';
import { RecordsUnreadableScreen } from './src/screens/auth/RecordsUnreadableScreen';
import { watchConnection } from './src/services/connection';
import { syncReminders } from './src/services/reminders';
import { startSync } from './src/services/sync';
import { openShiftOf, useStore } from './src/store/useStore';
import { color } from './src/theme/theme';

const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: color.kaolin, card: color.paper, text: color.ink, border: color.rule, primary: color.ink },
};

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Barlow_500Medium,
    Barlow_600SemiBold,
    Barlow_700Bold,
    BarlowCondensed_600SemiBold,
    BarlowCondensed_700Bold,
  });
  const hydrated = useStore((s) => s.hydrated);
  // The records saved on this phone could not be read: the app says so, and does not open as a new phone.
  const recordsUnreadable = useStore((s) => s.recordsUnreadable);
  const ensureSeeded = useStore((s) => s.ensureSeeded);
  const { width } = useWindowDimensions();

  useEffect(() => {
    if (!hydrated) return;
    ensureSeeded();
    // Re-arm any lunch reminders for a shift that was already running.
    const { session, shifts, settings } = useStore.getState();
    const shift = session && keepsTime(settings.company) ? openShiftOf(shifts, session.employeeId, Date.now()) : undefined;
    if (session) void syncReminders(shift, settings.lunchReminders, rulesFor(settings.company.state));
  }, [hydrated, ensureSeeded]);

  // Watch for signal, and send what the company's server does not have once there is some,
  // to the company this phone is connected to, if any.
  useEffect(() => {
    if (!hydrated) return undefined;
    const stopSync = startSync();
    const stopLink = watchConnection();
    return () => {
      stopLink();
      stopSync();
    };
  }, [hydrated]);

  // If the fonts cannot load, carry on with the system font rather than a blank screen.
  const fontsReady = fontsLoaded || !!fontError;
  const ready = hydrated && fontsReady;
  // On a wide browser window the app sits in a phone-width column.
  const framed = Platform.OS === 'web' && width > 640;

  return (
    <SafeAreaProvider>
      {/* The app's own status bar, drawn first so it is the base: the no-signal strip and a screen with a coloured
          top, drawn after it, each put their own over it while they are there (ScreenStatusBar). */}
      <StatusBar style="auto" />
      <View style={[styles.root, framed && styles.rootFramed]}>
        <View style={[styles.app, framed && styles.appFramed]}>
          <SignalFrame>
            {/* A save of the records that could not be written is said over every screen, under the no-signal strip. */}
            <RecordsNotSavedFrame>
              {recordsUnreadable && fontsReady ? (
                <RecordsUnreadableScreen />
              ) : ready ? (
                // On the web the browser tab says MineMuster, not the name of the screen.
                <NavigationContainer theme={navTheme} documentTitle={{ formatter: () => APP_NAME }}>
                  <RootNavigator />
                </NavigationContainer>
              ) : (
                <View style={styles.loading}>
                  <ActivityIndicator color={color.yellow} size="large" />
                </View>
              )}
              {/* Inside the frames, so a message shows under the no-signal strip and that notice, not over them. */}
              <ToastHost />
            </RecordsNotSavedFrame>
          </SignalFrame>
        </View>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  rootFramed: { backgroundColor: color.ink, alignItems: 'center' },
  app: { flex: 1, width: '100%' },
  appFramed: { maxWidth: 480, backgroundColor: color.kaolin },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.ink },
});
