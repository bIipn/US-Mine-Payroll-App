import { Clock, MapPin, PenLine } from '../../components/icons';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { TimeCard } from '../../components/TimeCard';
import { Button, Divider, Field, Notice, Page, Panel, Sheet, Tag, Txt } from '../../components/ui';
import { flagTone } from '../../components/WeekSheet';
import { backFromLunchAt, FLAG_LABEL, flagHelp, MEAL_NOTE_LABEL, shiftFlags, shiftTotals } from '../../domain/time';
import type { Punch, ShiftEdit } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { employeeName, useMe, useRules, useStore, useSupervisorHere } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDate, fmtDateTime, fmtDistance, fmtDur, fmtHM, fmtHrs, fmtTime, MIN, startOfDay } from '../../util/format';
import { useNow } from '../../util/hooks';
import { parseTime } from '../../util/parseTime';

const EDIT_FIELD: Record<ShiftEdit['field'], string> = {
  clockIn: 'Clock-in',
  clockOut: 'Clock-out',
  lunchStart: 'Lunch start',
  lunchEnd: 'Lunch end',
};

function where(punch?: Punch): string {
  if (punch?.auto) return 'Automatic, 30 minutes after lunch started';
  if (!punch?.geo) return 'Entered by a supervisor';
  const { geo } = punch;
  const source = geo.source === 'demo' ? ' (demo GPS)' : '';
  return `${geo.inside ? 'On site' : 'Off site'}, ${fmtDistance(geo.distanceM)} from the mine pin${source}`;
}

export function ShiftDetailScreen({ navigation, route }: ScreenProps<'ShiftDetail'>) {
  const now = useNow(30_000);
  const rules = useRules();
  const me = useMe();
  const shift = useStore((s) => s.shifts.find((x) => x.id === route.params.shiftId));
  const employees = useStore((s) => s.employees);
  const { editShiftTimes, showToast } = useStore.getState();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ clockIn: '', clockOut: '', lunchStart: '', lunchEnd: '', reason: '' });
  const [error, setError] = useState<string | null>(null);

  if (!shift) return null;

  const totals = shiftTotals(shift, now);
  const flags = shiftFlags(shift, now, rules);
  const missing = flags.includes('missing_out');
  const day = startOfDay(shift.clockIn.at);
  const canEdit = useSupervisorHere();
  const lunch = shift.lunches[0];

  const openEdit = () => {
    setForm({
      clockIn: fmtTime(shift.clockIn.at),
      clockOut: shift.clockOut ? fmtTime(shift.clockOut.at) : '',
      lunchStart: lunch ? fmtTime(lunch.start.at) : '',
      lunchEnd: lunch?.end ? fmtTime(lunch.end.at) : '',
      reason: '',
    });
    setError(null);
    setEditing(true);
  };

  const save = () => {
    const read = (text: string, label: string): number | undefined | null => {
      if (!text.trim()) return undefined;
      const value = parseTime(text, day);
      if (value == null) setError(`${label}: type a time like 2:45 PM.`);
      return value;
    };
    const clockIn = read(form.clockIn, 'Clock-in');
    if (clockIn === null) return;
    const clockOut = read(form.clockOut, 'Clock-out');
    if (clockOut === null) return;
    const lunchStart = read(form.lunchStart, 'Lunch start');
    if (lunchStart === null) return;
    const lunchEnd = read(form.lunchEnd, 'Lunch end');
    if (lunchEnd === null) return;
    // Only send what actually changed, to the minute.
    const changed = (next: number | undefined, current: number | undefined) =>
      next != null && (current == null || Math.floor(next / MIN) !== Math.floor(current / MIN)) ? next : undefined;
    const result = editShiftTimes(
      shift.id,
      {
        clockIn: changed(clockIn, shift.clockIn.at),
        clockOut: changed(clockOut, shift.clockOut?.at),
        lunchStart: changed(lunchStart, lunch?.start.at),
        lunchEnd: changed(lunchEnd, lunch?.end?.at),
      },
      form.reason,
    );
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return;
    }
    haptic.success();
    showToast('Times corrected. The change is on the record.');
    setEditing(false);
  };

  const punches: { label: string; punch?: Punch }[] = [
    { label: 'Clock in', punch: shift.clockIn },
    ...shift.lunches.flatMap((l, i) => [
      { label: shift.lunches.length > 1 ? `Lunch ${i + 1} start` : 'Lunch start', punch: l.start },
      // The end of a lunch is listed once it has happened.
      ...(l.end && backFromLunchAt(l, now) != null
        ? [{ label: shift.lunches.length > 1 ? `Back on the clock from lunch ${i + 1}` : 'Back on the clock', punch: l.end }]
        : []),
    ]),
    ...(shift.clockOut ? [{ label: 'Clock out', punch: shift.clockOut }] : []),
  ];

  return (
    <Page
      testID="shift-detail"
      title={fmtDate(shift.clockIn.at)}
      sub={employeeName(employees, shift.employeeId)}
      onBack={navigation.goBack}
      footer={canEdit ? <Button testID="edit-times" label={missing ? 'Set the clock-out time' : 'Correct the times'} icon={PenLine} kind={missing ? 'yellow' : 'outline'} onPress={openEdit} /> : undefined}
    >
      {missing ? (
        <Notice
          tone="bo"
          title="This shift was never clocked out"
          body={canEdit ? 'Set the clock-out time so the day can be paid.' : 'A supervisor has to set the clock-out time before this day can be paid.'}
        />
      ) : null}

      <TimeCard shift={shift} now={missing ? shift.clockIn.at : now} dateLabel={fmtDate(shift.clockIn.at)} corner={color.kaolin} />

      {!missing ? (
        <Panel title="How the hours were figured">
          <View style={{ gap: space.sm }}>
            <Line
              left={`${fmtTime(shift.clockIn.at)} to ${shift.clockOut ? fmtTime(shift.clockOut.at) : 'now'}`}
              mid={fmtHM(totals.grossMin)}
              right={fmtHrs(totals.gross)}
            />
            <Line left={totals.lunchMin > 0 ? 'Unpaid lunch' : 'No lunch taken'} mid={fmtHM(totals.lunchMin)} right={`− ${fmtHrs(totals.lunch)}`} />
            <Divider />
            <Line left="Paid hours" right={fmtHrs(totals.paid)} strong />
            {shift.breaks.length > 0 ? (
              <Txt v="small" c={color.silica}>
                {shift.breaks.length} paid rest {shift.breaks.length === 1 ? 'break' : 'breaks'} logged
                {shift.breaks.every((b) => b.end) ? `, ${fmtDur(shift.breaks.reduce((sum, b) => sum + ((b.end ?? b.start) - b.start), 0))} in all` : ''}. Rest breaks are paid and are not taken off.
              </Txt>
            ) : null}
          </View>
        </Panel>
      ) : null}

      {flags.length > 0 || shift.mealNote ? (
        <Panel title="For review" flush>
          {flags.map((flag, i) => (
            <View key={flag}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <View style={styles.flag}>
                <Tag label={FLAG_LABEL[flag]} tone={flagTone(flag)} />
                <Txt v="body" c={color.inkSoft}>{flagHelp(flag, rules)}</Txt>
              </View>
            </View>
          ))}
          {shift.mealNote ? (
            <>
              {flags.length > 0 ? <Divider inset={space.lg} /> : null}
              <View style={styles.flag}>
                <Txt v="smallStrong">Employee's note at clock-out</Txt>
                <Txt v="body" c={color.inkSoft}>{MEAL_NOTE_LABEL[shift.mealNote]}</Txt>
              </View>
            </>
          ) : null}
        </Panel>
      ) : null}

      <Panel title="Punches" flush>
        {punches.map((p, i) => (
          <View key={`${p.label}-${i}`}>
            {i > 0 ? <Divider inset={space.lg} /> : null}
            <View style={styles.punch}>
              <View style={{ flex: 1 }}>
                <Txt v="strong">{p.label}</Txt>
                <View style={styles.where}>
                  {p.punch?.auto ? (
                    <Clock size={14} color={color.silica} />
                  ) : (
                    <MapPin size={14} color={p.punch?.geo ? (p.punch.geo.inside ? color.green : color.red) : color.silica} />
                  )}
                  <Txt v="small" c={color.silica} style={{ flex: 1 }}>{where(p.punch)}</Txt>
                </View>
              </View>
              <Txt v="numSm">{p.punch ? fmtTime(p.punch.at) : '–'}</Txt>
            </View>
          </View>
        ))}
      </Panel>

      {shift.edits?.length ? (
        <Panel title="Corrections" flush>
          {shift.edits.map((edit, i) => (
            <View key={`${edit.at}-${edit.field}`}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <View style={styles.flag}>
                <Txt v="strong">
                  {EDIT_FIELD[edit.field]} {edit.from ? `changed from ${fmtTime(edit.from)} to` : 'set to'} {edit.to ? fmtTime(edit.to) : '–'}
                </Txt>
                <Txt v="body" c={color.inkSoft}>{edit.reason}</Txt>
                <Txt v="small" c={color.silica}>{employeeName(employees, edit.byEmployeeId)}, {fmtDateTime(edit.at)}</Txt>
              </View>
            </View>
          ))}
        </Panel>
      ) : null}

      <Sheet testID="edit-sheet" visible={editing} onClose={() => setEditing(false)} title="Correct the times">
        <Txt v="body" c={color.inkSoft}>
          Type each time with AM or PM. Every change is kept on the record with your name and the reason.
        </Txt>
        <View style={styles.pair}>
          <View style={{ flex: 1 }}><Field testID="edit-in" label="Clock-in" value={form.clockIn} onChangeText={(v) => setForm({ ...form, clockIn: v })} autoCapitalize="characters" /></View>
          <View style={{ flex: 1 }}><Field testID="edit-out" label="Clock-out" value={form.clockOut} onChangeText={(v) => setForm({ ...form, clockOut: v })} placeholder="2:45 PM" autoCapitalize="characters" /></View>
        </View>
        <View style={styles.pair}>
          <View style={{ flex: 1 }}><Field testID="edit-lunch-start" label="Lunch start" value={form.lunchStart} onChangeText={(v) => setForm({ ...form, lunchStart: v })} placeholder="None" autoCapitalize="characters" /></View>
          <View style={{ flex: 1 }}><Field testID="edit-lunch-end" label="Lunch end" value={form.lunchEnd} onChangeText={(v) => setForm({ ...form, lunchEnd: v })} placeholder="None" autoCapitalize="characters" /></View>
        </View>
        <Field testID="edit-reason" label="Reason for the change" value={form.reason} onChangeText={(v) => setForm({ ...form, reason: v })} placeholder="Forgot to clock out, confirmed with lead" multiline />
        {error ? <Txt v="smallStrong" c={color.red} testID="edit-error">{error}</Txt> : null}
        <Button testID="edit-save" label="Save the correction" kind="ink" onPress={save} />
      </Sheet>
    </Page>
  );
}

function Line({ left, mid, right, strong }: { left: string; mid?: string; right: string; strong?: boolean }) {
  return (
    <View style={styles.mathLine}>
      <Txt v={strong ? 'strong' : 'body'} style={{ flex: 1 }} numberOfLines={1}>{left}</Txt>
      {mid ? <Txt v="small" c={color.silica} style={{ width: 66, textAlign: 'right' }}>{mid}</Txt> : null}
      <Txt v={strong ? 'num' : 'numSm'} style={{ width: 84, textAlign: 'right' }}>{right}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  mathLine: { flexDirection: 'row', alignItems: 'center' },
  flag: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 4 },
  punch: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  where: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  pair: { flexDirection: 'row', gap: space.md },
});
