import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isCurrentSpan, spanLabel, stepSpan, SPAN_NAME, type Span } from '../domain/spans';
import { computeRange } from '../domain/payroll';
import { useStore } from '../store/useStore';
import { color, radius, space } from '../theme/theme';
import { fmtDate, fmtHrs, fullName } from '../util/format';
import { DayTable, LEAVE_LABEL, LEAVE_TYPES } from './DayTable';
import { DecimalChart } from './DecimalChart';
import { CalendarPlus, ChevronLeft, ChevronRight } from './icons';
import { LeaveSheet } from './LeaveSheet';
import { PayEstimate } from './PayEstimate';
import { Button, IconButton, Stat, Tag, Txt } from './ui';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Sunday to Saturday", for a workweek that starts on Sunday. */
export function workweekLine(startsOn: number): string {
  return `${DAY_NAMES[startsOn]} to ${DAY_NAMES[(startsOn + 6) % 7]}`;
}

/** "Paid Fri, Dec 4. The 5th is a Saturday." for a pay period; for a month, whether it is still going. */
export function paydayLine(span: Span, now: number, current = false): string {
  if (span.payDate == null) return current ? 'This month so far' : 'The whole month';
  const verb = span.payDate < now ? 'Paid' : 'Payday';
  return `${verb} ${fmtDate(span.payDate)}${span.movedBecause ? `. ${span.movedBecause}.` : ''}`;
}

/**
 * One person's hours for a pay period or a month, the way the pay stub lists
 * them: straight time, overtime, double time and paid leave, then a line for
 * every day.
 */
export function PeriodSheet({ employeeId, span, onSpan, now, own, canAddLeave }: {
  employeeId: string;
  /** A pay period or a calendar month. */
  span: Span;
  onSpan: (span: Span) => void;
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
  const pay = useStore((s) => s.settings.company.pay);
  const options = { pay, weekStartsOn: startsOn };
  const [chart, setChart] = useState(false);
  const [addingLeave, setAddingLeave] = useState(false);

  const range = useMemo(
    () =>
      computeRange(
        shifts.filter((s) => s.employeeId === employeeId),
        leave.filter((l) => l.employeeId === employeeId),
        span.start,
        span.end,
        now,
        { weekStartsOn: startsOn },
      ),
    [shifts, leave, employeeId, span.start, span.end, now, startsOn],
  );

  const isCurrent = isCurrentSpan(span, now, options);
  const isMonth = span.kind === 'month';
  const which = isMonth ? 'month' : 'pay period';
  const leaveTypes = LEAVE_TYPES.filter((type) => range[type] > 0);

  return (
    <View style={{ gap: space.lg }}>
      <View style={styles.nav}>
        <IconButton testID="period-prev" icon={ChevronLeft} label={`Earlier ${which}`} bg={color.paper} onPress={() => onSpan(stepSpan(span, -1, options))} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Txt v="h3" testID="period-label">{spanLabel(span)}</Txt>
          <Txt v="small" c={color.silica} center testID="period-payday">{paydayLine(span, now, isCurrent)}</Txt>
        </View>
        <View style={{ opacity: isCurrent ? 0.3 : 1 }}>
          <IconButton testID="period-next" icon={ChevronRight} label={`Later ${which}`} bg={color.paper} onPress={() => !isCurrent && onSpan(stepSpan(span, 1, options))} />
        </View>
      </View>

      <View style={styles.totals}>
        <View>
          <Txt v="h1" testID="period-total">{fmtHrs(range.total)}</Txt>
          <Txt v="body" c={color.silica}>{isCurrent ? `hours so far this ${which}` : `hours this ${which}`}</Txt>
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

      <DayTable days={range.days} leave={range.leave} footLabel={SPAN_NAME[span.kind]} lunch={range.lunch} worked={range.paid} now={now} />

      <Txt v="small" c={color.silica}>
        Overtime is figured by the day and by the workweek, {workweekLine(startsOn)}, then added up for the days in the {which}. Hours are before taxes.
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
