import { useNavigation } from '@react-navigation/native';
import { Banknote, BookOpen, Building2, ClipboardList, CloudCheck, CloudUpload, Link2, LogOut, MapPin, RotateCcw, Scale, WifiOff } from '../../components/icons';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { DecimalChart } from '../../components/DecimalChart';
import { RateSheet } from '../../components/PayEstimate';
import { Avatar, Button, Divider, Panel, Row, Sheet, Tag, Toggle, TopBar, Txt } from '../../components/ui';
import { WebPageLinks } from '../../components/WebPageLinks';
import { APP_NAME, DEMO_MODE, SAMPLE_CREW } from '../../config';
import { keepsTime } from '../../domain/company';
import { notTakenWords } from '../../domain/receive';
import { receiveWords, syncWords } from '../../domain/sync';
import { deadlineWords } from '../../domain/time';
import { CAN_CONNECT, disconnect, useServerAccount } from '../../services/connection';
import { requestNotificationPermission } from '../../services/notifications';
import { syncReminders } from '../../services/reminders';
import { notTakenChanges, useSyncStatus } from '../../services/sync';
import { openShiftOf, useMe, useRules, useStore, useSupervisorHere } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtMoney, fmtTime, fullName, initials } from '../../util/format';

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
  const supervisor = useSupervisorHere();
  const account = useStore((s) => s.accounts.find((a) => a.id === s.session?.accountId));
  const settings = useStore((s) => s.settings);
  const rules = useRules();
  const rate = useStore((s) => (s.session ? s.payRates[s.session.employeeId] : undefined));
  const linked = useStore((s) => s.connectedCompany);
  const server = useServerAccount();
  const { setLunchReminders, setAllowSectionAllOk, signOut, clearDevice, showToast } = useStore.getState();
  const [chart, setChart] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const sync = useSyncStatus();
  // A company that uses the app for the safety forms only has no clock, hours, rate or lunch reminders here.
  const time = keepsTime(settings.company);

  if (!me) return null;
  const records = syncWords(sync, fmtTime);
  const RecordsIcon = !sync.online ? WifiOff : records.done ? CloudCheck : CloudUpload;
  // What comes from the company, under what goes to it.
  const receiving = useStore.getState().receiving;
  const fromCompany = linked
    ? receiveWords(
        {
          connected: true,
          online: sync.online,
          role: receiving?.role ?? null,
          caughtUpAt: receiving?.caughtUpAt ?? null,
          closed: sync.trouble === 'closed',
          unreadable: receiving?.unreadable.length ?? 0,
          notTaken: sync.notTaken,
          company: linked.name,
          email: linked.email ?? null,
        },
        fmtTime,
      )
    : null;
  // Where this phone stands with its company: said here, not only on the account screen, so a
  // phone that has stopped sending says so where the person looks.
  const serverLine = !linked
    ? { sub: 'Sign in to send records to your company', warn: false }
    : server.known && !server.account
      ? { sub: `Signed out. Sign in to keep sending to ${linked.name}.`, warn: true }
      : server.notOnLinked
        ? { sub: `This account is not on ${linked.name}’s roster. Nothing is sent.`, warn: true }
        : { sub: `Connected to ${linked.name}`, warn: false };
  // Clearing a device that keeps real records is a supervisor's to do: what has not reached the server is lost.
  const canClear = DEMO_MODE || (CAN_CONNECT && supervisor);

  const toggleReminders = async (on: boolean) => {
    setLunchReminders(on);
    if (on && !(await requestNotificationPermission())) {
      showToast('Notifications are off for this app. Turn them on in your phone settings to get lunch reminders.', 'warn');
    }
    const { shifts } = useStore.getState();
    void syncReminders(openShiftOf(shifts, me.id, Date.now()), on, rules);
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
          {time ? (
            <>
              <Row testID="more-site" left={<MapPin color={color.ink} size={24} />} title="Mine boundary and GPS" sub="Where you can clock in from" chevron onPress={() => navigation.navigate('Site')} />
              <Divider inset={space.lg} />
            </>
          ) : null}
          <Row testID="more-records" left={<ClipboardList color={color.ink} size={24} />} title="My checklists, exams and requests" sub="Everything you have signed or sent" chevron onPress={() => navigation.navigate('MyRecords')} />
          <Divider inset={space.lg} />
          <Row testID="more-standards" left={<BookOpen color={color.ink} size={24} />} title="Safety standards" sub="The MSHA and OSHA rules behind each line" chevron onPress={() => navigation.navigate('Standards')} />
          {time ? (
            <>
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
            </>
          ) : null}
        </Panel>

        <Panel title="Records on this phone" flush>
          <Row
            testID="more-sync"
            left={<RecordsIcon color={color.ink} size={24} />}
            title={records.title}
            sub={fromCompany ? `${records.sub}\n${fromCompany.line}` : records.sub}
            subColor={records.warn || fromCompany?.warn ? color.red : undefined}
            subLines={6}
          />
          {CAN_CONNECT ? (
            <>
              <Divider inset={space.lg} />
              <Row
                testID="more-server"
                left={<Link2 color={color.ink} size={24} />}
                title="Company account"
                sub={serverLine.sub}
                subColor={serverLine.warn ? color.red : undefined}
                subLines={3}
                chevron
                onPress={() => navigation.navigate('CompanyAccount')}
              />
            </>
          ) : null}
        </Panel>

        {linked ? <NotTaken /> : null}
        {linked ? <FromTheCompany /> : null}

        {time ? (
          <Panel title="Reminders" flush>
            <Toggle
              testID="toggle-reminders"
              label="Lunch reminders"
              sub={
                rules.meal?.startByMs != null
                  ? `60, 30 and 15 minutes before ${deadlineWords(rules.meal.startByMs).replace('the ', 'your ')} ends. You are told when your lunch is over either way.`
                  : 'There is no lunch deadline to remind you of where you work. You are told when your lunch is over either way.'
              }
              value={settings.lunchReminders}
              onChange={toggleReminders}
            />
          </Panel>
        ) : null}

        {supervisor ? (
          <Panel title="Company" flush>
            <Row
              testID="more-company"
              left={<Building2 color={color.ink} size={24} />}
              title={settings.company.name || 'Company details'}
              sub={
                !settings.company.name
                  ? 'Give the company’s name, state and pay periods'
                  : time
                    ? 'Name, state and pay periods'
                    : 'Name, state and the safety forms only'
              }
              chevron
              onPress={() => navigation.navigate('Company')}
            />
          </Panel>
        ) : null}

        {supervisor ? (
          <Panel title="Checklist settings" flush>
            <Toggle
              testID="toggle-all-ok"
              label={'Allow "Rest are OK"'}
              sub="Lets a person mark the unanswered lines of a checklist or an exam OK with one tap. Turn off to make them answer every line."
              value={settings.allowSectionAllOk}
              onChange={(on) => {
                const done = setAllowSectionAllOk(on);
                if (!done.ok) showToast(done.error, 'bo');
              }}
            />
          </Panel>
        ) : null}

        <WebPageLinks testID="more-pages" />

        {canClear ? (
          <Panel title={DEMO_MODE ? 'Preview' : 'This phone'} flush>
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
        {linked ? <Txt v="body" c={color.inkSoft}>This also disconnects the phone from {linked.name} and signs it out of the company server.</Txt> : null}
        {sync.server && sync.waiting > 0 ? (
          <Txt v="strong" c={color.red} testID="reset-unsent">
            {sync.waiting} {sync.waiting === 1 ? 'record has' : 'records have'} not reached the company’s server yet and would be lost.
          </Txt>
        ) : null}
        <Button
          testID="confirm-reset"
          label={RESET.button}
          kind="red"
          onPress={() => {
            setConfirmReset(false);
            // The device forgets the company it sent to and signs out of the server, along with everything else.
            const result = clearDevice();
            if (!result.ok) {
              showToast(result.error, 'bo');
              return;
            }
            if (CAN_CONNECT) void disconnect();
          }}
        />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.xl },
  profile: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
});

/** What the company did not take from this phone's sign-in, each with why and what to do. */
function NotTaken() {
  const sync = useSyncStatus();
  const receiving = useStore((s) => s.receiving);
  const data = useStore((s) => s);
  const dismissHeld = useStore((s) => s.dismissHeld);
  void sync.notTaken;
  const items = notTakenChanges().filter((c) => !receiving?.held[c.key]?.seen);
  if (!items.length) return null;
  return (
    <Panel title="Not taken by the company" flush>
      {items.map((c, i) => {
        const { what, why } = notTakenWords(c, receiving?.held[c.key]?.reason ?? 'supervisor_only', data);
        return (
          <View key={c.key}>
            {i > 0 ? <Divider inset={space.lg} /> : null}
            <Row testID={`not-taken-${c.key}`} title={what} sub={why} subLines={4} right={<Button label="Done" kind="quiet" size="md" onPress={() => dismissHeld([c])} />} />
          </View>
        );
      })}
    </Panel>
  );
}

/** What of a change made here the company's newer version stood over, said once. */
function FromTheCompany() {
  const notices = useStore((s) => s.receiving?.notices ?? []);
  const dismissNotice = useStore((s) => s.dismissNotice);
  const unseen = notices.filter((n) => !n.seen);
  if (!unseen.length) return null;
  return (
    <Panel title="From the company" flush>
      {unseen.map((n, i) => (
        <View key={n.id}>
          {i > 0 ? <Divider inset={space.lg} /> : null}
          <Row testID={`notice-${n.id}`} title={n.words} titleLines={6} sub={fmtTime(n.at)} right={<Button label="Done" kind="quiet" size="md" onPress={() => dismissNotice(n.id)} />} />
        </View>
      ))}
    </Panel>
  );
}
