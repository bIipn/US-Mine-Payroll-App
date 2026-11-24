import { Wrench } from '../../components/icons';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Divider, EmptyState, Page, Panel, Row, Segmented, Tag, UnitPlate } from '../../components/ui';
import type { MrfStatus } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { employeeName, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { fmtDateTime } from '../../util/format';
import { MRF_PRIORITY } from '../equipment/MrfDetailScreen';

const EMPTY: Record<MrfStatus, string> = {
  open: 'No request is waiting to be picked up.',
  in_progress: 'Nothing is being worked on right now.',
  completed: 'Completed requests show up here.',
};

export function MrfQueueScreen({ navigation }: ScreenProps<'MrfQueue'>) {
  const mrfs = useStore((s) => s.mrfs);
  const equipment = useStore((s) => s.equipment);
  const employees = useStore((s) => s.employees);
  const [status, setStatus] = useState<MrfStatus>('open');

  const count = (s: MrfStatus) => mrfs.filter((m) => m.status === s).length;
  const rank = { safety: 0, high: 1, routine: 2 } as const;
  const list = mrfs
    .filter((m) => m.status === status)
    .sort((a, b) => (status === 'completed' ? b.createdAt - a.createdAt : rank[a.priority] - rank[b.priority] || a.createdAt - b.createdAt));

  return (
    <Page testID="mrf-queue" title="Maintenance requests" sub="Safety requests first, then oldest" onBack={navigation.goBack}>
      <Segmented<MrfStatus>
        testID="mrf-filter"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'open', label: `Open (${count('open')})` },
          { value: 'in_progress', label: `In progress (${count('in_progress')})` },
          { value: 'completed', label: `Done (${count('completed')})` },
        ]}
      />
      {list.length === 0 ? (
        <EmptyState icon={Wrench} title="Nothing here" body={EMPTY[status]} />
      ) : (
        <Panel flush>
          {list.map((m, n) => {
            const unit = equipment.find((e) => e.id === m.equipmentId);
            const priority = MRF_PRIORITY[m.priority];
            const tagged = m.taggedOut && m.status !== 'completed';
            return (
              <View key={m.id}>
                {n > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  testID={`mrf-${m.number}`}
                  left={unit ? <UnitPlate unit={unit.unit} /> : <View style={styles.place}><Wrench color={color.ink} size={22} /></View>}
                  title={`#${m.number} ${m.description}`}
                  sub={`${unit ? '' : `${m.location ?? 'Plant'}. `}${employeeName(employees, m.requestedBy)}, ${fmtDateTime(m.createdAt)}`}
                  below={
                    <>
                      <Tag label={tagged ? 'Red tagged' : `${priority.label} priority`} tone={priority.tone} solid={tagged} />
                      {m.assignedTo && m.status !== 'completed' ? <Tag label={`Assigned to ${employeeName(employees, m.assignedTo)}`} tone="neutral" /> : null}
                    </>
                  }
                  chevron
                  onPress={() => navigation.navigate('MrfDetail', { mrfId: m.id })}
                />
              </View>
            );
          })}
        </Panel>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  place: {
    width: 80,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: color.grayTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
