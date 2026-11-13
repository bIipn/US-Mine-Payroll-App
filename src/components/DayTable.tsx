import { useNavigation } from '@react-navigation/native';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { DayLine } from '../domain/payroll';
import { FLAG_LABEL, MEAL_FLAGS } from '../domain/time';
import type { LeaveEntry, LeaveType, ShiftFlag } from '../domain/types';
import { haptic } from '../services/haptics';
import { color, radius, space, type Tone } from '../theme/theme';
import { fmtHrs, fmtTime, fmtWeekday, startOfDay } from '../util/format';
import { Tag, Txt } from './ui';

export const LEAVE_LABEL: Record<LeaveType, string> = { holiday: 'Holiday', pto: 'PTO', sick: 'Sick' };
/** In the order the pay stub lists them. */
export const LEAVE_TYPES: LeaveType[] = ['holiday', 'pto', 'sick'];

export const flagTone = (flag: ShiftFlag): Tone =>
  flag === 'missing_out' || MEAL_FLAGS.includes(flag) ? 'bo' : flag === 'edited' ? 'info' : 'warn';

/**
 * Days as timesheet lines: in, out, lunch and hours worked, with overtime,
 * paid leave and anything flagged for review under the line it belongs to.
 * Tap a day that has a shift to see its punches.
 */
export function DayTable({ days, leave = [], footLabel, lunch, worked, now }: {
  days: DayLine[];
  leave?: LeaveEntry[];
  footLabel: string;
  /** Totals for the foot of the table, in hundredths of an hour. */
  lunch: number;
  worked: number;
  now: number;
}) {
  const navigation = useNavigation();
  const today = startOfDay(now);

  return (
    <View style={styles.table}>
      <View style={[styles.line, styles.headLine]}>
        <Txt v="cap" c={color.silica} style={styles.day}>Day</Txt>
        <Txt v="cap" c={color.silica} style={styles.time}>In</Txt>
        <Txt v="cap" c={color.silica} style={styles.time}>Out</Txt>
        <Txt v="cap" c={color.silica} style={styles.num}>Lunch</Txt>
        <Txt v="cap" c={color.silica} style={styles.num}>Worked</Txt>
      </View>

      {days.map((day) => {
        const shift = day.shifts[0];
        const dayLeave = leave.filter((entry) => entry.day === day.dayStart);
        const off = day.shifts.length === 0;
        const missing = day.flags.includes('missing_out');
        const dim = off ? color.silicaLight : color.ink;
        const body = (
          <>
            <View style={styles.lineRow}>
              <View style={styles.day}>
                <Txt v="strong" c={off && dayLeave.length === 0 ? color.silicaLight : color.ink}>{fmtWeekday(day.dayStart)}</Txt>
                <Txt v="small" c={color.silica}>{new Date(day.dayStart).getDate()}</Txt>
              </View>
              <Txt v="body" c={dim} style={styles.time}>{day.firstIn ? fmtTime(day.firstIn) : '–'}</Txt>
              <Txt v="body" c={dim} style={styles.time}>
                {day.lastOut && !day.open ? fmtTime(day.lastOut) : day.open ? 'on now' : missing ? 'none' : '–'}
              </Txt>
              <Txt v="body" c={off ? color.silicaLight : color.inkSoft} style={styles.num}>{off || missing ? '–' : fmtHrs(day.lunch)}</Txt>
              <Txt v="numSm" c={dim} style={styles.num}>{off || missing ? '–' : fmtHrs(day.paid)}</Txt>
            </View>
            {day.flags.length > 0 || day.ot > 0 || day.dt > 0 || dayLeave.length > 0 || day.dayStart === today ? (
              <View style={styles.tags}>
                {day.dayStart === today ? <Tag label="Today" tone="yellow" solid /> : null}
                {dayLeave.map((entry) => (
                  <Tag key={entry.id} label={`${fmtHrs(entry.hours)} ${LEAVE_LABEL[entry.type]}`} tone="info" />
                ))}
                {day.ot > 0 ? <Tag label={`${fmtHrs(day.ot)} overtime`} tone="warn" /> : null}
                {day.dt > 0 ? <Tag label={`${fmtHrs(day.dt)} double time`} tone="bo" /> : null}
                {day.flags.map((flag) => <Tag key={flag} label={FLAG_LABEL[flag]} tone={flagTone(flag)} />)}
              </View>
            ) : null}
          </>
        );
        return shift ? (
          <Pressable
            key={day.dayStart}
            testID={`day-${new Date(day.dayStart).getDate()}`}
            accessibilityRole="button"
            onPress={() => {
              haptic.tap();
              navigation.navigate('ShiftDetail', { shiftId: shift.id });
            }}
            style={({ pressed }) => [styles.line, pressed && { backgroundColor: color.kaolin }]}
          >
            {body}
          </Pressable>
        ) : (
          <View key={day.dayStart} testID={`day-${new Date(day.dayStart).getDate()}`} style={styles.line}>{body}</View>
        );
      })}

      <View style={[styles.line, styles.footLine]}>
        <View style={styles.lineRow}>
          <Txt v="strong" style={{ flex: 1 }}>{footLabel}</Txt>
          <Txt v="body" c={color.inkSoft} style={styles.num}>{fmtHrs(lunch)}</Txt>
          <Txt v="numSm" style={styles.num}>{fmtHrs(worked)}</Txt>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  table: { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.rule, overflow: 'hidden' },
  line: { paddingHorizontal: space.md, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: color.rule, gap: space.sm },
  lineRow: { flexDirection: 'row', alignItems: 'center' },
  headLine: { flexDirection: 'row', borderTopWidth: 0, backgroundColor: color.kaolin, paddingVertical: space.sm },
  footLine: { backgroundColor: color.yellowTint, borderTopWidth: 2, borderTopColor: color.ink },
  day: { width: 46 },
  time: { flex: 1.25 },
  num: { flex: 1, textAlign: 'right' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 46 },
});
