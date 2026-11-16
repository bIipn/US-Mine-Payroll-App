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
import { ToastHost } from './src/components/ui';
import { RootNavigator } from './src/navigation/RootNavigator';
import { syncReminders } from './src/services/reminders';
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
  const ensureSeeded = useStore((s) => s.ensureSeeded);
  const { width } = useWindowDimensions();

  useEffect(() => {
    if (!hydrated) return;
    ensureSeeded();
    // Re-arm any lunch reminders for a shift that was already running.
    const { session, shifts, settings } = useStore.getState();
    if (session) void syncReminders(openShiftOf(shifts, session.employeeId, Date.now()), settings.lunchReminders, rulesFor(settings.company.state));
  }, [hydrated, ensureSeeded]);

  // If the fonts cannot load, carry on with the system font rather than a blank screen.
  const ready = hydrated && (fontsLoaded || !!fontError);
  // On a wide browser window the app sits in a phone-width column.
  const framed = Platform.OS === 'web' && width > 640;

  return (
    <SafeAreaProvider>
      <View style={[styles.root, framed && styles.rootFramed]}>
        <View style={[styles.app, framed && styles.appFramed]}>
          {/* On the web the browser tab says MineMuster, not the name of the screen. */}
          {ready ? (
            <NavigationContainer theme={navTheme} documentTitle={{ formatter: () => APP_NAME }}>
              <RootNavigator />
            </NavigationContainer>
          ) : (
            <View style={styles.loading}>
              <ActivityIndicator color={color.yellow} size="large" />
            </View>
          )}
          <ToastHost />
        </View>
      </View>
      <StatusBar style="auto" />
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
