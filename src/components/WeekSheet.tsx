import { useNavigation } from '@react-navigation/native';
import { ChevronLeft, ChevronRight } from './icons';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { computeWeek } from '../domain/payroll';
import { FLAG_LABEL, MEAL_FLAGS } from '../domain/time';
import type { ShiftFlag } from '../domain/types';
import { haptic } from '../services/haptics';
import { useStore } from '../store/useStore';
import { color, radius, space, type Tone } from '../theme/theme';
import { addDays, fmtHrs, fmtRange, fmtTime, fmtWeekday, startOfWeek } from '../util/format';
import { DecimalChart } from './DecimalChart';
import { Button, IconButton, Stat, Tag, Txt } from './ui';

export const flagTone = (flag: ShiftFlag): Tone =>
  flag === 'missing_out' || MEAL_FLAGS.includes(flag) ? 'bo' : flag === 'edited' ? 'info' : 'warn';

/** One person's workweek as a timesheet: a line per day and the week's totals. */
export function WeekSheet({ employeeId, weekStart, onWeek, now }: {
  employeeId: string;
  weekStart: number;
  onWeek: (weekStart: number) => void;
  now: number;
}) {
  const navigation = useNavigation();
  const shifts = useStore((s) => s.shifts);
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const [chart, setChart] = useState(false);

  const week = useMemo(
    () => computeWeek(shifts.filter((s) => s.employeeId === employeeId), weekStart, now),
    [shifts, employeeId, weekStart, now],
  );
  const thisWeek = startOfWeek(now, startsOn);
  const isCurrent = weekStart >= thisWeek;

  return (
    <View style={{ gap: space.lg }}>
      <View style={styles.nav}>
        <IconButton icon={ChevronLeft} label="Previous week" bg={color.paper} onPress={() => onWeek(addDays(weekStart, -7))} testID="week-prev" />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Txt v="h3" testID="week-label">{fmtRange(weekStart, addDays(weekStart, 6))}</Txt>
          <Txt v="small" c={color.silica}>{isCurrent ? 'This week' : weekStart === addDays(thisWeek, -7) ? 'Last week' : 'Workweek'}</Txt>
        </View>
        <View style={{ opacity: isCurrent ? 0.3 : 1 }}>
          <IconButton icon={ChevronRight} label="Next week" bg={color.paper} onPress={() => !isCurrent && onWeek(addDays(weekStart, 7))} testID="week-next" />
        </View>
      </View>

      <View style={styles.totals}>
        <View>
          <Txt v="h1" testID="week-paid">{fmtHrs(week.paid)}</Txt>
          <Txt v="body" c={color.silica}>paid hours this week</Txt>
        </View>
        <View style={styles.split}>
          <Stat value={fmtHrs(week.reg)} label="Regular" />
          <Stat value={fmtHrs(week.ot)} label="Overtime" tone={week.ot > 0 ? 'warn' : undefined} />
          <Stat value={fmtHrs(week.dt)} label="Double" tone={week.dt > 0 ? 'bo' : undefined} />
        </View>
        <Txt v="small" c={color.silica}>
          {fmtHrs(week.gross)} on site, less {fmtHrs(week.lunch)} unpaid lunch.
          {week.needsFix > 0 ? ` ${week.needsFix} shift not counted yet: it has no clock-out.` : ''}
        </Txt>
      </View>

      <View style={styles.table}>
        <View style={[styles.line, styles.headLine]}>
          <Txt v="cap" c={color.silica} style={styles.day}>Day</Txt>
          <Txt v="cap" c={color.silica} style={styles.time}>In</Txt>
          <Txt v="cap" c={color.silica} style={styles.time}>Out</Txt>
          <Txt v="cap" c={color.silica} style={styles.num}>Lunch</Txt>
          <Txt v="cap" c={color.silica} style={styles.num}>Paid</Txt>
        </View>
        {week.days.map((day) => {
          const shift = day.shifts[0];
          const off = day.shifts.length === 0;
          const missing = day.flags.includes('missing_out');
          const body = (
            <>
              <View style={styles.lineRow}>
                <View style={styles.day}>
                  <Txt v="strong" c={off ? color.silicaLight : color.ink}>{fmtWeekday(day.dayStart)}</Txt>
                  <Txt v="small" c={color.silica}>{new Date(day.dayStart).getDate()}</Txt>
                </View>
                <Txt v="body" c={off ? color.silicaLight : color.ink} style={styles.time}>{day.firstIn ? fmtTime(day.firstIn) : '–'}</Txt>
                <Txt v="body" c={off ? color.silicaLight : color.ink} style={styles.time}>
                  {day.lastOut && !day.open ? fmtTime(day.lastOut) : day.open ? 'on now' : missing ? 'none' : '–'}
                </Txt>
                <Txt v="body" c={off ? color.silicaLight : color.inkSoft} style={styles.num}>{off || missing ? '–' : fmtHrs(day.lunch)}</Txt>
                <Txt v="numSm" c={off ? color.silicaLight : color.ink} style={styles.num}>{off || missing ? '–' : fmtHrs(day.paid)}</Txt>
              </View>
              {day.flags.length > 0 || day.ot > 0 || day.dt > 0 ? (
                <View style={styles.flags}>
                  {day.ot > 0 ? <Tag label={`${fmtHrs(day.ot)} overtime`} tone="warn" /> : null}
                  {day.dt > 0 ? <Tag label={`${fmtHrs(day.dt)} double`} tone="bo" /> : null}
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
            <View key={day.dayStart} style={styles.line}>{body}</View>
          );
        })}
        <View style={[styles.line, styles.footLine]}>
          <View style={styles.lineRow}>
            <Txt v="strong" style={{ flex: 1 }}>Week</Txt>
            <Txt v="body" c={color.inkSoft} style={styles.num}>{fmtHrs(week.lunch)}</Txt>
            <Txt v="numSm" style={styles.num}>{fmtHrs(week.paid)}</Txt>
          </View>
        </View>
      </View>

      <Button label="How minutes become decimals" kind="quiet" size="md" onPress={() => setChart(true)} testID="open-chart" />
      <DecimalChart visible={chart} onClose={() => setChart(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  totals: {
    gap: space.md,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  split: { flexDirection: 'row', gap: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.rule },
  table: { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.rule, overflow: 'hidden' },
  line: { paddingHorizontal: space.md, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: color.rule, gap: space.sm },
  lineRow: { flexDirection: 'row', alignItems: 'center' },
  headLine: { flexDirection: 'row', borderTopWidth: 0, backgroundColor: color.kaolin, paddingVertical: space.sm },
  footLine: { backgroundColor: color.yellowTint, borderTopWidth: 2, borderTopColor: color.ink },
  day: { width: 46 },
  time: { flex: 1.25 },
  num: { flex: 1, textAlign: 'right' },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 46 },
});
