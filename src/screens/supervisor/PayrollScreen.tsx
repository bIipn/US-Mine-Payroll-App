import { ChevronLeft, ChevronRight, FileSpreadsheet } from '../../components/icons';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, IconButton, Page, Segmented, Stat, Tag, Txt } from '../../components/ui';
import { computePayroll, sumPayroll } from '../../domain/payroll';
import type { ScreenProps } from '../../navigation/types';
import { exportReport } from '../../services/exportReport';
import { payrollReport } from '../../services/reports';
import { useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { addDays, fmtHrs, fmtRange, startOfWeek } from '../../util/format';
import { useNow } from '../../util/hooks';

type Span = '1' | '2';

/** Hours for the pay period, by employee, split into regular, overtime and double time. */
export function PayrollScreen({ navigation }: ScreenProps<'Payroll'>) {
  const now = useNow(60_000);
  const employees = useStore((s) => s.employees);
  const shifts = useStore((s) => s.shifts);
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const [span, setSpan] = useState<Span>('1');
  const [end, setEnd] = useState(() => startOfWeek(Date.now(), startsOn));

  const weeks = Number(span);
  const start = addDays(end, -(weeks - 1) * 7);
  const thisWeek = startOfWeek(now, startsOn);
  const isCurrent = end >= thisWeek;

  const rows = useMemo(() => {
    const people = employees
      .filter((e) => e.active)
      .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
    return computePayroll(people, shifts, start, weeks, now);
  }, [employees, shifts, start, weeks, now]);
  const totals = useMemo(() => sumPayroll(rows), [rows]);

  return (
    <Page
      testID="payroll-screen"
      title="Payroll"
      sub="Hours as decimals, lunch already taken off"
      onBack={navigation.goBack}
      footer={
        <Button
          testID="export-payroll"
          label="Export to Excel"
          icon={FileSpreadsheet}
          kind="yellow"
          onPress={() => exportReport(() => payrollReport({ ...useStore.getState() }, start, weeks, Date.now()))}
        />
      }
    >
      <Segmented<Span>
        testID="payroll-span"
        value={span}
        onChange={setSpan}
        options={[
          { value: '1', label: 'One week' },
          { value: '2', label: 'Two weeks' },
        ]}
      />
      <View style={styles.nav}>
        <IconButton testID="period-prev" icon={ChevronLeft} label="Earlier period" bg={color.paper} onPress={() => setEnd(addDays(end, -7 * weeks))} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Txt v="h3" testID="period-label">{fmtRange(start, addDays(end, 6))}</Txt>
          <Txt v="small" c={color.silica}>{isCurrent ? 'Includes this week so far' : 'Closed period'}</Txt>
        </View>
        <View style={{ opacity: isCurrent ? 0.3 : 1 }}>
          <IconButton testID="period-next" icon={ChevronRight} label="Later period" bg={color.paper} onPress={() => !isCurrent && setEnd(Math.min(thisWeek, addDays(end, 7 * weeks)))} />
        </View>
      </View>

      <View style={styles.totals}>
        <View>
          <Txt v="h1" testID="payroll-total">{fmtHrs(totals.paid)}</Txt>
          <Txt v="body" c={color.silica}>paid hours, {rows.filter((r) => r.paid > 0).length} people</Txt>
        </View>
        <View style={styles.split}>
          <Stat value={fmtHrs(totals.reg)} label="Regular" />
          <Stat value={fmtHrs(totals.ot)} label="Overtime" tone={totals.ot > 0 ? 'warn' : undefined} />
          <Stat value={fmtHrs(totals.dt)} label="Double" tone={totals.dt > 0 ? 'bo' : undefined} />
        </View>
        {totals.mealFlags > 0 || totals.needsFix > 0 ? (
          <View style={styles.flags}>
            {totals.needsFix > 0 ? <Tag label={`${totals.needsFix} shift with no clock-out`} tone="bo" solid /> : null}
            {totals.mealFlags > 0 ? <Tag label={`${totals.mealFlags} lunch ${totals.mealFlags === 1 ? 'flag' : 'flags'} to review`} tone="warn" /> : null}
          </View>
        ) : null}
      </View>

      <View style={styles.table}>
        <View style={[styles.line, styles.head]}>
          <Txt v="cap" c={color.silica} style={styles.name}>Employee</Txt>
          <Txt v="cap" c={color.silica} style={styles.num}>Reg</Txt>
          <Txt v="cap" c={color.silica} style={styles.num}>OT</Txt>
          <Txt v="cap" c={color.silica} style={styles.num}>DT</Txt>
          <Txt v="cap" c={color.silica} style={styles.paid}>Paid</Txt>
        </View>
        {rows.map((row) => (
          <Pressable
            key={row.employee.id}
            testID={`pay-${row.employee.id}`}
            accessibilityRole="button"
            onPress={() => navigation.navigate('PayrollEmployee', { employeeId: row.employee.id, weekStart: end })}
            style={({ pressed }) => [styles.line, pressed && { backgroundColor: color.kaolin }]}
          >
            <View style={styles.lineRow}>
              <View style={styles.name}>
                <Txt v="strong" numberOfLines={1}>{row.employee.lastName}, {row.employee.firstName.charAt(0)}.</Txt>
              </View>
              <Txt v="body" c={color.inkSoft} style={styles.num}>{fmtHrs(row.reg)}</Txt>
              <Txt v="body" c={row.ot > 0 ? color.amber : color.silicaLight} style={styles.num}>{fmtHrs(row.ot)}</Txt>
              <Txt v="body" c={row.dt > 0 ? color.red : color.silicaLight} style={styles.num}>{fmtHrs(row.dt)}</Txt>
              <Txt v="numSm" style={styles.paid}>{fmtHrs(row.paid)}</Txt>
            </View>
            {row.mealFlags > 0 || row.needsFix > 0 ? (
              <View style={styles.flags}>
                {row.needsFix > 0 ? <Tag label="No clock-out" tone="bo" solid /> : null}
                {row.mealFlags > 0 ? <Tag label={`${row.mealFlags} lunch ${row.mealFlags === 1 ? 'flag' : 'flags'}`} tone="warn" /> : null}
              </View>
            ) : null}
          </Pressable>
        ))}
        <View style={[styles.line, styles.foot]}>
          <View style={styles.lineRow}>
            <Txt v="strong" style={styles.name}>Total</Txt>
            <Txt v="strong" style={styles.num}>{fmtHrs(totals.reg)}</Txt>
            <Txt v="strong" style={styles.num}>{fmtHrs(totals.ot)}</Txt>
            <Txt v="strong" style={styles.num}>{fmtHrs(totals.dt)}</Txt>
            <Txt v="numSm" style={styles.paid}>{fmtHrs(totals.paid)}</Txt>
          </View>
        </View>
      </View>

      <Txt v="small" c={color.silica}>
        Overtime follows California rules: over 8 hours a day or 40 straight-time hours a week at time-and-a-half, over 12 a day at double time, with the seventh-day rule. Lunch flags are for review and are never paid or docked automatically.
      </Txt>
    </Page>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  totals: { gap: space.md, padding: space.lg, backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.rule },
  split: { flexDirection: 'row', gap: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.rule },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  table: { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.rule, overflow: 'hidden' },
  line: { paddingHorizontal: space.md, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: color.rule, gap: 6 },
  lineRow: { flexDirection: 'row', alignItems: 'center' },
  head: { flexDirection: 'row', borderTopWidth: 0, backgroundColor: color.kaolin, paddingVertical: space.sm },
  foot: { backgroundColor: color.yellowTint, borderTopWidth: 2, borderTopColor: color.ink },
  name: { flex: 2.1 },
  num: { flex: 1, textAlign: 'right' },
  paid: { flex: 1.25, textAlign: 'right' },
});
