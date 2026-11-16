import React from 'react';

import { PeriodSheet } from '../../components/PeriodSheet';
import { Page, Segmented } from '../../components/ui';
import { useSpans } from '../../components/useSpans';
import { WeekSheet } from '../../components/WeekSheet';
import { spanOf, SPAN_NAME, type SpanKind } from '../../domain/spans';
import type { ScreenProps } from '../../navigation/types';
import { useStore } from '../../store/useStore';
import { fullName } from '../../util/format';
import { useNow } from '../../util/hooks';

/**
 * One employee's hours for payroll. A supervisor can add holiday, PTO and sick
 * hours here, and tap any day to see or correct its punches.
 */
export function PayrollEmployeeScreen({ navigation, route }: ScreenProps<'PayrollEmployee'>) {
  const now = useNow(60_000);
  const employee = useStore((s) => s.employees.find((e) => e.id === route.params.employeeId));
  // Opens on the same run of days the payroll list was showing.
  const { views, view, setView, span, setSpan, options } = useSpans(route.params.start, route.params.view);
  if (!employee) return null;
  return (
    <Page testID="payroll-employee" title={fullName(employee)} sub={employee.title} onBack={navigation.goBack}>
      <Segmented<SpanKind>
        testID="employee-view"
        value={view}
        onChange={setView}
        options={views.map((kind) => ({ value: kind, label: SPAN_NAME[kind] }))}
      />
      {view === 'week' ? (
        <WeekSheet employeeId={employee.id} weekStart={span.start} onWeek={(start) => setSpan(spanOf('week', start, options))} now={now} />
      ) : (
        <PeriodSheet employeeId={employee.id} span={span} onSpan={setSpan} now={now} canAddLeave />
      )}
    </Page>
  );
}
