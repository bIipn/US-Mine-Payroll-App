import React, { useState } from 'react';

import { Page } from '../../components/ui';
import { WeekSheet } from '../../components/WeekSheet';
import type { ScreenProps } from '../../navigation/types';
import { useStore } from '../../store/useStore';
import { fullName } from '../../util/format';
import { useNow } from '../../util/hooks';

/** One employee's timesheet, week by week. Tap a day to see or correct the punches. */
export function PayrollEmployeeScreen({ navigation, route }: ScreenProps<'PayrollEmployee'>) {
  const now = useNow(60_000);
  const employee = useStore((s) => s.employees.find((e) => e.id === route.params.employeeId));
  const [weekStart, setWeekStart] = useState(route.params.weekStart);
  if (!employee) return null;
  return (
    <Page testID="payroll-employee" title={fullName(employee)} sub={employee.title} onBack={navigation.goBack}>
      <WeekSheet employeeId={employee.id} weekStart={weekStart} onWeek={setWeekStart} now={now} />
    </Page>
  );
}
