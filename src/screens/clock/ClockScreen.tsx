import { useNavigation } from '@react-navigation/native';
import { Coffee, LogIn, LogOut, MapPin, Rewind, Utensils } from '../../components/icons';
import React, { useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { BrandPlate } from '../../components/Brand';
import { SiteMap } from '../../components/SiteMap';
import { TimeCard } from '../../components/TimeCard';
import { Button, Notice, Panel, ProgressBar, Row, Segmented, Sheet, Txt, UnitPlate } from '../../components/ui';
import { DEMO_MODE } from '../../config';
import { checkFix, toGeoStamp, type FixVerdict } from '../../domain/geofence';
import { canEndLunch, CA_RULES, MEAL_NOTE_LABEL, mealStatus, shiftTotals } from '../../domain/time';
import type { DemoLocation, GeoStamp, MealNote, Shift } from '../../domain/types';
import { haptic } from '../../services/haptics';
import { locate } from '../../services/location';
import { requestNotificationPermission } from '../../services/notifications';
import { syncReminders } from '../../services/reminders';
import { openLogs, openShiftOf, staleShiftOf, useMe, useStore } from '../../store/useStore';
import { color, font, radius, space, type Tone } from '../../theme/theme';
import {
  clockParts,
  fmtCountdown,
  fmtDate,
  fmtDateLong,
  fmtDistance,
  fmtDur,
  fmtHrs,
  fmtTime,
  fullName,
  HOUR,
  startOfDay,
} from '../../util/format';
import { useNow } from '../../util/hooks';

type Status = 'off' | 'on' | 'lunch' | 'overdue';
type Problem =
  | { kind: Exclude<FixVerdict, 'inside'>; geo: GeoStamp; action: 'clock_in' | 'end_lunch' }
  | { kind: 'denied' | 'unavailable' };

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
  const equipment = useStore((s) => s.equipment);
  const opLogs = useStore((s) => s.opLogs);
  const actions = useStore.getState();

  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirmOut, setConfirmOut] = useState(false);
  const [mealNote, setMealNote] = useState<MealNote | null>(null);

  if (!me) return null;

  const shift = openShiftOf(shifts, me.id, now);
  const stale = staleShiftOf(shifts, me.id, now);
  const today = startOfDay(now);
  const lastToday = [...shifts].reverse().find((s) => s.employeeId === me.id && s.clockOut && s.clockIn.at >= today);
  const cardShift = shift ?? lastToday;

  const totals = shift ? shiftTotals(shift, now) : undefined;
  const meal = shift ? mealStatus(shift, now) : undefined;
  const status: Status = !shift ? 'off' : meal?.state === 'at_lunch' ? 'lunch' : meal?.state === 'overdue' ? 'overdue' : 'on';
  const field = FIELD[status];
  const clock = clockParts(now);
  const myUnits = [...openLogs(opLogs).values()].filter((log) => log.employeeId === me.id);
  const needsMealNote = !!shift && shift.lunches.length === 0 && now - shift.clockIn.at >= CA_RULES.mealDeadlineMs;
  const canWaive = !!shift && now - shift.clockIn.at <= CA_RULES.mealWaiverMaxMs;

  /** Read the phone's position for a punch. Returns null when the punch must not go ahead. */
  const readLocation = async (action: 'clock_in' | 'end_lunch' | 'start_lunch' | 'clock_out'): Promise<GeoStamp | undefined | null> => {
    const mustBeOnSite = action === 'clock_in' || action === 'end_lunch';
    setBusy(action);
    const result = await locate(settings.site, settings.demoLocation);
    setBusy(null);
    if (!result.ok) {
      if (!mustBeOnSite) return undefined;
      haptic.error();
      setProblem({ kind: result.reason });
      return null;
    }
    const check = checkFix(settings.site, result.fix);
    const geo = toGeoStamp(settings.site, result.fix, result.source);
    if (mustBeOnSite && check.verdict !== 'inside') {
      haptic.error();
      actions.logDenied(action as 'clock_in' | 'end_lunch', check.verdict === 'outside' ? 'outside' : check.verdict, geo);
      setProblem({ kind: check.verdict, geo, action: action as 'clock_in' | 'end_lunch' });
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
    void syncReminders(off ? undefined : result.shift, settings.lunchReminders);
  };

  const clockIn = async () => {
    const geo = await readLocation('clock_in');
    if (!geo) return;
    if (settings.lunchReminders) void requestNotificationPermission();
    finish(actions.clockIn(geo), `Clocked in at ${fmtTime(Date.now())}`);
  };
  const startLunch = async () => {
    const geo = await readLocation('start_lunch');
    if (geo === null) return;
    finish(actions.startLunch(geo), `Lunch started at ${fmtTime(Date.now())}`);
  };
  const endLunch = async () => {
    const geo = await readLocation('end_lunch');
    if (!geo) return;
    finish(actions.endLunch(geo), `Back from lunch at ${fmtTime(Date.now())}`);
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
    const action = problem && 'action' in problem ? problem.action : shift ? 'end_lunch' : 'clock_in';
    setProblem(null);
    void (action === 'end_lunch' ? endLunch() : clockIn());
  };

  const lastGeo = shift ? (shift.lunches[shift.lunches.length - 1]?.end?.geo ?? shift.clockIn.geo) : undefined;
  const gpsLine =
    settings.demoLocation === 'at_mine'
      ? 'Demo GPS: at the mine'
      : settings.demoLocation === 'in_town'
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
          <View style={styles.fieldTop}>
            <BrandPlate size="sm" />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${gpsLine}. Open the boundary map.`}
              hitSlop={10}
              onPress={() => navigation.navigate('Site')}
              style={styles.gps}
            >
              <MapPin color={field.fg} size={18} strokeWidth={2.5} />
              <Text style={[styles.gpsText, { color: field.fg }]} numberOfLines={1}>{gpsLine}</Text>
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

          {status === 'lunch' && shift && meal ? (
            <LunchTimer shift={shift} now={now} remainingMs={meal.lunchRemainingMs} elapsedMs={meal.lunchElapsedMs}>
              <Button
                testID="end-lunch"
                label="End lunch"
                sub={canEndLunch(shift, now) ? 'You have to be at the mine' : `Opens in ${fmtCountdown(meal.lunchRemainingMs)}`}
                icon={LogIn}
                size="xl"
                kind="ink"
                disabled={!canEndLunch(shift, now)}
                loading={busy === 'end_lunch'}
                onPress={endLunch}
              />
            </LunchTimer>
          ) : null}

          {(status === 'on' || status === 'overdue') && shift && meal ? (
            <>
              {shift.lunches.length === 0 ? <LunchDeadline shift={shift} now={now} /> : null}
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
                  <Button testID="another-lunch" style={{ flex: 1 }} label="Another lunch" icon={Utensils} size="md" kind="quiet" onPress={startLunch} />
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

          {myUnits.length > 0 ? (
            <Panel title="You have checked out" flush>
              {myUnits.map((log) => {
                const unit = equipment.find((e) => e.id === log.equipmentId);
                if (!unit) return null;
                return (
                  <Row
                    key={log.id}
                    testID={`in-use-${unit.unit}`}
                    left={<UnitPlate unit={unit.unit} />}
                    title={`${unit.make} ${unit.model}`}
                    sub={`Since ${fmtTime(log.startAt)}. Tap to end use.`}
                    chevron
                    onPress={() => navigation.navigate('EndUse', { logId: log.id })}
                  />
                );
              })}
            </Panel>
          ) : null}

          {DEMO_MODE ? <DemoControls onShift={!!shift} /> : null}
        </View>
      </ScrollView>

      {/* Location problems: say what happened and what to do about it. */}
      <Sheet testID="gps-sheet" visible={problem != null} onClose={() => setProblem(null)} title={problemTitle(problem)}>
        {problem ? <ProblemBody problem={problem} /> : null}
        {problem && 'geo' in problem ? (
          <SiteMap site={settings.site} you={problem.geo} youInside={false} height={240} />
        ) : null}
        {problem?.kind === 'denied' && Platform.OS !== 'web' ? (
          <Button label="Open phone settings" kind="ink" onPress={() => void Linking.openSettings()} />
        ) : null}
        <Button testID="gps-retry" label="Try again" kind="yellow" onPress={retry} />
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

/** How long is left to start lunch before the fifth hour of work ends. */
function LunchDeadline({ shift, now }: { shift: Shift; now: number }) {
  const meal = mealStatus(shift, now);
  const tone: Tone = meal.state === 'overdue' ? 'bo' : meal.state === 'urgent' ? 'bo' : meal.state === 'soon' ? 'warn' : 'ok';
  const headline =
    meal.state === 'overdue'
      ? `Your fifth hour ended at ${fmtTime(meal.deadlineAt)}`
      : meal.state === 'urgent'
        ? 'Start lunch now'
        : meal.state === 'soon'
          ? 'Lunch within the hour'
          : `Start lunch before ${fmtTime(meal.deadlineAt)}`;
  const detail =
    meal.state === 'overdue'
      ? 'Start your lunch and tell your supervisor. This shift is flagged for payroll.'
      : `Your 30-minute unpaid lunch has to start before your fifth hour ends at ${fmtTime(meal.deadlineAt)}.`;
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

function LunchTimer({ shift, now, remainingMs, elapsedMs, children }: {
  shift: Shift; now: number; remainingMs: number; elapsedMs: number; children: React.ReactNode;
}) {
  const lunch = shift.lunches[shift.lunches.length - 1];
  const done = remainingMs <= 0;
  return (
    <>
      <View testID="lunch-timer" style={styles.deadline}>
        <View style={styles.deadlineHead}>
          <View style={{ flex: 1 }}>
            <Txt v="lead">{done ? 'Your 30 minutes are up' : 'Time left on lunch'}</Txt>
            <Txt v="small" c={color.silica}>
              Started {fmtTime(lunch.start.at)}, unpaid. {done ? `${fmtDur(elapsedMs)} so far.` : `Lunch runs the full 30 minutes, to ${fmtTime(lunch.start.at + CA_RULES.mealMinMs)}.`}
            </Txt>
          </View>
          <Txt v="num" c={done ? color.green : color.blue}>{done ? fmtDur(elapsedMs) : fmtCountdown(remainingMs)}</Txt>
        </View>
        <ProgressBar value={Math.min(1, elapsedMs / CA_RULES.mealMinMs)} tone={done ? 'ok' : 'info'} />
      </View>
      {children}
      {now - lunch.start.at > HOUR ? (
        <Notice tone="warn" title="Lunch has run over an hour" body="If you forgot to clock back in, end lunch now and ask your supervisor to correct the time." />
      ) : null}
    </>
  );
}

function problemTitle(problem: Problem | null): string {
  switch (problem?.kind) {
    case 'outside': return "You're not at the mine";
    case 'weak_gps': return 'GPS signal is too weak';
    case 'mocked': return 'Simulated location';
    case 'denied': return 'Turn on location to punch';
    case 'unavailable': return "Couldn't get your location";
    default: return '';
  }
}

function ProblemBody({ problem }: { problem: Problem }) {
  const site = useStore((s) => s.settings.site);
  let text = '';
  if (problem.kind === 'outside') {
    const outside = Math.max(0, problem.geo.distanceM - site.radiusM);
    text = `Your phone puts you ${fmtDistance(problem.geo.distanceM)} from the mine pin, ${fmtDistance(outside)} outside the clock-in boundary. ${problem.action === 'end_lunch' ? 'End lunch' : 'Clock in'} once you are on site.`;
  } else if (problem.kind === 'weak_gps') {
    text = `Your phone can only place you to within ${fmtDistance(problem.geo.accuracyM ?? 0)}. Step out into the open, give it a few seconds and try again.`;
  } else if (problem.kind === 'mocked') {
    text = 'The phone reported a simulated location. Turn off any mock-location or GPS-changing app and try again. This attempt was logged.';
  } else if (problem.kind === 'denied') {
    text = 'US Mine Crew reads your location only at the moment you punch, to confirm you are at the mine. It never tracks you in the background.';
  } else {
    text = 'Check that Location Services are on, step out into the open and try again.';
  }
  return <Txt v="body" c={color.inkSoft} testID="gps-problem">{text}</Txt>;
}

/** Preview-only controls for showing the app away from the mine. */
function DemoControls({ onShift }: { onShift: boolean }) {
  const demoLocation = useStore((s) => s.settings.demoLocation);
  const lunchReminders = useStore((s) => s.settings.lunchReminders);
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
      {onShift ? (
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
              void syncReminders(moved, lunchReminders);
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
