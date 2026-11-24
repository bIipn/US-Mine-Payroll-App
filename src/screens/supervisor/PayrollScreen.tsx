import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { LEAVE_LABEL, LEAVE_TYPES } from '../../components/DayTable';
import { ChevronLeft, ChevronRight, FileSpreadsheet, FileText } from '../../components/icons';
import { paydayLine, workweekLine } from '../../components/PeriodSheet';
import { Button, IconButton, Page, Segmented, Sheet, Stat, Tag, Txt } from '../../components/ui';
import { useSpans } from '../../components/useSpans';
import { computePayroll, sumPayroll } from '../../domain/payroll';
import { overtimeSummary } from '../../domain/time';
import { isCurrentSpan, spanLabel, stepSpan, SPAN_NAME, type SpanKind } from '../../domain/spans';
import type { ScreenProps } from '../../navigation/types';
import { exportCsv, exportReport } from '../../services/exportReport';
import { payrollHoursFile, payrollReport } from '../../services/reports';
import { useRules, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { fmtHrs, listName, peopleCount } from '../../util/format';
import { useNow } from '../../util/hooks';

/**
 * Hours for payroll, by employee, in the same lines as the pay stub: straight
 * time, overtime, double time, and paid leave. By the company's pay period when
 * it has set one, by workweek, or by month.
 */
export function PayrollScreen({ navigation }: ScreenProps<'Payroll'>) {
  const now = useNow(60_000);
  const employees = useStore((s) => s.employees);
  const shifts = useStore((s) => s.shifts);
  const leave = useStore((s) => s.leave);
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const rules = useRules();
  const { views, view, setView, span, setSpan, options } = useSpans(now);
  const { start, end } = span;
  const isCurrent = isCurrentSpan(span, now, options);
  const which = view === 'period' ? 'pay period' : view === 'week' ? 'workweek' : 'month';

  const rows = useMemo(() => {
    const people = employees
      .filter((e) => e.active)
      .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
    return computePayroll(people, shifts, leave, start, end, now, { weekStartsOn: startsOn, rules });
  }, [employees, shifts, leave, start, end, now, startsOn, rules]);
  const totals = useMemo(() => sumPayroll(rows), [rows]);
  const [fileOpen, setFileOpen] = useState(false);
  const missingIds = rows.filter((r) => r.total > 0 && !r.employee.payrollId).length;
  // On a phone joined to a company, payroll IDs are set on the dashboard and come with the roster.
  const fromTheOffice = useStore((s) => !!s.connectedCompany);
  const caughtUp = useStore((s) => s.receiving?.caughtUpAt != null && s.receiving.cursor > 0);
  const hoursFile = (layout: 'day' | 'period') => {
    setFileOpen(false);
    void exportCsv(() => payrollHoursFile({ ...useStore.getState() }, { start, end }, layout, Date.now()));
  };
  const paidLeave = totals.total - totals.paid;

  const step = (direction: 1 | -1) => {
    if (direction === 1 && isCurrent) return;
    setSpan(stepSpan(span, direction, options));
  };

  return (
    <Page
      testID="payroll-screen"
      title="Payroll"
      sub="Hours as decimals, lunch already taken off"
      onBack={navigation.goBack}
      footer={
        <>
          <Button testID="export-hours-file" label="Payroll hours file" icon={FileText} kind="outline" onPress={() => setFileOpen(true)} />
          <Button
            testID="export-payroll"
            label="Export to Excel"
            icon={FileSpreadsheet}
            kind="yellow"
            onPress={() =>
              exportReport(() =>
                payrollReport({ ...useStore.getState() }, { start, end, payDate: span.payDate }, Date.now()),
              )
            }
          />
        </>
      }
    >
      <Segmented<SpanKind>
        testID="payroll-view"
        value={view}
        onChange={setView}
        options={views.map((kind) => ({ value: kind, label: SPAN_NAME[kind] }))}
      />
      <View style={styles.nav}>
        <IconButton testID="period-prev" icon={ChevronLeft} label="Earlier" bg={color.paper} onPress={() => step(-1)} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Txt v="h3" testID="period-label">{spanLabel(span)}</Txt>
          <Txt v="small" c={color.silica} center testID="period-payday">
            {view === 'week' ? (isCurrent ? 'This workweek so far' : workweekLine(startsOn)) : paydayLine(span, now, isCurrent)}
          </Txt>
        </View>
        <View style={{ opacity: isCurrent ? 0.3 : 1 }}>
          <IconButton testID="period-next" icon={ChevronRight} label="Later" bg={color.paper} onPress={() => step(1)} />
        </View>
      </View>

      <View style={styles.totals}>
        <View>
          <Txt v="h1" testID="payroll-total">{fmtHrs(totals.total)}</Txt>
          <Txt v="body" c={color.silica}>hours to pay, {peopleCount(rows.filter((r) => r.total > 0).length)}</Txt>
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
                <Txt v="strong" numberOfLines={1}>{listName(row.employee)}</Txt>
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
        ST is straight time, OT is time-and-a-half, DT is double time. {overtimeSummary(rules)} It is figured by the workweek, then added up for the days in the {which}. Hours are before taxes. Lunch flags are for review and are never paid or docked automatically.
      </Txt>
      <Sheet testID="hours-file-sheet" visible={fileOpen} onClose={() => setFileOpen(false)} title="Payroll hours file">
        <Txt v="body" c={color.inkSoft}>
          A CSV of the hours in this {which} for your payroll system's import: each person's payroll ID, an earning code and the hours, before taxes.{' '}
          {fromTheOffice
            ? 'Set the codes and each person’s payroll ID on the dashboard; they come to this phone with the roster.'
            : 'Set the codes on More, Company, and each person’s payroll ID on the roster.'}
        </Txt>
        {missingIds ? (
          <Txt v="strong" c={color.red} testID="hours-file-missing-ids">
            {fromTheOffice && !caughtUp
              ? 'Payroll IDs come to this phone with the roster. They are here the next time it has signal.'
              : `${peopleCount(missingIds)} with hours ${missingIds === 1 ? 'has' : 'have'} no payroll ID yet. Their lines go out with that column blank.`}
          </Txt>
        ) : null}
        <Button testID="hours-file-period" label="Totals for the period" kind="ink" onPress={() => hoursFile('period')} />
        <Button testID="hours-file-day" label="One line a day" kind="outline" onPress={() => hoursFile('day')} />
      </Sheet>
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
