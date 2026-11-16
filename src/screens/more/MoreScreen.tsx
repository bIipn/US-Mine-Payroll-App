import { useNavigation } from '@react-navigation/native';
import { Banknote, BookOpen, Building2, ClipboardList, LogOut, MapPin, RotateCcw, Scale } from '../../components/icons';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { DecimalChart } from '../../components/DecimalChart';
import { RateSheet } from '../../components/PayEstimate';
import { Avatar, Button, Divider, Panel, Row, Sheet, Tag, Toggle, TopBar, Txt } from '../../components/ui';
import { APP_NAME, DEMO_MODE, SAMPLE_CREW } from '../../config';
import { requestNotificationPermission } from '../../services/notifications';
import { syncReminders } from '../../services/reminders';
import { openShiftOf, useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtMoney, fullName, initials } from '../../util/format';

/**
 * Starting a preview over. With the sample crew that reloads their sample history. Without
 * them there is nothing to reload: it erases what people entered and leaves the build as it starts.
 */
const RESET = SAMPLE_CREW
  ? {
      title: 'Reset the sample data',
      sub: 'Clears everything on this device and reloads the sample crew.',
      ask: 'Reset the sample data?',
      warning: 'Every punch, checklist, exam and request made on this device is erased and the sample crew is loaded again. You will be signed out.',
      button: 'Reset sample data',
    }
  : {
      title: 'Clear this device',
      sub: 'Erases every punch, checklist, exam and request made on this device.',
      ask: 'Clear this device?',
      warning:
        'Every punch, checklist, exam, request and account made on this device is erased. The roster, the area sheets and the equipment list go back to how this build starts. You will be signed out.',
      button: 'Clear this device',
    };

export function MoreScreen() {
  const navigation = useNavigation();
  const me = useMe();
  const account = useStore((s) => s.accounts.find((a) => a.id === s.session?.accountId));
  const settings = useStore((s) => s.settings);
  const rate = useStore((s) => (s.session ? s.payRates[s.session.employeeId] : undefined));
  const { setLunchReminders, setAllowSectionAllOk, signOut, resetDemo, showToast } = useStore.getState();
  const [chart, setChart] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  if (!me) return null;

  const toggleReminders = async (on: boolean) => {
    setLunchReminders(on);
    if (on && !(await requestNotificationPermission())) {
      showToast('Notifications are off for this app. Turn them on in your phone settings to get lunch reminders.', 'warn');
    }
    const { shifts } = useStore.getState();
    void syncReminders(openShiftOf(shifts, me.id, Date.now()), on);
  };

  return (
    <View style={styles.root}>
      <TopBar title="More" />
      <ScrollView testID="more-screen" contentContainerStyle={styles.content}>
        <Panel>
          <View style={styles.profile}>
            <Avatar initials={initials(me.firstName, me.lastName)} size={60} />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="h3">{fullName(me)}</Txt>
              {me.title ? <Txt v="small" c={color.silica}>{me.title}</Txt> : null}
              {account ? <Txt v="small" c={color.silica}>{account.email}</Txt> : null}
            </View>
            {me.role === 'supervisor' ? <Tag label="Supervisor" tone="ink" solid /> : null}
          </View>
        </Panel>

        <Panel flush>
          <Row testID="more-site" left={<MapPin color={color.ink} size={24} />} title="Mine boundary and GPS" sub="Where you can clock in from" chevron onPress={() => navigation.navigate('Site')} />
          <Divider inset={space.lg} />
          <Row testID="more-records" left={<ClipboardList color={color.ink} size={24} />} title="My checklists, exams and requests" sub="Everything you have signed or sent" chevron onPress={() => navigation.navigate('MyRecords')} />
          <Divider inset={space.lg} />
          <Row testID="more-standards" left={<BookOpen color={color.ink} size={24} />} title="Safety standards" sub="The MSHA and OSHA rules behind each line" chevron onPress={() => navigation.navigate('Standards')} />
          <Divider inset={space.lg} />
          <Row testID="more-chart" left={<Scale color={color.ink} size={24} />} title="Minutes as decimals" sub="The timesheet conversion chart" chevron onPress={() => setChart(true)} />
          <Divider inset={space.lg} />
          <Row
            testID="more-rate"
            left={<Banknote color={color.ink} size={24} />}
            title="My hourly rate"
            sub={rate ? `${fmtMoney(rate)} an hour, used to estimate your pay` : 'Add it to see what each check should come to'}
            chevron
            onPress={() => setRateOpen(true)}
          />
        </Panel>

        <Panel title="Reminders" flush>
          <Toggle
            testID="toggle-reminders"
            label="Lunch reminders"
            sub="60, 30 and 15 minutes before your fifth hour ends. You are told when your lunch is over either way."
            value={settings.lunchReminders}
            onChange={toggleReminders}
          />
        </Panel>

        {me.role === 'supervisor' ? (
          <Panel title="Company" flush>
            <Row
              testID="more-company"
              left={<Building2 color={color.ink} size={24} />}
              title={settings.company.name || 'Company details'}
              sub={settings.company.name ? 'Name, state and pay periods' : 'Give the company’s name, state and pay periods'}
              chevron
              onPress={() => navigation.navigate('Company')}
            />
          </Panel>
        ) : null}

        {me.role === 'supervisor' ? (
          <Panel title="Checklist settings" flush>
            <Toggle
              testID="toggle-all-ok"
              label={'Allow "Rest are OK"'}
              sub="Lets a person mark the unanswered lines of a checklist or an exam OK with one tap. Turn off to make them answer every line."
              value={settings.allowSectionAllOk}
              onChange={setAllowSectionAllOk}
            />
          </Panel>
        ) : null}

        {DEMO_MODE ? (
          <Panel title="Preview" flush>
            <Row
              testID="reset-demo"
              left={<RotateCcw color={color.ink} size={24} />}
              title={RESET.title}
              sub={RESET.sub}
              onPress={() => setConfirmReset(true)}
            />
          </Panel>
        ) : null}

        <Button testID="sign-out" label="Sign out" icon={LogOut} kind="outline" onPress={signOut} />
        <Txt v="small" c={color.silica} center testID="build-note">
          {APP_NAME}{!DEMO_MODE ? '' : SAMPLE_CREW ? ', preview build on sample data' : ', preview build. What you enter stays on this device.'}
        </Txt>
      </ScrollView>

      <DecimalChart visible={chart} onClose={() => setChart(false)} />
      <RateSheet visible={rateOpen} onClose={() => setRateOpen(false)} />
      <Sheet testID="reset-sheet" visible={confirmReset} onClose={() => setConfirmReset(false)} title={RESET.ask}>
        <Txt v="body" c={color.inkSoft}>{RESET.warning}</Txt>
        <Button testID="confirm-reset" label={RESET.button} kind="red" onPress={() => { setConfirmReset(false); resetDemo(); }} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.xl },
  profile: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
});
