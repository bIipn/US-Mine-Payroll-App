import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CalendarDays, Clock, Menu, Truck, Users, type LucideIcon } from '../components/icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthScreen } from '../screens/auth/AuthScreen';
import { ClockScreen } from '../screens/clock/ClockScreen';
import { EndUseScreen } from '../screens/equipment/EndUseScreen';
import { EquipmentScreen } from '../screens/equipment/EquipmentScreen';
import { InspectionDetailScreen } from '../screens/equipment/InspectionDetailScreen';
import { InspectionResultScreen } from '../screens/equipment/InspectionResultScreen';
import { InspectionScreen } from '../screens/equipment/InspectionScreen';
import { MrfDetailScreen } from '../screens/equipment/MrfDetailScreen';
import { MrfFormScreen } from '../screens/equipment/MrfFormScreen';
import { HoursScreen } from '../screens/hours/HoursScreen';
import { ShiftDetailScreen } from '../screens/hours/ShiftDetailScreen';
import { MoreScreen } from '../screens/more/MoreScreen';
import { MyRecordsScreen } from '../screens/more/MyRecordsScreen';
import { SiteScreen } from '../screens/more/SiteScreen';
import { StandardsScreen } from '../screens/more/StandardsScreen';
import { CrewScreen } from '../screens/supervisor/CrewScreen';
import { FleetScreen } from '../screens/supervisor/FleetScreen';
import { MrfQueueScreen } from '../screens/supervisor/MrfQueueScreen';
import { OnSiteScreen } from '../screens/supervisor/OnSiteScreen';
import { PayrollEmployeeScreen } from '../screens/supervisor/PayrollEmployeeScreen';
import { PayrollScreen } from '../screens/supervisor/PayrollScreen';
import { RosterScreen } from '../screens/supervisor/RosterScreen';
import { SafetyLogScreen } from '../screens/supervisor/SafetyLogScreen';
import { TimeLogsScreen } from '../screens/supervisor/TimeLogsScreen';
import { haptic } from '../services/haptics';
import { useMe, useStore } from '../store/useStore';
import { color, font } from '../theme/theme';
import type { RootStackParamList, TabParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

const TAB: Record<keyof TabParamList, { label: string; icon: LucideIcon }> = {
  Clock: { label: 'Clock', icon: Clock },
  Equipment: { label: 'Equipment', icon: Truck },
  Hours: { label: 'My hours', icon: CalendarDays },
  Crew: { label: 'Crew', icon: Users },
  More: { label: 'More', icon: Menu },
};

/** Tall tabs with a painted yellow stripe over the one you are on. */
function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 6) }]}>
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const tab = TAB[route.name as keyof TabParamList];
        const Icon = tab.icon;
        return (
          <Pressable
            key={route.key}
            testID={`tab-${route.name}`}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: focused }}
            onPress={() => {
              haptic.tap();
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
            }}
            style={styles.tab}
          >
            <View style={[styles.stripe, focused && { backgroundColor: color.yellow }]} />
            <Icon color={focused ? color.ink : color.silica} size={27} strokeWidth={focused ? 2.5 : 2} />
            <Text style={[styles.tabLabel, { color: focused ? color.ink : color.silica }]} numberOfLines={1}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function MainTabs() {
  const me = useMe();
  return (
    <Tabs.Navigator screenOptions={{ headerShown: false }} tabBar={(props) => <TabBar {...props} />}>
      <Tabs.Screen name="Clock" component={ClockScreen} />
      <Tabs.Screen name="Equipment" component={EquipmentScreen} />
      <Tabs.Screen name="Hours" component={HoursScreen} />
      {me?.role === 'supervisor' ? <Tabs.Screen name="Crew" component={CrewScreen} /> : null}
      <Tabs.Screen name="More" component={MoreScreen} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const signedIn = useStore((s) => !!s.session && s.employees.some((e) => e.id === s.session?.employeeId && e.active));
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.kaolin } }}>
      {!signedIn ? (
        <Stack.Screen name="Auth" component={AuthScreen} />
      ) : (
        <>
          <Stack.Screen name="Main" component={MainTabs} />
          <Stack.Screen name="Inspection" component={InspectionScreen} />
          <Stack.Screen name="InspectionResult" component={InspectionResultScreen} options={{ gestureEnabled: false }} />
          <Stack.Screen name="InspectionDetail" component={InspectionDetailScreen} />
          <Stack.Screen name="EndUse" component={EndUseScreen} />
          <Stack.Screen name="MrfForm" component={MrfFormScreen} />
          <Stack.Screen name="MrfDetail" component={MrfDetailScreen} />
          <Stack.Screen name="ShiftDetail" component={ShiftDetailScreen} />
          <Stack.Screen name="Site" component={SiteScreen} />
          <Stack.Screen name="Standards" component={StandardsScreen} />
          <Stack.Screen name="MyRecords" component={MyRecordsScreen} />
          <Stack.Screen name="OnSite" component={OnSiteScreen} />
          <Stack.Screen name="TimeLogs" component={TimeLogsScreen} />
          <Stack.Screen name="SafetyLog" component={SafetyLogScreen} />
          <Stack.Screen name="MrfQueue" component={MrfQueueScreen} />
          <Stack.Screen name="Payroll" component={PayrollScreen} />
          <Stack.Screen name="PayrollEmployee" component={PayrollEmployeeScreen} />
          <Stack.Screen name="Roster" component={RosterScreen} />
          <Stack.Screen name="Fleet" component={FleetScreen} />
        </>
      )}
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: color.paper,
    borderTopWidth: 1,
    borderTopColor: color.rule,
  },
  tab: { flex: 1, alignItems: 'center', gap: 3, paddingBottom: 4, minHeight: 64 },
  stripe: { width: 44, height: 5, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, marginBottom: 7, backgroundColor: 'transparent' },
  tabLabel: { fontFamily: font.bodySemi, fontSize: 13, lineHeight: 16 },
});
