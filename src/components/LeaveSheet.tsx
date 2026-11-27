import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { DayLine } from '../domain/payroll';
import { parseDecimal, withMark } from '../domain/reading';
import type { LeaveEntry, LeaveType } from '../domain/types';
import { useDecimalMark } from '../services/decimalMark';
import { haptic } from '../services/haptics';
import { useStore } from '../store/useStore';
import { color, radius, space, TAP } from '../theme/theme';
import { fmtDate, fmtDateLong, fmtHrs, fmtWeekday, startOfDay } from '../util/format';
import { LEAVE_LABEL } from './DayTable';
import { Trash } from './icons';
import { Button, Divider, Field, IconButton, Segmented, Sheet, Txt } from './ui';

/**
 * Record paid hours that were not worked: a company holiday, PTO or a sick day.
 * They go on the pay period as their own line and never count toward overtime.
 */
export function LeaveSheet({ visible, onClose, employeeId, employeeName, days, leave, now }: {
  visible: boolean;
  onClose: () => void;
  employeeId: string;
  employeeName: string;
  /** The days of the pay period being looked at. */
  days: DayLine[];
  /** Leave already recorded in the period. */
  leave: LeaveEntry[];
  now: number;
}) {
  const { addLeave, removeLeave, showToast } = useStore.getState();
  // The phone's own decimal mark, which its number pad types: 4,5 hours where the phone writes a comma for a part.
  const mark = useDecimalMark();
  /** A full day, as the box starts, written with the phone's mark so it reads back as eight hours. */
  const fullDay = withMark(fmtHrs(800), mark);
  const [type, setType] = useState<LeaveType>('pto');
  const [day, setDay] = useState('');
  const [hours, setHours] = useState(fullDay);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Start on today when it is in the period, otherwise on the first day with no shift.
  useEffect(() => {
    if (!visible) return;
    const today = startOfDay(now);
    const pick = days.find((d) => d.dayStart === today) ?? days.find((d) => d.shifts.length === 0) ?? days[0];
    setDay(pick ? String(pick.dayStart) : '');
    setType('pto');
    setHours(fullDay);
    setNote('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const save = () => {
    // Read by the phone's mark (parseDecimal); the store says what is wrong with hours it does not take.
    const value = parseDecimal(hours, mark) ?? Number.NaN;
    const result = addLeave({
      employeeId,
      day: Number(day),
      type,
      hours: Number.isNaN(value) ? Number.NaN : Math.round(value * 100),
      note,
    });
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return;
    }
    haptic.success();
    showToast(`${fmtHrs(Math.round(value * 100))} ${LEAVE_LABEL[type]} added for ${fmtDate(Number(day))}`);
    onClose();
  };

  return (
    <Sheet testID="leave-sheet" visible={visible} onClose={onClose} title="Add paid leave">
      <Txt v="body" c={color.inkSoft}>
        Paid hours for {employeeName} that were not worked. They show as their own line and never count toward overtime.
      </Txt>
      <Segmented<LeaveType>
        testID="leave-type"
        value={type}
        onChange={setType}
        options={[
          { value: 'pto', label: 'PTO' },
          { value: 'sick', label: 'Sick' },
          { value: 'holiday', label: 'Holiday' },
        ]}
      />
      <View style={{ gap: 6 }}>
        <View style={styles.dayHead}>
          <Txt v="smallStrong" style={{ flex: 1 }}>Which day?</Txt>
          {day ? <Txt v="small" c={color.silica} testID="leave-day-chosen">{fmtDateLong(Number(day))}</Txt> : null}
        </View>
        <DayStrip days={days} value={day} onChange={setDay} />
      </View>
      <Field
        testID="leave-hours"
        label="Hours"
        value={hours}
        onChangeText={(value) => {
          setHours(value);
          setError(null);
        }}
        keyboardType="decimal-pad"
        error={error}
      />
      <Field testID="leave-note" label="Note (optional)" value={note} onChangeText={setNote} placeholder="Thanksgiving, doctor's note on file" />
      <Button testID="leave-save" label="Add to the pay period" kind="ink" onPress={save} />

      {leave.length > 0 ? (
        <View style={styles.existing}>
          <Txt v="smallStrong" style={styles.existingHead}>Already on this pay period</Txt>
          {leave.map((entry, i) => (
            <View key={entry.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <View style={styles.entry}>
                <View style={{ flex: 1 }}>
                  <Txt v="strong">{fmtHrs(entry.hours)} {LEAVE_LABEL[entry.type]}, {fmtDate(entry.day)}</Txt>
                  {entry.note ? <Txt v="small" c={color.silica}>{entry.note}</Txt> : null}
                </View>
                <IconButton
                  testID={`leave-remove-${i}`}
                  icon={Trash}
                  label={`Remove ${LEAVE_LABEL[entry.type]} on ${fmtDate(entry.day)}`}
                  tint={color.red}
                  onPress={() => {
                    const done = removeLeave(entry.id);
                    if (!done.ok) return showToast(done.error, 'bo');
                    showToast(`${LEAVE_LABEL[entry.type]} on ${fmtDate(entry.day)} removed`, 'info');
                  }}
                />
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </Sheet>
  );
}

const TILE = TAP;
const TILE_GAP = space.sm;

/**
 * The days of the pay period as a strip of tiles. The chosen day is brought to
 * the middle, so the choice is never off the edge of the screen.
 */
function DayStrip({ days, value, onChange }: { days: DayLine[]; value: string; onChange: (value: string) => void }) {
  const ref = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [width, setWidth] = useState(0);
  const moved = useRef(false);
  const index = days.findIndex((d) => String(d.dayStart) === value);

  useEffect(() => {
    if (index < 0 || width === 0) return;
    const x = Math.max(0, index * (TILE + TILE_GAP) - (width - TILE) / 2);
    // Jump there when the sheet opens; glide when the person picks another day.
    ref.current?.scrollTo({ x, animated: moved.current });
    moved.current = true;
  }, [index, width]);

  return (
    <ScrollView
      ref={ref}
      horizontal
      showsHorizontalScrollIndicator={false}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      contentContainerStyle={styles.strip}
    >
      {days.map((d) => {
        const id = String(d.dayStart);
        const on = id === value;
        const date = new Date(d.dayStart).getDate();
        return (
          <Pressable
            key={id}
            testID={`leave-day-${date}`}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={fmtDateLong(d.dayStart)}
            onPress={() => {
              haptic.tap();
              onChange(id);
            }}
            style={[styles.tile, on && styles.tileOn]}
          >
            <Txt v="micro" c={on ? color.white : color.silica}>{fmtWeekday(d.dayStart)}</Txt>
            <Txt v="numSm" c={on ? color.white : color.ink}>{date}</Txt>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  dayHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  strip: { gap: TILE_GAP },
  tile: {
    width: TILE,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.silicaLight,
    backgroundColor: color.paper,
  },
  tileOn: { backgroundColor: color.ink, borderColor: color.ink },
  existing: { borderRadius: radius.md, borderWidth: 1, borderColor: color.rule, overflow: 'hidden' },
  existingHead: { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.kaolin },
  entry: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm },
});
