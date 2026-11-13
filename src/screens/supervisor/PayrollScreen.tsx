import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { LEAVE_LABEL, LEAVE_TYPES } from '../../components/DayTable';
import { ChevronLeft, ChevronRight, FileSpreadsheet } from '../../components/icons';
import { paydayLine } from '../../components/PeriodSheet';
import { Button, IconButton, Page, Segmented, Stat, Tag, Txt } from '../../components/ui';
import { nextPayPeriod, payPeriodOf, previousPayPeriod } from '../../domain/payPeriod';
import { computePayroll, sumPayroll } from '../../domain/payroll';
import type { ScreenProps } from '../../navigation/types';
import { exportReport } from '../../services/exportReport';
import { payrollReport } from '../../services/reports';
import { useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { addDays, fmtHrs, fmtRange, startOfWeek } from '../../util/format';
import { useNow } from '../../util/hooks';

type View_ = 'period' | 'week';

/**
 * Hours for payroll, by employee, in the same lines as the pay stub: straight
 * time, overtime, double time, and paid leave. By pay period (the 1st to the
 * 15th and the 16th to the end of the month) or by workweek.
 */
export function PayrollScreen({ navigation }: ScreenProps<'Payroll'>) {
  const now = useNow(60_000);
  const employees = useStore((s) => s.employees);
  const shifts = useStore((s) => s.shifts);
  const leave = useStore((s) => s.leave);
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const [view, setView] = useState<View_>('period');
  const [period, setPeriod] = useState(() => payPeriodOf(Date.now()));
  const [week, setWeek] = useState(() => startOfWeek(Date.now(), startsOn));

  const start = view === 'period' ? period.start : week;
  const end = view === 'period' ? period.end : addDays(week, 7);
  const isCurrent = view === 'period' ? period.start >= payPeriodOf(now).start : week >= startOfWeek(now, startsOn);

  const rows = useMemo(() => {
    const people = employees
      .filter((e) => e.active)
      .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
    return computePayroll(people, shifts, leave, start, end, now, { weekStartsOn: startsOn });
  }, [employees, shifts, leave, start, end, now, startsOn]);
  const totals = useMemo(() => sumPayroll(rows), [rows]);
  const paidLeave = totals.total - totals.paid;

  const step = (direction: 1 | -1) => {
    if (direction === 1 && isCurrent) return;
    if (view === 'period') setPeriod(direction === 1 ? nextPayPeriod(period) : previousPayPeriod(period));
    else setWeek(addDays(week, 7 * direction));
  };

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
          onPress={() =>
            exportReport(() =>
              payrollReport({ ...useStore.getState() }, { start, end, payDate: view === 'period' ? period.payDate : undefined }, Date.now()),
            )
          }
        />
      }
    >
      <Segmented<View_>
        testID="payroll-view"
        value={view}
        onChange={setView}
        options={[
          { value: 'period', label: 'Pay period' },
          { value: 'week', label: 'Workweek' },
        ]}
      />
      <View style={styles.nav}>
        <IconButton testID="period-prev" icon={ChevronLeft} label="Earlier" bg={color.paper} onPress={() => step(-1)} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Txt v="h3" testID="period-label">{fmtRange(start, addDays(end, -1))}</Txt>
          <Txt v="small" c={color.silica} center testID="period-payday">
            {view === 'period' ? paydayLine(period, now) : isCurrent ? 'This workweek so far' : 'Sunday to Saturday'}
          </Txt>
        </View>
        <View style={{ opacity: isCurrent ? 0.3 : 1 }}>
          <IconButton testID="period-next" icon={ChevronRight} label="Later" bg={color.paper} onPress={() => step(1)} />
        </View>
      </View>

      <View style={styles.totals}>
        <View>
          <Txt v="h1" testID="payroll-total">{fmtHrs(totals.total)}</Txt>
          <Txt v="body" c={color.silica}>hours to pay, {rows.filter((r) => r.total > 0).length} people</Txt>
        </View>
        <View style={styles.split}>
          <Stat compact value={fmtHrs(totals.reg)} label="Straight time" />
          <Stat compact value={fmtHrs(totals.ot)} label="Overtime" tone={totals.ot > 0 ? 'warn' : undefined} />
          <Stat compact value={fmtHrs(totals.dt)} label="Double time" tone={totals.dt > 0 ? 'bo' : undefined} />
        </View>
        {paidLeave > 0 || totals.mealFlags > 0 || totals.needsFix > 0 ? (
          <View style={styles.flags} testID="payroll-leave">
            {LEAVE_TYPES.filter((type) => totals[type] > 0).map((type) => (
              <Tag key={type} label={`${fmtHrs(totals[type])} ${LEAVE_LABEL[type]}`} tone="info" />
            ))}
            {totals.needsFix > 0 ? (
              <Tag label={`${totals.needsFix} ${totals.needsFix === 1 ? 'shift' : 'shifts'} with no clock-out`} tone="bo" solid />
            ) : null}
            {totals.mealFlags > 0 ? <Tag label={`${totals.mealFlags} lunch ${totals.mealFlags === 1 ? 'flag' : 'flags'} to review`} tone="warn" /> : null}
          </View>
        ) : null}
      </View>

      <View style={styles.table}>
        <View style={[styles.line, styles.head]}>
          <Txt v="cap" c={color.silica} style={styles.name}>Employee</Txt>
          <Txt v="cap" c={color.silica} style={styles.num}>ST</Txt>
          <Txt v="cap" c={color.silica} style={styles.num}>OT</Txt>
          <Txt v="cap" c={color.silica} style={styles.num}>DT</Txt>
          <Txt v="cap" c={color.silica} style={styles.paid}>Total</Txt>
        </View>
        {rows.map((row) => (
          <Pressable
            key={row.employee.id}
            testID={`pay-${row.employee.id}`}
            accessibilityRole="button"
            onPress={() => navigation.navigate('PayrollEmployee', { employeeId: row.employee.id, start, view })}
            style={({ pressed }) => [styles.line, pressed && { backgroundColor: color.kaolin }]}
          >
            <View style={styles.lineRow}>
              <View style={styles.name}>
                <Txt v="strong" numberOfLines={1}>{row.employee.lastName}, {row.employee.firstName.charAt(0)}.</Txt>
              </View>
              <Txt v="body" c={color.inkSoft} style={styles.num}>{fmtHrs(row.reg)}</Txt>
              <Txt v="body" c={row.ot > 0 ? color.amber : color.silicaLight} style={styles.num}>{fmtHrs(row.ot)}</Txt>
              <Txt v="body" c={row.dt > 0 ? color.red : color.silicaLight} style={styles.num}>{fmtHrs(row.dt)}</Txt>
              <Txt v="numSm" style={styles.paid}>{fmtHrs(row.total)}</Txt>
            </View>
            {row.mealFlags > 0 || row.needsFix > 0 || row.leave.length > 0 ? (
              <View style={styles.flags}>
                {LEAVE_TYPES.filter((type) => row[type] > 0).map((type) => (
                  <Tag key={type} label={`${fmtHrs(row[type])} ${LEAVE_LABEL[type]}`} tone="info" />
                ))}
                {row.needsFix > 0 ? <Tag label="No clock-out" tone="bo" solid /> : null}
                {row.mealFlags > 0 ? <Tag label={`${row.mealFlags} lunch ${row.mealFlags === 1 ? 'flag' : 'flags'}`} tone="warn" /> : null}
              </View>
            ) : null}
          </Pressable>
        ))}
        {/* The crew total can run to five digits, so it gets the row to itself. */}
        <View style={[styles.line, styles.foot]}>
          <View style={styles.lineRow}>
            <Txt v="strong" style={{ flex: 1 }}>Total, {rows.length} {rows.length === 1 ? 'person' : 'people'}</Txt>
            <Txt v="numSm">{fmtHrs(totals.total)}</Txt>
          </View>
        </View>
      </View>

      <Txt v="small" c={color.silica}>
        ST is straight time, OT is time-and-a-half, DT is double time. Overtime follows California rules: over 8 hours a day or 40 straight-time hours in a workweek is OT, over 12 a day is DT, with the seventh-day rule. It is figured by the workweek, then added up for the days in the pay period. Lunch flags are for review and are never paid or docked automatically.
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
