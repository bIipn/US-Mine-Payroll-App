import { Users } from '../../components/icons';
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Avatar, Divider, EmptyState, Page, Panel, Row, Segmented, Tag } from '../../components/ui';
import type { ScreenProps } from '../../navigation/types';
import { openLogs, useStore } from '../../store/useStore';
import { space } from '../../theme/theme';
import { fmtHrs, fmtTime, fullName, initials } from '../../util/format';
import { useNow } from '../../util/hooks';
import { crewNow } from './crewStatus';

type Filter = 'here' | 'lunch' | 'off';

export function OnSiteScreen({ navigation }: ScreenProps<'OnSite'>) {
  const now = useNow(15_000);
  const employees = useStore((s) => s.employees);
  const shifts = useStore((s) => s.shifts);
  const equipment = useStore((s) => s.equipment);
  const opLogs = useStore((s) => s.opLogs);
  const [filter, setFilter] = useState<Filter>('here');

  const crew = useMemo(() => crewNow(employees, shifts, now), [employees, shifts, now]);
  const inUse = useMemo(() => openLogs(opLogs), [opLogs]);
  const unitFor = (employeeId: string) => {
    const log = [...inUse.values()].find((l) => l.employeeId === employeeId);
    return log ? equipment.find((e) => e.id === log.equipmentId)?.unit : undefined;
  };
  const count = (f: Filter) => crew.filter((c) => (f === 'here' ? c.presence === 'working' : c.presence === f)).length;
  const list = crew.filter((c) => (filter === 'here' ? c.presence === 'working' : c.presence === filter));

  return (
    <Page testID="onsite-screen" title="Who is on site" sub={`As of ${fmtTime(now)}`} onBack={navigation.goBack}>
      <Segmented<Filter>
        testID="onsite-filter"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'here', label: `Working (${count('here')})` },
          { value: 'lunch', label: `Lunch (${count('lunch')})` },
          { value: 'off', label: `Off (${count('off')})` },
        ]}
      />
      {list.length === 0 ? (
        <EmptyState icon={Users} title="Nobody here" body={filter === 'off' ? 'Everyone on the roster is clocked in.' : 'Nobody is in this group right now.'} />
      ) : (
        <Panel flush>
          {list.map((line, i) => {
            const unit = unitFor(line.employee.id);
            return (
              <View key={line.employee.id}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  left={<Avatar initials={initials(line.employee.firstName, line.employee.lastName)} tone={line.presence === 'off' ? 'neutral' : 'ink'} />}
                  title={fullName(line.employee)}
                  sub={
                    line.shift
                      ? `In ${fmtTime(line.shift.clockIn.at)}, ${fmtHrs(line.paid)} paid so far${unit ? `, running ${unit}` : ''}`
                      : line.employee.title
                  }
                  below={line.presence === 'off' ? undefined : <Tag label={line.label} tone={line.tone} solid={line.solid} />}
                  chevron={!!line.shift}
                  onPress={line.shift ? () => navigation.navigate('ShiftDetail', { shiftId: line.shift!.id }) : undefined}
                />
              </View>
            );
          })}
        </Panel>
      )}
    </Page>
  );
}
