import { useNavigation } from '@react-navigation/native';
import { BellRing, ChevronRight, ClipboardCheck, Coffee, Factory, FastForward, LogIn, LogOut, MapPin, Rewind, Utensils, Wrench } from '../../components/icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { CompanyLogoPlate } from '../../components/Brand';
import { SiteMap } from '../../components/SiteMap';
import { TimeCard } from '../../components/TimeCard';
import { Button, Divider, Notice, Panel, ProgressBar, Row, Segmented, Sheet, Tag, Txt, UnitPlate } from '../../components/ui';
import { APP_NAME, DEMO_MODE } from '../../config';
import { checkFix, toGeoStamp, type FixVerdict } from '../../domain/geofence';
import { monthOf, nextPayday, payPeriodOf } from '../../domain/payPeriod';
import { computeRange } from '../../domain/payroll';
import { deadlineWords, floorMin, lunchEndAt, lunchOverReminder, MEAL_NOTE_LABEL, mealStatus, shiftTotals, type TimeRules } from '../../domain/time';
import type { DemoLocation, GeoStamp, MealNote, Shift } from '../../domain/types';
import { haptic } from '../../services/haptics';
import { locate } from '../../services/location';
import { requestNotificationPermission, scheduleLocal } from '../../services/notifications';
import { syncReminders } from '../../services/reminders';
import { openLogs, openShiftOf, staleShiftOf, useMe, useRules, useStore } from '../../store/useStore';
import { color, font, radius, space, type Tone } from '../../theme/theme';
import {
  addDays,
  clockParts,
  fmtCountdown,
  fmtDate,
  fmtDateLong,
  fmtDistance,
  fmtDur,
  fmtHrs,
  fmtRange,
  fmtTime,
  fullName,
  MIN,
  startOfDay,
  startOfWeek,
} from '../../util/format';
import { useNow } from '../../util/hooks';

type Status = 'off' | 'on' | 'lunch' | 'overdue';
/** Why a clock-in did not go through. Clock-in is the only punch that needs the person at the mine. */
type Problem =
  | { kind: Exclude<FixVerdict, 'inside'>; geo: GeoStamp }
  | { kind: 'denied' | 'unavailable' | 'no_site' };

const FIELD: Record<Status, { bg: string; fg: string; muted: string; label: string; bar: 'light' | 'dark' }> = {
  off: { bg: color.ink, fg: color.white, muted: color.onDarkMuted, label: 'Off the clock', bar: 'light' },
  on: { bg: color.yellow, fg: color.ink, muted: color.inkSoft, label: 'On the clock', bar: 'dark' },
  lunch: { bg: color.blue, fg: color.white, muted: '#D5E4EE', label: 'At lunch', bar: 'light' },
  overdue: { bg: color.red, fg: color.white, muted: '#F6D9D3', label: 'Lunch is overdue', bar: 'light' },
};

export function ClockScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const now = useNow(1000);
  const me = useMe();
  const shifts = useStore((s) => s.shifts);
  const settings = useStore((s) => s.settings);
  const rules = useRules();
  const company = settings.company;
  const equipment = useStore((s) => s.equipment);
  const opLogs = useStore((s) => s.opLogs);
  const gone = useStore((s) => s.receiving?.gone);
  /** Why this person may only clock out here: taken off the roster, or this phone's sign-in no longer on the company's. */
  const held = useStore((s) => {
    const person = s.employees.find((e) => e.id === s.session?.employeeId);
    if (person && !person.active) return 'You are no longer on the active roster. Clock out when you are done, then see your supervisor.';
    if (s.connectedCompany && s.receiving?.role === 'none') {
      return `This phone is not joined to ${s.connectedCompany.name} any more, so a clock-in here would never reach payroll. Clock out when you are done, then see your supervisor.`;
    }
    return null;
  });
  const actions = useStore.getState();

  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirmOut, setConfirmOut] = useState(false);
  const [mealNote, setMealNote] = useState<MealNote | null>(null);
  /** Whether the phone will let the lunch-is-over notice through. Unknown until a lunch is started. */
  const [notifyOk, setNotifyOk] = useState<boolean | null>(null);

  if (!me) return null;

  const shift = openShiftOf(shifts, me.id, now);
  const stale = staleShiftOf(shifts, me.id, now);
  const today = startOfDay(now);
  const lastToday = [...shifts].reverse().find((s) => s.employeeId === me.id && s.clockOut && s.clockIn.at >= today);
  const cardShift = shift ?? lastToday;

  const totals = shift ? shiftTotals(shift, now) : undefined;
  const meal = shift ? mealStatus(shift, now, rules) : undefined;
  const status: Status = !shift ? 'off' : meal?.state === 'at_lunch' ? 'lunch' : meal?.state === 'overdue' ? 'overdue' : 'on';
  const field = FIELD[status];
  const clock = clockParts(now);
  const myUnits = [...openLogs(opLogs).values()].filter((log) => log.employeeId === me.id);
  // A clock-out with no lunch asks why only where the state owes a meal on a shift that long.
  const owed = rules.meal;
  // Measured in whole minutes, the way the shift's flags are, so the sheet and the saved shift agree.
  const elapsed = shift ? floorMin(now) - floorMin(shift.clockIn.at) : 0;
  const needsMealNote = !!shift && !!owed && shift.lunches.length === 0 && elapsed >= owed.owedAfterMs;
  const canWaive = !!shift && owed?.waiverMaxMs != null && elapsed <= owed.waiverMaxMs;

  /**
   * Read the phone's position for a punch. Returns null when the punch must not
   * go ahead. Only clock-in has to be made at the mine. There is no punch at the
   * end of lunch, so no location is read then.
   */
  const readLocation = async (action: 'clock_in' | 'start_lunch' | 'clock_out'): Promise<GeoStamp | undefined | null> => {
    const mustBeOnSite = action === 'clock_in';
    const site = settings.site;
    if (!site) {
      // With no boundary there is nothing to check a clock-in against, and nothing to measure anything else from.
      if (!mustBeOnSite) return undefined;
      haptic.error();
      setProblem({ kind: 'no_site' });
      return null;
    }
    setBusy(action);
    const result = await locate(site, settings.demoLocation);
    setBusy(null);
    if (!result.ok) {
      if (!mustBeOnSite) return undefined;
      haptic.error();
      setProblem({ kind: result.reason });
      return null;
    }
    const check = checkFix(site, result.fix);
    const geo = toGeoStamp(site, result.fix, result.source);
    if (mustBeOnSite && check.verdict !== 'inside') {
      haptic.error();
      actions.logDenied('clock_in', check.verdict === 'outside' ? 'outside' : check.verdict, geo);
      setProblem({ kind: check.verdict, geo });
      return null;
    }
    return geo;
  };

  const finish = (result: { ok: true; shift: Shift } | { ok: false; error: string }, message: string, off = false) => {
    if (!result.ok) {
      haptic.error();
      actions.showToast(result.error, 'bo');
      return;
    }
    haptic.success();
    actions.showToast(message);
    void armNotices(off ? undefined : result.shift);
  };

  /**
   * Line the phone's scheduled notices up with the shift. While on a shift it
   * first asks, once, whether notices are allowed: the lunch-is-over notice can
   * only reach a locked phone if they are. This runs after the punch is on
   * record, so answering the phone's question never changes a punch time.
   */
  const armNotices = async (current: Shift | undefined) => {
    if (current) setNotifyOk(await requestNotificationPermission());
    await syncReminders(current, settings.lunchReminders, rules);
  };

  const clockIn = async () => {
    const geo = await readLocation('clock_in');
    if (!geo) return;
    finish(actions.clockIn(geo), `Clocked in at ${fmtTime(Date.now())}`);
  };
  // One tap. The lunch ends by itself 30 minutes later and the app says so.
  const startLunch = async () => {
    const geo = await readLocation('start_lunch');
    if (geo === null) return;
    const result = actions.startLunch(geo);
    const lunch = result.ok ? result.shift.lunches[result.shift.lunches.length - 1] : undefined;
    finish(result, lunch ? `Lunch started. Back on the clock at ${fmtTime(lunchEndAt(lunch))}.` : '');
  };
  const toggleBreak = () => {
    const wasOnBreak = totals?.onBreak;
    finish(actions.toggleBreak(), wasOnBreak ? 'Rest break ended' : 'Rest break started. Breaks are paid.');
  };
  const clockOut = async () => {
    setConfirmOut(false);
    const geo = await readLocation('clock_out');
    if (geo === null) return;
    finish(actions.clockOut(geo, mealNote ?? undefined), `Clocked out at ${fmtTime(Date.now())}`, true);
    setMealNote(null);
  };
  const retry = () => {
    setProblem(null);
    void clockIn();
  };

  const lastLunch = shift?.lunches[shift.lunches.length - 1];
  const lastGeo = shift?.clockIn.geo;
  const gpsLine =
    DEMO_MODE && settings.demoLocation === 'at_mine'
      ? 'Demo GPS: at the mine'
      : DEMO_MODE && settings.demoLocation === 'in_town'
        ? 'Demo GPS: in town'
        : lastGeo
          ? `Punched in on site, ${fmtDistance(lastGeo.distanceM)} from the pin`
          : 'GPS is checked when you punch';

  return (
    <View style={styles.root}>
      <StatusBar style={field.bar} />
      <ScrollView testID="clock-screen" contentContainerStyle={{ paddingBottom: space.xxl }}>
        {/* The whole top of the screen takes the colour of where you stand. */}
        <View testID={`status-${status}`} style={[styles.field, { backgroundColor: field.bg, paddingTop: insets.top + space.md }]}>
          {/* With a logo, the location line goes under it, where it has the whole width. */}
          <View style={company.logo ? styles.fieldTopStacked : styles.fieldTop}>
            <CompanyLogoPlate logo={company.logo} name={company.name} width={136} radius={6} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${gpsLine}. Open the boundary map.`}
              hitSlop={10}
              onPress={() => navigation.navigate('Site')}
              style={styles.gps}
            >
              <View style={{ flexShrink: 0 }}>
                <MapPin color={field.fg} size={18} strokeWidth={2.5} />
              </View>
              <Text style={[styles.gpsText, { color: field.fg }]} numberOfLines={2}>{gpsLine}</Text>
            </Pressable>
          </View>

          <Txt v="h2" c={field.fg} style={{ marginTop: space.lg }} accessibilityRole="header">
            {field.label}
          </Txt>
          <View style={styles.clockRow} accessibilityLabel={`${clock.hm} ${clock.ampm}`}>
            <Text style={[styles.clock, { color: field.fg }]}>{clock.hm}</Text>
            <View style={{ paddingBottom: 12 }}>
              <Text style={[styles.clockSec, { color: field.muted }]}>:{clock.sec}</Text>
              <Text style={[styles.clockSec, { color: field.fg }]}>{clock.ampm}</Text>
            </View>
          </View>
          <Txt v="body" c={field.muted}>{fmtDateLong(now)}</Txt>
        </View>

        <View style={styles.body}>
          <View style={{ marginTop: -44 }}>
            <TimeCard shift={cardShift} now={now} name={fullName(me)} dateLabel={fmtDate(cardShift?.clockIn.at ?? now)} corner={field.bg} />
          </View>

          {/* One main action for where you are in the day. */}
          {status === 'off' ? (
            <Button testID="clock-in" label="Clock in" icon={LogIn} size="xl" kind="yellow" loading={busy === 'clock_in'} onPress={clockIn} />
          ) : null}

          {/* At lunch there is nothing to tap: it ends by itself and the app says so. */}
          {status === 'lunch' && lastLunch && meal ? (
            <LunchTimer
              startedAt={lastLunch.start.at}
              endsAt={lunchEndAt(lastLunch)}
              remainingMs={meal.lunchRemainingMs}
              elapsedMs={meal.lunchElapsedMs}
              notifyOk={notifyOk !== false}
            />
          ) : null}
          <LunchOverWatcher atLunch={status === 'lunch'} shiftId={shift?.id} />

          {(status === 'on' || status === 'overdue') && shift && meal ? (
            <>
              {shift.lunches.length === 0 && meal.deadlineAt != null ? <LunchDeadline shift={shift} now={now} rules={rules} /> : null}
              {shift.lunches.length === 0 ? (
                <Button testID="start-lunch" label="Start lunch" icon={Utensils} size="xl" kind={status === 'overdue' ? 'red' : 'ink'} loading={busy === 'start_lunch'} onPress={startLunch} />
              ) : null}
              <Button
                testID="clock-out"
                label="Clock out"
                icon={LogOut}
                size={shift.lunches.length === 0 ? 'lg' : 'xl'}
                kind={shift.lunches.length === 0 ? 'outline' : 'ink'}
                loading={busy === 'clock_out'}
                onPress={() => setConfirmOut(true)}
              />
              <View style={styles.pair}>
                <Button
                  testID="rest-break"
                  style={{ flex: 1 }}
                  label={totals?.onBreak ? 'End rest break' : 'Rest break'}
                  icon={Coffee}
                  size="md"
                  kind={totals?.onBreak ? 'blue' : 'quiet'}
                  onPress={toggleBreak}
                />
                {shift.lunches.length > 0 ? (
                  <Button testID="another-lunch" style={{ flex: 1 }} label={shift.lunches.length === 1 ? '2nd lunch' : 'Lunch again'} icon={Utensils} size="md" kind="quiet" loading={busy === 'start_lunch'} onPress={startLunch} />
                ) : null}
              </View>
            </>
          ) : null}

          {stale ? (
            <Notice
              tone="warn"
              title={`Your ${fmtDate(stale.clockIn.at)} shift has no clock-out`}
              body="A supervisor has to set the end time before that day can be paid. You can clock in as normal today."
            />
          ) : null}

          {held ? <Notice tone="warn" title={held} /> : null}

          {shift ? <PreShiftChecks employeeId={me.id} now={now} /> : null}

          <AssignedToMe employeeId={me.id} />

          {myUnits.length > 0 ? (
            <Panel title="You have checked out" flush>
              {myUnits.map((log) => {
                const unit = equipment.find((e) => e.id === log.equipmentId) ?? gone?.[log.equipmentId];
                if (!unit) return null;
                const takenOut = !equipment.some((e) => e.id === log.equipmentId);
                return (
                  <Row
                    key={log.id}
                    testID={`in-use-${unit.unit}`}
                    left={<UnitPlate unit={unit.unit} />}
                    title={`${unit.make} ${unit.model}`}
                    sub={`Since ${fmtTime(log.startAt)}.${takenOut ? ' Taken out of the fleet.' : ''} Tap to end use.`}
                    chevron
                    onPress={() => navigation.navigate('EndUse', { logId: log.id })}
                  />
                );
              })}
            </Panel>
          ) : null}

          <PayPeriodLine employeeId={me.id} now={now} />

          {DEMO_MODE ? <DemoControls onShift={!!shift} lunchRemainingMs={status === 'lunch' ? meal?.lunchRemainingMs : undefined} /> : null}
        </View>
      </ScrollView>

      {/* Location problems: say what happened and what to do about it. */}
      <Sheet testID="gps-sheet" visible={problem != null} onClose={() => setProblem(null)} title={problemTitle(problem)}>
        {problem ? <ProblemBody problem={problem} /> : null}
        {problem && 'geo' in problem && settings.site ? (
          <SiteMap site={settings.site} you={problem.geo} youInside={false} height={240} />
        ) : null}
        {problem?.kind === 'denied' && Platform.OS !== 'web' ? (
          <Button label="Open phone settings" kind="ink" onPress={() => void Linking.openSettings()} />
        ) : null}
        {problem?.kind === 'no_site' ? (
          <Button testID="gps-close" label="Close" kind="ink" onPress={() => setProblem(null)} />
        ) : (
          <Button testID="gps-retry" label="Try again" kind="yellow" onPress={retry} />
        )}
      </Sheet>

      <Sheet testID="clock-out-sheet" visible={confirmOut} onClose={() => setConfirmOut(false)} title="Clock out now?">
        {totals ? (
          <View style={styles.outMath}>
            <Txt v="body" c={color.inkSoft}>Today so far, on your timesheet:</Txt>
            <Txt v="num">
              {fmtHrs(totals.gross)} − {fmtHrs(totals.lunch)} = {fmtHrs(totals.paid)}
            </Txt>
            <Txt v="small" c={color.silica}>On site, minus lunch, equals paid hours.</Txt>
          </View>
        ) : null}

        {needsMealNote ? (
          <View style={{ gap: space.sm }}>
            <Notice tone="bo" title="No lunch is on this shift" body="Pick what happened. Payroll and your supervisor will see it." />
            {(['forgot_punch', 'worked_through', ...(canWaive ? (['waived_short_shift'] as const) : [])] as MealNote[]).map((note) => (
              <Pressable
                key={note}
                testID={`meal-note-${note}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: mealNote === note }}
                onPress={() => setMealNote(note)}
                style={[styles.choice, mealNote === note && styles.choiceOn]}
              >
                <Txt v="strong" c={mealNote === note ? color.white : color.ink}>{MEAL_NOTE_LABEL[note]}</Txt>
              </Pressable>
            ))}
          </View>
        ) : null}

        {myUnits.length > 0 ? (
          <Notice
            tone="warn"
            title={`You still have ${myUnits.length === 1 ? 'a unit' : `${myUnits.length} units`} checked out`}
            body="End use first so the meter readings and hours are right."
          />
        ) : null}

        <Button
          testID="confirm-clock-out"
          label="Clock out"
          icon={LogOut}
          size="xl"
          kind="ink"
          disabled={needsMealNote && !mealNote}
          onPress={clockOut}
        />
      </Sheet>
    </View>
  );
}

/** Hours so far this pay period and when the next check lands. Opens My hours. */
/** The two things done before work starts: examine the work area, and check any equipment. */
function PreShiftChecks({ employeeId, now }: { employeeId: string; now: number }) {
  const navigation = useNavigation();
  const exams = useStore((s) => s.exams);
  const inspections = useStore((s) => s.inspections);
  const today = startOfDay(now);
  const exam = [...exams].reverse().find((x) => x.employeeId === employeeId && x.submittedAt >= today);
  const units = inspections.filter((i) => i.employeeId === employeeId && i.submittedAt >= today).length;
  // `at` makes each tap a new request, so the tab switches sides even if it was asked for that side before.
  const open = (tab: 'area' | 'equipment') => navigation.navigate('Equipment', { tab, at: Date.now() });
  return (
    <Panel title="Before you start" flush>
      <Row
        testID="go-area-exam"
        left={<Factory color={color.ink} size={26} />}
        title={exam ? `${exam.area} examined` : 'Examine your work area'}
        sub={exam ? `Pre shift exam signed at ${fmtTime(exam.submittedAt)}` : 'Pre shift exam, before work starts in it'}
        right={<Tag label={exam ? 'Done' : 'Due'} tone={exam ? 'ok' : 'warn'} />}
        chevron
        onPress={() => open('area')}
      />
      <Divider inset={space.lg} />
      <Row
        testID="go-equipment-check"
        left={<ClipboardCheck color={color.ink} size={26} />}
        title={units > 0 ? `${units} ${units === 1 ? 'unit' : 'units'} on your card` : 'Check your equipment'}
        sub={units > 0 ? 'Add a unit before you run another one' : 'Fill in its checklist before you run it'}
        right={units > 0 ? <Tag label="Done" tone="ok" /> : undefined}
        chevron
        onPress={() => open('equipment')}
      />
    </Panel>
  );
}

/**
 * Maintenance requests waiting on this person. A supervisor assigns a request;
 * the person it is assigned to works it, and this is where they find out.
 */
function AssignedToMe({ employeeId }: { employeeId: string }) {
  const navigation = useNavigation();
  const mrfs = useStore((s) => s.mrfs);
  const equipment = useStore((s) => s.equipment);
  const mine = mrfs.filter((m) => m.assignedTo === employeeId && m.status !== 'completed');
  if (mine.length === 0) return null;
  const first = mine[0];
  const unit = equipment.find((e) => e.id === first.equipmentId);
  return (
    <Panel title="Assigned to you" flush>
      <Row
        testID="go-my-requests"
        left={<Wrench color={color.ink} size={26} />}
        title={mine.length === 1 ? `Maintenance request #${first.number}` : `${mine.length} maintenance requests`}
        sub={mine.length === 1 ? `${unit ? unit.unit : (first.location ?? 'In the plant')}. ${first.description}` : 'Open the list to see what each one is'}
        right={<Tag label={mine.some((m) => m.taggedOut) ? 'Red tagged' : mine.some((m) => m.status === 'open') ? 'To start' : 'In progress'} tone={mine.some((m) => m.taggedOut) ? 'bo' : 'warn'} />}
        chevron
        onPress={() =>
          mine.length === 1 ? navigation.navigate('MrfDetail', { mrfId: first.id }) : navigation.navigate('MyRecords', { tab: 'requests' })
        }
      />
    </Panel>
  );
}

/**
 * Hours so far, a tap from the person's hours. With the company's pay period,
 * the period and the next payday; without one, this week and this month.
 */
function PayPeriodLine({ employeeId, now }: { employeeId: string; now: number }) {
  const navigation = useNavigation();
  const shifts = useStore((s) => s.shifts);
  const leave = useStore((s) => s.leave);
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const pay = useStore((s) => s.settings.company.pay);
  const rules = useRules();
  // The figures move by the minute, so there is no need to redo them every second.
  const minute = Math.floor(now / MIN);
  const line = useMemo(() => {
    const at = minute * MIN;
    const total = (start: number, end: number) =>
      computeRange(
        shifts.filter((s) => s.employeeId === employeeId),
        leave.filter((l) => l.employeeId === employeeId),
        start,
        end,
        at,
        { weekStartsOn: startsOn, rules },
      ).total;
    if (pay) {
      const current = payPeriodOf(at, pay);
      return { label: `Pay period ${fmtRange(current.start, current.lastDay)}`, hours: total(current.start, current.end), payday: nextPayday(at, pay).payDate };
    }
    const week = startOfWeek(at, startsOn);
    const month = monthOf(at);
    return { label: 'This week', hours: total(week, addDays(week, 7)), month: total(month.start, month.end) };
  }, [shifts, leave, employeeId, startsOn, minute, pay, rules]);

  const said =
    line.payday != null
      ? `${line.label}, ${fmtHrs(line.hours)} hours so far. Next payday ${fmtDate(line.payday)}. Open my hours.`
      : `${fmtHrs(line.hours)} hours this week and ${fmtHrs(line.month ?? 0)} this month. Open my hours.`;
  return (
    <Pressable
      testID="pay-period-line"
      accessibilityRole="button"
      accessibilityLabel={said}
      onPress={() => {
        haptic.tap();
        navigation.navigate('Hours');
      }}
      style={({ pressed }) => [styles.payLine, pressed && { backgroundColor: color.kaolin }]}
    >
      <View style={{ flex: 1 }}>
        <Txt v="small" c={color.silica}>{line.label}</Txt>
        <Txt v="numSm" testID="pay-period-hours">{fmtHrs(line.hours)} hours</Txt>
      </View>
      {line.payday != null ? (
        <View style={{ alignItems: 'flex-end' }}>
          <Txt v="small" c={color.silica}>{line.payday === startOfDay(now) ? 'Payday is today' : 'Next payday'}</Txt>
          <Txt v="strong" testID="next-payday">{fmtDate(line.payday)}</Txt>
        </View>
      ) : (
        <View style={{ alignItems: 'flex-end' }}>
          <Txt v="small" c={color.silica}>This month</Txt>
          <Txt v="strong" testID="month-hours">{fmtHrs(line.month ?? 0)} hours</Txt>
        </View>
      )}
      <ChevronRight color={color.silicaLight} size={22} />
    </Pressable>
  );
}

/** How long is left to start lunch before the state's meal deadline (California: the end of the fifth hour). */
function LunchDeadline({ shift, now, rules }: { shift: Shift; now: number; rules: TimeRules }) {
  const meal = mealStatus(shift, now, rules);
  const deadlineAt = meal.deadlineAt ?? now;
  // "your fifth hour", from the state's own deadline.
  const hour = deadlineWords(rules.meal?.startByMs ?? 0).replace(/^the /, 'your ');
  const tone: Tone = meal.state === 'overdue' ? 'bo' : meal.state === 'urgent' ? 'bo' : meal.state === 'soon' ? 'warn' : 'ok';
  const headline =
    meal.state === 'overdue'
      ? `${hour.charAt(0).toUpperCase()}${hour.slice(1)} ended at ${fmtTime(deadlineAt)}`
      : meal.state === 'urgent'
        ? 'Start lunch now'
        : meal.state === 'soon'
          ? 'Lunch within the hour'
          : `Start lunch before ${fmtTime(deadlineAt)}`;
  const detail =
    meal.state === 'overdue'
      ? 'Start your lunch and tell your supervisor. This shift is flagged for payroll.'
      : `Your 30-minute unpaid lunch has to start before ${hour} ends at ${fmtTime(deadlineAt)}.`;
  return (
    <View testID={`lunch-${meal.state}`} style={styles.deadline}>
      <View style={styles.deadlineHead}>
        <Txt v="lead" style={{ flex: 1 }}>{headline}</Txt>
        {meal.state !== 'overdue' ? (
          <Txt v="numSm" c={tone === 'ok' ? color.ink : tone === 'warn' ? color.amber : color.red}>{fmtDur(meal.remainingMs)}</Txt>
        ) : null}
      </View>
      <ProgressBar value={meal.progress} tone={tone} />
      <Txt v="small" c={color.silica}>{detail}</Txt>
    </View>
  );
}

/** The countdown to the end of lunch. There is no button: the lunch ends by itself. */
function LunchTimer({ startedAt, endsAt, remainingMs, elapsedMs, notifyOk }: {
  startedAt: number; endsAt: number; remainingMs: number; elapsedMs: number;
  /** False when the phone has notifications turned off for the app. */
  notifyOk: boolean;
}) {
  return (
    <>
      <View testID="lunch-timer" style={styles.deadline}>
        <View style={styles.deadlineHead}>
          <View style={{ flex: 1 }}>
            <Txt v="lead">Time left on lunch</Txt>
            <Txt v="small" c={color.silica}>Started {fmtTime(startedAt)}, unpaid. Back on the clock at {fmtTime(endsAt)}.</Txt>
          </View>
          <Txt v="num" c={color.blue} testID="lunch-countdown">{fmtCountdown(remainingMs)}</Txt>
        </View>
        <ProgressBar value={Math.min(1, elapsedMs / Math.max(1, elapsedMs + remainingMs))} tone="info" />
      </View>
      {notifyOk ? (
        <Notice
          tone="info"
          icon={BellRing}
          title="Nothing to tap"
          body={`At ${fmtTime(endsAt)} the app puts you back on the clock by itself and sends you a notification that lunch is over.`}
        />
      ) : (
        <View testID="lunch-no-notice">
          <Notice
            tone="warn"
            icon={BellRing}
            title="Notifications are off for this app"
            body={`Lunch still ends by itself at ${fmtTime(endsAt)}, but the app cannot tell you when it does. Turn notifications on in your phone settings.`}
          />
        </View>
      )}
    </>
  );
}

/**
 * Says so the moment a lunch ends by itself while this screen is open. The
 * phone's own notification covers the times it is not.
 */
function LunchOverWatcher({ atLunch, shiftId }: { atLunch: boolean; shiftId?: string }) {
  const before = useRef({ atLunch, shiftId });
  useEffect(() => {
    const was = before.current;
    before.current = { atLunch, shiftId };
    if (was.atLunch && !atLunch && shiftId != null && was.shiftId === shiftId) {
      haptic.success();
      // Short enough for one line, so it does not cover the status above the time card.
      useStore.getState().showToast('Lunch is over. Back on the clock.');
    }
  }, [atLunch, shiftId]);
  return null;
}

function problemTitle(problem: Problem | null): string {
  switch (problem?.kind) {
    case 'outside': return "You're not at the mine";
    case 'weak_gps': return 'GPS signal is too weak';
    case 'mocked': return 'Simulated location';
    case 'denied': return 'Turn on location to punch';
    case 'unavailable': return "Couldn't get your location";
    case 'no_site': return 'The mine boundary is not set';
    default: return '';
  }
}

function ProblemBody({ problem }: { problem: Problem }) {
  const site = useStore((s) => s.settings.site);
  let text = '';
  if (problem.kind === 'outside') {
    const outside = Math.max(0, problem.geo.distanceM - (site?.radiusM ?? 0));
    text = `Your phone puts you ${fmtDistance(problem.geo.distanceM)} from the mine pin, ${fmtDistance(outside)} outside the clock-in boundary. Clock in once you are on site.`;
  } else if (problem.kind === 'weak_gps') {
    text = `Your phone can only place you to within ${fmtDistance(problem.geo.accuracyM ?? 0)}. Step out into the open, give it a few seconds and try again.`;
  } else if (problem.kind === 'mocked') {
    text = 'The phone reported a simulated location. Turn off any mock-location or GPS-changing app and try again. This attempt was logged.';
  } else if (problem.kind === 'no_site') {
    text = 'No one can clock in until a supervisor sets the clock-in boundary: on More, Mine boundary, standing on the mine. Ask a supervisor to set it.';
  } else if (problem.kind === 'denied') {
    text = `${APP_NAME} reads your location only at the moment you punch, to confirm you are at the mine. It never tracks you in the background.`;
  } else {
    text = 'Check that Location Services are on, step out into the open and try again.';
  }
  return <Txt v="body" c={color.inkSoft} testID="gps-problem">{text}</Txt>;
}

/** Preview-only controls for showing the app away from the mine. */
function DemoControls({ onShift, lunchRemainingMs }: { onShift: boolean; lunchRemainingMs?: number }) {
  const demoLocation = useStore((s) => s.settings.demoLocation);
  const lunchReminders = useStore((s) => s.settings.lunchReminders);
  const rules = useRules();
  const { setDemoLocation, demoRewindShift, showToast } = useStore.getState();
  return (
    <View style={styles.demo}>
      <Txt v="h3">Preview controls</Txt>
      <Txt v="small" c={color.silica}>
        For showing the app away from the mine. These are not part of the live app.
      </Txt>
      <Txt v="smallStrong" style={{ marginTop: space.sm }}>Where the phone says it is</Txt>
      <Segmented<DemoLocation>
        testID="demo-gps"
        value={demoLocation}
        onChange={setDemoLocation}
        options={[
          { value: 'at_mine', label: 'At the mine' },
          { value: 'in_town', label: 'In town' },
          { value: 'gps', label: 'Real GPS' },
        ]}
      />
      {lunchRemainingMs != null ? (
        // Thirty minutes is a long time to wait in a demo: move the punches back so lunch is over now.
        <Button
          testID="demo-end-lunch"
          label="Skip to the end of lunch"
          icon={FastForward}
          size="md"
          kind="outline"
          style={{ marginTop: space.sm }}
          onPress={() => {
            const moved = demoRewindShift(Math.ceil(lunchRemainingMs / MIN));
            const lunch = moved?.lunches[moved.lunches.length - 1];
            if (!moved || !lunch) return;
            // Send the real notice as well, a few seconds from now, so it can be seen in a demo.
            void syncReminders(moved, lunchReminders, rules).then(() =>
              scheduleLocal([{ ...lunchOverReminder(lunchEndAt(lunch)), at: Date.now() + 3000 }]),
            );
          }}
        />
      ) : onShift ? (
        <Button
          testID="demo-rewind"
          label="Move my clock-in back 1 hour"
          icon={Rewind}
          size="md"
          kind="outline"
          style={{ marginTop: space.sm }}
          onPress={() => {
            const moved = demoRewindShift(60);
            if (moved) {
              void syncReminders(moved, lunchReminders, rules);
              showToast('Clock-in moved back 1 hour', 'info');
            }
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  field: { paddingHorizontal: space.xl, paddingBottom: 64 },
  fieldTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  fieldTopStacked: { alignItems: 'flex-start', gap: space.sm },
  gps: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minHeight: 44 },
  gpsText: { fontFamily: font.bodySemi, fontSize: 14, flexShrink: 1 },
  clockRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: -2 },
  clock: { fontFamily: font.condBold, fontSize: 92, lineHeight: 92, letterSpacing: -1, fontVariant: ['tabular-nums'] },
  clockSec: { fontFamily: font.cond, fontSize: 26, lineHeight: 28, fontVariant: ['tabular-nums'] },
  body: { paddingHorizontal: space.lg, gap: space.md },
  pair: { flexDirection: 'row', gap: space.md },
  deadline: {
    gap: space.sm,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  deadlineHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  payLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 68,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  outMath: { gap: 4 },
  choice: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: color.silicaLight,
  },
  choiceOn: { backgroundColor: color.ink, borderColor: color.ink },
  demo: {
    marginTop: space.lg,
    gap: 6,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.silicaLight,
  },
});
