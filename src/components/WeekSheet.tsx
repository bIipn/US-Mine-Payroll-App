import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { computeRange } from '../domain/payroll';
import { useStore } from '../store/useStore';
import { color, radius, space } from '../theme/theme';
import { addDays, fmtHrs, fmtRange, startOfWeek } from '../util/format';
import { DayTable, LEAVE_LABEL, LEAVE_TYPES } from './DayTable';
import { DecimalChart } from './DecimalChart';
import { ChevronLeft, ChevronRight } from './icons';
import { Button, IconButton, Stat, Tag, Txt } from './ui';

export { flagTone } from './DayTable';

/**
 * One person's workweek as a timesheet. Overtime is figured by the workweek,
 * so this is the view that shows where each overtime hour came from.
 */
export function WeekSheet({ employeeId, weekStart, onWeek, now }: {
  employeeId: string;
  weekStart: number;
  onWeek: (weekStart: number) => void;
  now: number;
}) {
  const shifts = useStore((s) => s.shifts);
  const leave = useStore((s) => s.leave);
  const startsOn = useStore((s) => s.settings.workweekStartsOn);
  const [chart, setChart] = useState(false);

  const week = useMemo(
    () =>
      computeRange(
        shifts.filter((s) => s.employeeId === employeeId),
        leave.filter((l) => l.employeeId === employeeId),
        weekStart,
        addDays(weekStart, 7),
        now,
        { weekStartsOn: startsOn },
      ),
    [shifts, leave, employeeId, weekStart, now, startsOn],
  );
  const thisWeek = startOfWeek(now, startsOn);
  const isCurrent = weekStart >= thisWeek;
  const leaveTypes = LEAVE_TYPES.filter((type) => week[type] > 0);

  return (
    <View style={{ gap: space.lg }}>
      <View style={styles.nav}>
        <IconButton icon={ChevronLeft} label="Previous week" bg={color.paper} onPress={() => onWeek(addDays(weekStart, -7))} testID="week-prev" />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Txt v="h3" testID="week-label">{fmtRange(weekStart, addDays(weekStart, 6))}</Txt>
          <Txt v="small" c={color.silica}>{isCurrent ? 'This workweek' : weekStart === addDays(thisWeek, -7) ? 'Last workweek' : 'Workweek'}</Txt>
        </View>
        <View style={{ opacity: isCurrent ? 0.3 : 1 }}>
          <IconButton icon={ChevronRight} label="Next week" bg={color.paper} onPress={() => !isCurrent && onWeek(addDays(weekStart, 7))} testID="week-next" />
        </View>
      </View>

      <View style={styles.totals}>
        <View>
          <Txt v="h1" testID="week-paid">{fmtHrs(week.paid)}</Txt>
          <Txt v="body" c={color.silica}>{isCurrent ? 'hours worked so far this workweek' : 'hours worked that workweek'}</Txt>
        </View>
        <View style={styles.split}>
          <Stat value={fmtHrs(week.reg)} label="Straight time" />
          <Stat value={fmtHrs(week.ot)} label="Overtime" tone={week.ot > 0 ? 'warn' : undefined} />
          <Stat value={fmtHrs(week.dt)} label="Double time" tone={week.dt > 0 ? 'bo' : undefined} />
        </View>
        {leaveTypes.length > 0 ? (
          <View style={styles.leave} testID="week-leave">
            <Txt v="small" c={color.silica}>Plus paid leave</Txt>
            {leaveTypes.map((type) => (
              <Tag key={type} label={`${fmtHrs(week[type])} ${LEAVE_LABEL[type]}`} tone="info" />
            ))}
          </View>
        ) : null}
        <Txt v="small" c={color.silica}>
          {fmtHrs(week.gross)} on site, less {fmtHrs(week.lunch)} unpaid lunch.
          {week.needsFix > 0 ? ` ${week.needsFix} shift not counted yet: it has no clock-out.` : ''}
        </Txt>
      </View>

      <DayTable days={week.days} leave={week.leave} footLabel="Week" lunch={week.lunch} worked={week.paid} now={now} />

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
  leave: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
});
