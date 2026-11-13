import { CalendarClock, ChevronLeft, ChevronRight, FileSpreadsheet } from '../../components/icons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, EmptyState, IconButton, Page, Panel, Row, Tag, Txt, Divider } from '../../components/ui';
import { flagTone } from '../../components/WeekSheet';
import { FLAG_LABEL, shiftFlags, shiftTotals } from '../../domain/time';
import type { ScreenProps } from '../../navigation/types';
import { exportReport } from '../../services/exportReport';
import { payrollReport } from '../../services/reports';
import { employeeName, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { addDays, fmtDate, fmtDistance, fmtHrs, fmtRelativeDay, fmtTime, startOfDay, startOfWeek } from '../../util/format';
import { useNow } from '../../util/hooks';

/** Everyone's punches for one day: arrived, lunch, back, left. */
export function TimeLogsScreen({ navigation }: ScreenProps<'TimeLogs'>) {
  const now = useNow(30_000);
  const employees = useStore((s) => s.employees);
  const shifts = useStore((s) => s.shifts);
  const denied = useStore((s) => s.denied);
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const [day, setDay] = useState(() => startOfDay(Date.now()));

  const next = addDays(day, 1);
  const isToday = day >= startOfDay(now);
  const list = shifts
    .filter((s) => s.clockIn.at >= day && s.clockIn.at < next)
    .sort((a, b) => a.clockIn.at - b.clockIn.at);
  const turnedDown = denied.filter((d) => d.at >= day && d.at < next);
  const short = (ms?: number) => (ms ? fmtTime(ms).replace(' AM', 'a').replace(' PM', 'p') : '–');
  /** "Whitfield, D." keeps long names inside the column, the same way the payroll table lists them. */
  const rosterName = (id: string) => {
    const e = employees.find((x) => x.id === id);
    return e ? `${e.lastName}, ${e.firstName.charAt(0)}.` : 'Unknown';
  };

  return (
    <Page
      testID="timelogs-screen"
      title="Time log"
      sub="Tap a line for locations and corrections"
      onBack={navigation.goBack}
      footer={
        <Button
          testID="export-week"
          label="Export this week to Excel"
          icon={FileSpreadsheet}
          kind="ink"
          onPress={() => exportReport(() => payrollReport({ ...useStore.getState() }, startOfWeek(day, startsOn), 1, Date.now()))}
        />
      }
    >
      <View style={styles.nav}>
        <IconButton testID="day-prev" icon={ChevronLeft} label="Previous day" bg={color.paper} onPress={() => setDay(addDays(day, -1))} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Txt v="h3" testID="day-label">{fmtDate(day)}</Txt>
          <Txt v="small" c={color.silica}>{fmtRelativeDay(day, now) === fmtDate(day) ? `${list.length} on the log` : fmtRelativeDay(day, now)}</Txt>
        </View>
        <View style={{ opacity: isToday ? 0.3 : 1 }}>
          <IconButton testID="day-next" icon={ChevronRight} label="Next day" bg={color.paper} onPress={() => !isToday && setDay(next)} />
        </View>
      </View>

      {list.length === 0 ? (
        <EmptyState icon={CalendarClock} title="No punches this day" body="Nobody clocked in. Pick another day with the arrows." />
      ) : (
        <View style={styles.table}>
          <View style={[styles.line, styles.head]}>
            <Txt v="cap" c={color.silica} style={styles.name}>Name</Txt>
            <Txt v="cap" c={color.silica} style={styles.cell}>In</Txt>
            <Txt v="cap" c={color.silica} style={styles.cell}>Lunch</Txt>
            <Txt v="cap" c={color.silica} style={styles.cell}>Back</Txt>
            <Txt v="cap" c={color.silica} style={styles.cell}>Out</Txt>
            <Txt v="cap" c={color.silica} style={styles.paid}>Paid</Txt>
          </View>
          {list.map((shift) => {
            const flags = shiftFlags(shift, now);
            const missing = flags.includes('missing_out');
            const totals = shiftTotals(shift, now);
            const lunch = shift.lunches[0];
            return (
              <Pressable
                key={shift.id}
                testID={`log-${shift.employeeId}`}
                accessibilityRole="button"
                onPress={() => navigation.navigate('ShiftDetail', { shiftId: shift.id })}
                style={({ pressed }) => [styles.line, pressed && { backgroundColor: color.kaolin }]}
              >
                <View style={styles.lineRow}>
                  <Txt v="smallStrong" style={styles.name} numberOfLines={1}>{rosterName(shift.employeeId)}</Txt>
                  <Txt v="micro" style={styles.cell}>{short(shift.clockIn.at)}</Txt>
                  <Txt v="micro" style={styles.cell}>{short(lunch?.start.at)}</Txt>
                  <Txt v="micro" style={styles.cell}>{short(lunch?.end?.at)}</Txt>
                  <Txt v="micro" c={shift.clockOut ? color.ink : missing ? color.red : color.green} style={styles.cell}>
                    {shift.clockOut ? short(shift.clockOut.at) : missing ? 'none' : 'here'}
                  </Txt>
                  <Txt v="strong" style={styles.paid}>{missing ? '–' : fmtHrs(totals.paid)}</Txt>
                </View>
                {flags.length > 0 ? (
                  <View style={styles.flags}>
                    {flags.map((flag) => <Tag key={flag} label={FLAG_LABEL[flag]} tone={flagTone(flag)} />)}
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      )}

      {turnedDown.length > 0 ? (
        <Panel title="Punches turned down" flush>
          {turnedDown.map((d, i) => (
            <View key={d.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <Row
                title={employeeName(employees, d.employeeId)}
                sub={`${fmtTime(d.at)}, tried to ${d.action === 'clock_in' ? 'clock in' : 'end lunch'}${
                  d.geo ? ` ${fmtDistance(d.geo.distanceM)} from the mine pin` : ''
                }`}
                right={<Tag label={d.reason === 'outside' ? 'Off site' : d.reason === 'mocked' ? 'Simulated GPS' : 'Weak GPS'} tone="bo" />}
              />
            </View>
          ))}
        </Panel>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  table: { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.rule, overflow: 'hidden' },
  line: { paddingHorizontal: space.md, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: color.rule, gap: 6 },
  lineRow: { flexDirection: 'row', alignItems: 'center' },
  head: { flexDirection: 'row', borderTopWidth: 0, backgroundColor: color.kaolin, paddingVertical: space.sm },
  name: { flex: 2.4 },
  cell: { flex: 1.12, textAlign: 'right' },
  paid: { flex: 1.05, textAlign: 'right' },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
