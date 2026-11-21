import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CalendarDays, ClipboardCheck, Clock, Menu, Users, type LucideIcon } from '../components/icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { keepsTime } from '../domain/company';
import { AuthScreen } from '../screens/auth/AuthScreen';
import { ClockScreen } from '../screens/clock/ClockScreen';
import { ChecklistCardScreen } from '../screens/equipment/ChecklistCardScreen';
import { EndUseScreen } from '../screens/equipment/EndUseScreen';
import { EquipmentScreen } from '../screens/equipment/EquipmentScreen';
import { InspectionDetailScreen } from '../screens/equipment/InspectionDetailScreen';
import { InspectionResultScreen } from '../screens/equipment/InspectionResultScreen';
import { InspectionScreen } from '../screens/equipment/InspectionScreen';
import { MrfDetailScreen } from '../screens/equipment/MrfDetailScreen';
import { MrfFormScreen } from '../screens/equipment/MrfFormScreen';
import { AreaExamDetailScreen } from '../screens/exam/AreaExamDetailScreen';
import { AreaExamScreen } from '../screens/exam/AreaExamScreen';
import { HoursScreen } from '../screens/hours/HoursScreen';
import { ShiftDetailScreen } from '../screens/hours/ShiftDetailScreen';
import { MoreScreen } from '../screens/more/MoreScreen';
import { CompanyScreen } from '../screens/more/CompanyScreen';
import { DeleteAccountScreen } from '../screens/more/DeleteAccountScreen';
import { MyRecordsScreen } from '../screens/more/MyRecordsScreen';
import { SiteScreen } from '../screens/more/SiteScreen';
import { StandardsScreen } from '../screens/more/StandardsScreen';
import { AreaSheetsScreen } from '../screens/supervisor/AreaSheetsScreen';
import { CrewScreen } from '../screens/supervisor/CrewScreen';
import { FleetScreen } from '../screens/supervisor/FleetScreen';
import { MrfQueueScreen } from '../screens/supervisor/MrfQueueScreen';
import { OnSiteScreen } from '../screens/supervisor/OnSiteScreen';
import { PayrollEmployeeScreen } from '../screens/supervisor/PayrollEmployeeScreen';
import { PayrollScreen } from '../screens/supervisor/PayrollScreen';
import { RosterScreen } from '../screens/supervisor/RosterScreen';
import { SafetyLogScreen } from '../screens/supervisor/SafetyLogScreen';
import { TimeLogsScreen } from '../screens/supervisor/TimeLogsScreen';
import { CAN_CONNECT } from '../services/connection';
import { haptic } from '../services/haptics';
import { signedInView } from '../domain/access';
import { openShiftOf, useMe, useStore, useSupervisorHere } from '../store/useStore';
import { color, font } from '../theme/theme';
import type { RootStackParamList, ScreenProps, TabParamList } from './types';

/**
 * The Company account screen is in a build only when the build names a company server and is not a
 * preview, the same way the server code is (`src/services/connection.ts`): in any other build, this is
 * dropped before bundling.
 */
const CompanyAccountScreen: React.ComponentType<ScreenProps<'CompanyAccount'>> | null =
  process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_KEY && process.env.EXPO_PUBLIC_DEMO === '0'
    ? require('../screens/more/CompanyAccountScreen').CompanyAccountScreen
    : null;

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

const TAB: Record<keyof TabParamList, { label: string; icon: LucideIcon }> = {
  Clock: { label: 'Clock', icon: Clock },
  // The route keeps its first name; the tab now holds both checklists.
  Equipment: { label: 'Checklists', icon: ClipboardCheck },
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
  const supervisor = useSupervisorHere();
  // A company that uses the app for the safety forms only has no clock and no hours, so its first tab is the checklists.
  // Someone on the clock keeps the clock and their hours until they clock out, though the office turned the clock off.
  const time = useStore((s) => keepsTime(s.settings.company) || (!!s.session && !!openShiftOf(s.shifts, s.session.employeeId, Date.now())));
  return (
    <Tabs.Navigator screenOptions={{ headerShown: false }} tabBar={(props) => <TabBar {...props} />}>
      {time ? <Tabs.Screen name="Clock" component={ClockScreen} /> : null}
      <Tabs.Screen name="Equipment" component={EquipmentScreen} />
      {time ? <Tabs.Screen name="Hours" component={HoursScreen} /> : null}
      {supervisor ? <Tabs.Screen name="Crew" component={CrewScreen} /> : null}
      <Tabs.Screen name="More" component={MoreScreen} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  // Nobody on the clock is signed out: someone taken off the roster, or the person this phone's sign-in is for once
  // that sign-in is off the company's roster, keeps the Clock screen alone, and End use, until they clock out.
  const view = useStore((s) => {
    if (!s.session) return 'out';
    const person = s.employees.find((e) => e.id === s.session?.employeeId);
    const onTheClock = !!person && !!openShiftOf(s.shifts, person.id, Date.now());
    return signedInView({ person, onTheClock, connected: !!s.connectedCompany, receiving: s.receiving });
  });
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.kaolin } }}>
      {/* Each view is a group of its own: moving to another view (signing in, signing out, deleting the
          account) takes the last view's screens off the stack, even ones both views have, such as
          DeleteAccount, so nobody is left on a screen of a view they are no longer in. */}
      {view === 'out' ? (
        <Stack.Group navigationKey="out">
          <Stack.Screen name="Auth" component={AuthScreen} />
          {/* A new phone connects to its company from the sign-in screen, so it has the company's roster first. */}
          {CAN_CONNECT && CompanyAccountScreen ? <Stack.Screen name="CompanyAccount" component={CompanyAccountScreen} /> : null}
          {/* A company sign-in with no account on this phone is deleted from there too. */}
          {CAN_CONNECT && CompanyAccountScreen ? <Stack.Screen name="DeleteAccount" component={DeleteAccountScreen} /> : null}
        </Stack.Group>
      ) : view === 'clock_only' ? (
        <Stack.Group navigationKey="clock_only">
          <Stack.Screen name="Main" component={ClockScreen} />
          <Stack.Screen name="EndUse" component={EndUseScreen} />
          <Stack.Screen name="Site" component={SiteScreen} />
        </Stack.Group>
      ) : (
        <Stack.Group navigationKey="full">
          <Stack.Screen name="Main" component={MainTabs} />
          <Stack.Screen name="Inspection" component={InspectionScreen} />
          <Stack.Screen name="InspectionResult" component={InspectionResultScreen} options={{ gestureEnabled: false }} />
          <Stack.Screen name="InspectionDetail" component={InspectionDetailScreen} />
          <Stack.Screen name="ChecklistCard" component={ChecklistCardScreen} />
          <Stack.Screen name="EndUse" component={EndUseScreen} />
          <Stack.Screen name="AreaExam" component={AreaExamScreen} />
          <Stack.Screen name="AreaExamDetail" component={AreaExamDetailScreen} />
          <Stack.Screen name="AreaSheets" component={AreaSheetsScreen} />
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
          <Stack.Screen name="Company" component={CompanyScreen} />
          <Stack.Screen name="DeleteAccount" component={DeleteAccountScreen} />
          {CAN_CONNECT && CompanyAccountScreen ? <Stack.Screen name="CompanyAccount" component={CompanyAccountScreen} /> : null}
        </Stack.Group>
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
