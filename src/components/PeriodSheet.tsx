import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { nextPayPeriod, payPeriodOf, previousPayPeriod, type PayPeriod } from '../domain/payPeriod';
import { computeRange } from '../domain/payroll';
import { useStore } from '../store/useStore';
import { color, radius, space } from '../theme/theme';
import { fmtDate, fmtHrs, fmtRange, fullName } from '../util/format';
import { DayTable, LEAVE_LABEL, LEAVE_TYPES } from './DayTable';
import { DecimalChart } from './DecimalChart';
import { CalendarPlus, ChevronLeft, ChevronRight } from './icons';
import { LeaveSheet } from './LeaveSheet';
import { PayEstimate } from './PayEstimate';
import { Button, IconButton, Stat, Tag, Txt } from './ui';

/** "Paid Fri, Dec 4. The 5th is a Saturday." */
export function paydayLine(period: PayPeriod, now: number): string {
  const verb = period.payDate < now ? 'Paid' : 'Payday';
  return `${verb} ${fmtDate(period.payDate)}${period.movedBecause ? `. ${period.movedBecause}.` : ''}`;
}

/**
 * One person's pay period as it will appear on the pay stub: straight time,
 * overtime, double time and paid leave, then a line for every day.
 */
export function PeriodSheet({ employeeId, period, onPeriod, now, own, canAddLeave }: {
  employeeId: string;
  period: PayPeriod;
  onPeriod: (period: PayPeriod) => void;
  now: number;
  /** The signed-in person is looking at their own hours. */
  own?: boolean;
  /** Supervisors can record holiday, PTO and sick hours. */
  canAddLeave?: boolean;
}) {
  const shifts = useStore((s) => s.shifts);
  const leave = useStore((s) => s.leave);
  const employee = useStore((s) => s.employees.find((e) => e.id === employeeId));
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const [chart, setChart] = useState(false);
  const [addingLeave, setAddingLeave] = useState(false);

  const range = useMemo(
    () =>
      computeRange(
        shifts.filter((s) => s.employeeId === employeeId),
        leave.filter((l) => l.employeeId === employeeId),
        period.start,
        period.end,
        now,
        { weekStartsOn: startsOn },
      ),
    [shifts, leave, employeeId, period.start, period.end, now, startsOn],
  );

  const isCurrent = period.start >= payPeriodOf(now).start;
  const leaveTypes = LEAVE_TYPES.filter((type) => range[type] > 0);

  return (
    <View style={{ gap: space.lg }}>
      <View style={styles.nav}>
        <IconButton testID="period-prev" icon={ChevronLeft} label="Earlier pay period" bg={color.paper} onPress={() => onPeriod(previousPayPeriod(period))} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Txt v="h3" testID="period-label">{fmtRange(period.start, period.lastDay)}</Txt>
          <Txt v="small" c={color.silica} center testID="period-payday">{paydayLine(period, now)}</Txt>
        </View>
        <View style={{ opacity: isCurrent ? 0.3 : 1 }}>
          <IconButton testID="period-next" icon={ChevronRight} label="Later pay period" bg={color.paper} onPress={() => !isCurrent && onPeriod(nextPayPeriod(period))} />
        </View>
      </View>

      <View style={styles.totals}>
        <View>
          <Txt v="h1" testID="period-total">{fmtHrs(range.total)}</Txt>
          <Txt v="body" c={color.silica}>{isCurrent ? 'hours so far this pay period' : 'hours this pay period'}</Txt>
        </View>
        <View style={styles.split}>
          <Stat value={fmtHrs(range.reg)} label="Straight time" />
          <Stat value={fmtHrs(range.ot)} label="Overtime" tone={range.ot > 0 ? 'warn' : undefined} />
          <Stat value={fmtHrs(range.dt)} label="Double time" tone={range.dt > 0 ? 'bo' : undefined} />
        </View>
        {leaveTypes.length > 0 ? (
          <View style={styles.leave} testID="period-leave">
            <Txt v="small" c={color.silica}>Includes paid leave</Txt>
            {leaveTypes.map((type) => (
              <Tag key={type} label={`${fmtHrs(range[type])} ${LEAVE_LABEL[type]}`} tone="info" />
            ))}
          </View>
        ) : null}
        <Txt v="small" c={color.silica}>
          {fmtHrs(range.gross)} on site, less {fmtHrs(range.lunch)} unpaid lunch.
          {range.needsFix > 0 ? ` ${range.needsFix} shift not counted yet: it has no clock-out.` : ''}
        </Txt>
      </View>

      {own ? <PayEstimate hours={range} /> : null}

      {canAddLeave ? (
        <Button testID="leave-add" label="Add holiday, PTO or sick hours" icon={CalendarPlus} kind="outline" size="md" onPress={() => setAddingLeave(true)} />
      ) : null}

      <DayTable days={range.days} leave={range.leave} footLabel="Pay period" lunch={range.lunch} worked={range.paid} now={now} />

      <Txt v="small" c={color.silica}>
        Overtime is figured by the day and by the workweek, Sunday to Saturday, then added up for the days in the pay period.
      </Txt>
      <Button label="How minutes become decimals" kind="quiet" size="md" onPress={() => setChart(true)} testID="open-chart" />

      <DecimalChart visible={chart} onClose={() => setChart(false)} />
      {canAddLeave && employee ? (
        <LeaveSheet
          visible={addingLeave}
          onClose={() => setAddingLeave(false)}
          employeeId={employeeId}
          employeeName={fullName(employee)}
          days={range.days}
          leave={range.leave}
          now={now}
        />
      ) : null}
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
  leave: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
});
