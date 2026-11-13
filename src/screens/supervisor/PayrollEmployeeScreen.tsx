import React, { useState } from 'react';

import { PeriodSheet } from '../../components/PeriodSheet';
import { Page, Segmented } from '../../components/ui';
import { WeekSheet } from '../../components/WeekSheet';
import { payPeriodOf } from '../../domain/payPeriod';
import type { ScreenProps } from '../../navigation/types';
import { useStore } from '../../store/useStore';
import { fullName, startOfWeek } from '../../util/format';
import { useNow } from '../../util/hooks';

type View_ = 'period' | 'week';

/**
 * One employee's hours for payroll. A supervisor can add holiday, PTO and sick
 * hours here, and tap any day to see or correct its punches.
 */
export function PayrollEmployeeScreen({ navigation, route }: ScreenProps<'PayrollEmployee'>) {
  const now = useNow(60_000);
  const employee = useStore((s) => s.employees.find((e) => e.id === route.params.employeeId));
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const [view, setView] = useState<View_>(route.params.view);
  const [period, setPeriod] = useState(() => payPeriodOf(route.params.start));
  const [weekStart, setWeekStart] = useState(() => startOfWeek(route.params.start, startsOn));
  if (!employee) return null;
  return (
    <Page testID="payroll-employee" title={fullName(employee)} sub={employee.title} onBack={navigation.goBack}>
      <Segmented<View_>
        testID="employee-view"
        value={view}
        onChange={setView}
        options={[
          { value: 'period', label: 'Pay period' },
          { value: 'week', label: 'Workweek' },
        ]}
      />
      {view === 'period' ? (
        <PeriodSheet employeeId={employee.id} period={period} onPeriod={setPeriod} now={now} canAddLeave />
      ) : (
        <WeekSheet employeeId={employee.id} weekStart={weekStart} onWeek={setWeekStart} now={now} />
      )}
    </Page>
  );
}
