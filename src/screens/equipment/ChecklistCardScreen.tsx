import { ClipboardList, Plus } from '../../components/icons';
import React, { useMemo } from 'react';
import { View } from 'react-native';

import { ChecklistCard } from '../../components/ChecklistCard';
import { Button, EmptyState, Page, Txt } from '../../components/ui';
import { dailyCards, dayHoursWorked } from '../../domain/checklistCard';
import type { ScreenProps } from '../../navigation/types';
import { employeeName, openShiftOf, useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDate, fmtRelativeDay, startOfDay } from '../../util/format';
import { useNow } from '../../util/hooks';

/**
 * A person's Operator Equipment Checklist for one day, as the paper card.
 * With nothing passed in it is your own card for today.
 */
export function ChecklistCardScreen({ navigation, route }: ScreenProps<'ChecklistCard'>) {
  const now = useNow(30_000);
  const me = useMe();
  const employees = useStore((s) => s.employees);
  const inspections = useStore((s) => s.inspections);
  const opLogs = useStore((s) => s.opLogs);
  const equipment = useStore((s) => s.equipment);
  const shifts = useStore((s) => s.shifts);

  const employeeId = route.params?.employeeId ?? me?.id ?? '';
  const day = startOfDay(route.params?.day ?? now);
  const mine = employeeId === me?.id;
  const today = day === startOfDay(now);

  const cards = useMemo(
    () => dailyCards({ inspections, opLogs, equipment }, employeeId, day),
    [inspections, opLogs, equipment, employeeId, day],
  );
  const hours = dayHoursWorked(shifts, employeeId, day, now);
  const stillWorking = today && !!openShiftOf(shifts, employeeId, now);
  const name = employeeName(employees, employeeId);
  const addUnit = () => navigation.navigate('Main', { screen: 'Equipment', params: { tab: 'equipment' } });

  return (
    <Page
      testID="card-screen"
      title={mine ? 'My equipment card' : 'Equipment card'}
      sub={mine ? fmtRelativeDay(day, now) : `${name}, ${fmtDate(day)}`}
      onBack={navigation.goBack}
      footer={mine && today ? <Button testID="card-add" label="Check another unit" icon={Plus} kind="yellow" onPress={addUnit} /> : undefined}
    >
      {cards.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={mine && today ? 'No equipment on your card yet' : 'No equipment checked that day'}
          body={mine && today ? 'Pick a unit and fill in its checklist. It gets a column on your card.' : 'A unit shows up here once its checklist is signed.'}
        />
      ) : (
        cards.map((card, i) => (
          <View key={i} style={{ gap: space.sm }}>
            {cards.length > 1 ? <Txt v="smallStrong" c={color.silica}>Card {i + 1} of {cards.length}</Txt> : null}
            <ChecklistCard
              card={card}
              name={name}
              hoursWorked={hours}
              stillWorking={stillWorking}
              onOpen={(inspectionId) => navigation.navigate('InspectionDetail', { inspectionId })}
            />
          </View>
        ))
      )}
      {cards.length > 0 ? (
        <Txt v="small" c={color.silica}>
          The total daily hours come from the time clock. Tap a unit to see what was written on its lines.
        </Txt>
      ) : null}
    </Page>
  );
}
